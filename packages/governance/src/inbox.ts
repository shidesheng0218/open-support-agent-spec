import type { Clock, IdFactory } from "./deps.js";
import { GOVERNANCE_SPEC_VERSION } from "./types.js";
import type {
  IntegrationEvent,
  IntegrationEventIntakeResult,
  JobRetryClass,
  JobRun,
  Reconciliation,
} from "./types.js";
import type { GovernanceStores } from "./ports.js";
import {
  GovernanceConflictError,
  GovernanceNotFoundError,
  GovernanceValidationError,
} from "./errors.js";
import { requireCapability } from "./roles.js";
import { assertTenantAccess, type GovernanceActor } from "./actor.js";

/**
 * Integration event inbox (M1).
 *
 * The contract this service enforces, in order:
 *
 * 1. **Signed or nothing.** A delivery whose signature did not verify is
 *    rejected before it can touch the inbox. Rejections never occupy a dedupe
 *    key, so an attacker cannot suppress a genuine later delivery by replaying
 *    a forged one.
 * 2. **Deduplicate on the provider's identity**, not on ours:
 *    (tenantId, connectionId, topic, externalEventId). A replay returns the
 *    original record with outcome "duplicate" and enqueues no work.
 * 3. **Never let an old event overwrite new state.** If the provider timestamp
 *    is behind the connection's accepted watermark, the event is recorded as
 *    "stale_ignored" and the runtime opens a reconciliation plus a *read-only*
 *    refetch job — it does not apply the stale payload.
 * 4. **Ingesting is not acting.** Every accepted event becomes a job. Nothing
 *    is executed inside the request that received it.
 */

export class IntegrationSignatureError extends Error {
  override name = "IntegrationSignatureError";
  constructor(
    public readonly topic: string,
    message = "event signature did not verify; delivery rejected",
  ) {
    super(`${message} (topic: ${topic})`);
  }
}

export interface AcceptEventInput {
  connectionId: string;
  topic: string;
  externalEventId: string;
  /** Provider-side timestamp. Ordering uses this, never the receipt time. */
  occurredAt: string;
  payload?: Record<string, unknown>;
  signatureVerified: boolean;
}

export interface IntegrationEventIntakeDeps {
  stores: GovernanceStores;
  clock: Clock;
  ids: IdFactory;
  /**
   * Retry classification per topic. Defaults to "side_effecting" because an
   * inbound provider event may trigger a write downstream, and OSAS never
   * blindly retries something that may already have changed state.
   */
  retryClassForTopic?: (topic: string) => JobRetryClass;
  maxAttemptsForTopic?: (topic: string) => number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export class IntegrationEventIntake {
  constructor(private readonly deps: IntegrationEventIntakeDeps) {}

  async accept(
    actor: GovernanceActor,
    tenantId: string,
    input: AcceptEventInput,
  ): Promise<IntegrationEventIntakeResult> {
    requireCapability([...actor.roles], "event:write", actor.actorId);
    assertTenantAccess(actor, tenantId);
    const topic = input.topic?.trim();
    const externalEventId = input.externalEventId?.trim();
    const connectionId = input.connectionId?.trim();
    if (!connectionId) throw new GovernanceValidationError("connectionId", "must not be empty");
    if (!topic) throw new GovernanceValidationError("topic", "must not be empty");
    if (!externalEventId) {
      throw new GovernanceValidationError("externalEventId", "must not be empty");
    }
    const occurredAtMs = Date.parse(input.occurredAt);
    if (Number.isNaN(occurredAtMs)) {
      throw new GovernanceValidationError("occurredAt", "must be an ISO-8601 timestamp");
    }
    // Rule 1: reject unverified deliveries before they can occupy a dedupe key.
    if (!input.signatureVerified) {
      throw new IntegrationSignatureError(topic);
    }

    const connection = await this.deps.stores.connections.get(tenantId, connectionId);
    if (!connection) throw new GovernanceNotFoundError("connection", connectionId);
    if (connection.status === "revoked") {
      throw new GovernanceConflictError(
        `connection "${connectionId}" is revoked; events are no longer accepted`,
        "connection",
        connectionId,
      );
    }
    if (connection.status !== "active") {
      throw new GovernanceConflictError(
        `connection "${connectionId}" is ${connection.status}; only an active connection accepts events`,
        "connection",
        connectionId,
      );
    }

    const now = this.deps.clock.now();
    const event: IntegrationEvent = {
      id: this.deps.ids.next("evt"),
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId,
      connectionId,
      provider: connection.provider,
      topic,
      externalEventId,
      occurredAt: new Date(occurredAtMs).toISOString(),
      receivedAt: now.toISOString(),
      status: "received",
      payload: { ...(input.payload ?? {}) },
      signatureVerified: true,
      attempts: 0,
    };

    const { inserted, event: stored } = await this.deps.stores.integrationEvents.insertIfAbsent(event);
    if (!inserted) {
      // Rule 2: replay. No job, no state change.
      return { outcome: "duplicate", event: stored };
    }

    const watermark = await this.deps.stores.integrationEvents.acceptedWatermark(tenantId, connectionId);
    if (watermark && event.occurredAt < watermark) {
      // Rule 3: out-of-order. Park the payload and ask for a refetch instead.
      const stale = await this.deps.stores.integrationEvents.markStatus(
        tenantId,
        stored.id,
        "stale_ignored",
      );
      const reconciliation = await this.deps.stores.reconciliations.createIfAbsent({
        id: this.deps.ids.next("recon"),
        specVersion: GOVERNANCE_SPEC_VERSION,
        tenantId,
        reason: "out_of_order_event",
        status: "open",
        dedupeKey: `event:${stored.id}`,
        connectionId,
        detail: {
          eventId: stored.id,
          topic,
          externalEventId,
          occurredAt: stored.occurredAt,
          acceptedWatermark: watermark,
          note: "event arrived behind the accepted watermark; provider state must be re-read before any decision",
        },
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      const job = await this.enqueueRefetch(tenantId, connectionId, stored, watermark, reconciliation.reconciliation.id);
      return {
        outcome: "out_of_order",
        event: stale,
        jobRunId: job.id,
        reconciliationId: reconciliation.reconciliation.id,
      };
    }

    const job = await this.enqueueProcess(tenantId, connection, stored);
    return { outcome: "accepted", event: stored, jobRunId: job.id };
  }

  /** Mark an event as being worked on (called by the processing handler). */
  async markProcessing(tenantId: string, eventId: string): Promise<void> {
    await this.deps.stores.integrationEvents.markStatus(tenantId, eventId, "processing");
  }

  async markProcessed(tenantId: string, eventId: string): Promise<void> {
    await this.deps.stores.integrationEvents.markStatus(tenantId, eventId, "processed");
  }

  async markFailed(
    tenantId: string,
    eventId: string,
    error: { code: string; message: string },
  ): Promise<void> {
    await this.deps.stores.integrationEvents.markStatus(tenantId, eventId, "failed", error);
  }

  private async enqueueProcess(
    tenantId: string,
    connection: { id: string; provider: string },
    event: IntegrationEvent,
  ): Promise<JobRun> {
    const now = this.deps.clock.now();
    const retryClass = this.deps.retryClassForTopic?.(event.topic) ?? "side_effecting";
    const maxAttempts = this.deps.maxAttemptsForTopic?.(event.topic) ?? DEFAULT_MAX_ATTEMPTS;
    return this.deps.stores.jobs.create({
      id: this.deps.ids.next("job"),
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId,
      kind: "integration_event.process",
      status: "queued",
      retryClass,
      attempts: 0,
      maxAttempts,
      runAt: now.toISOString(),
      input: {
        eventId: event.id,
        connectionId: connection.id,
        provider: connection.provider,
        topic: event.topic,
        occurredAt: event.occurredAt,
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  /** Refetch jobs only read provider state, so they are safe to retry. */
  private async enqueueRefetch(
    tenantId: string,
    connectionId: string,
    staleEvent: IntegrationEvent,
    watermark: string,
    reconciliationId: string,
  ): Promise<JobRun> {
    const now = this.deps.clock.now();
    return this.deps.stores.jobs.create({
      id: this.deps.ids.next("job"),
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId,
      kind: "reconciliation.refetch",
      status: "queued",
      retryClass: "safe_read",
      attempts: 0,
      maxAttempts: 5,
      runAt: now.toISOString(),
      input: {
        connectionId,
        staleEventId: staleEvent.id,
        topic: staleEvent.topic,
        occurredAt: staleEvent.occurredAt,
        acceptedWatermark: watermark,
      },
      reconciliationId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }
}

export type { Reconciliation };
