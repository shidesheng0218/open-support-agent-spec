import { GOVERNANCE_SPEC_VERSION } from "./types.js";
import type {
  Connection,
  GovernanceUsageKind,
  JobKind,
  JobRun,
  JobStatus,
  Organization,
  Workspace,
} from "./types.js";
import { inMemoryGovernanceStores } from "./memory.js";
import type { GovernanceStores } from "./ports.js";
import { randomIdFactory, systemClock, type Clock, type IdFactory } from "./deps.js";
import { ConnectionService, type ConnectionProbe } from "./connections.js";
import { IntegrationEventIntake } from "./inbox.js";
import { JobRunner, type JobHandler } from "./jobs.js";
import { GovernanceConflictError } from "./errors.js";
import { requireCapability } from "./roles.js";
import type { GovernanceActor } from "./actor.js";

/**
 * GovernanceRuntime — the M1 assembly of the control plane.
 *
 * It owns nothing that is business-specific: it wires stores, the connection
 * lifecycle, the event inbox, and the job runner together, and exposes the
 * operations a control plane needs (provision a workspace, read health, drain
 * the queue). Business behaviour enters exclusively through injected
 * {@link JobHandler}s.
 */

export interface GovernanceRuntimeOptions {
  stores?: GovernanceStores;
  clock?: Clock;
  ids?: IdFactory;
  probe?: ConnectionProbe;
  /** Worker identity written to job leases. */
  workerOwner?: string;
  leaseMs?: number;
  /** Job handlers. A kind with no handler is never claimed. */
  handlers?: Partial<Record<JobKind, JobHandler>>;
  retryClassForTopic?: (topic: string) => JobRun["retryClass"];
  maxAttemptsForTopic?: (topic: string) => number;
}

export interface ProvisionWorkspaceInput {
  organizationName: string;
  workspaceName: string;
  /** OSAS tenant scope. Defaults to a generated id. */
  tenantId?: string;
  organizationId?: string;
}

export interface GovernanceHealth {
  tenantId: string;
  workspace?: Workspace;
  organization?: Organization;
  connections: Record<Connection["status"], number>;
  integrationEvents: Record<string, number>;
  jobs: Record<JobStatus, number>;
  reconciliations: { open: number };
  usage: { total: number };
  /** Job kinds configured with a handler in this process. */
  registeredJobKinds: JobKind[];
}

export class GovernanceRuntime {
  readonly stores: GovernanceStores;
  readonly connections: ConnectionService;
  readonly intake: IntegrationEventIntake;
  readonly runner: JobRunner;

  private readonly clock: Clock;
  private readonly ids: IdFactory;

  constructor(private readonly options: GovernanceRuntimeOptions = {}) {
    this.stores = options.stores ?? inMemoryGovernanceStores();
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIdFactory;
    this.connections = new ConnectionService({
      store: this.stores.connections,
      clock: this.clock,
      ids: this.ids,
      ...(options.probe ? { probe: options.probe } : {}),
    });
    this.intake = new IntegrationEventIntake({
      stores: this.stores,
      clock: this.clock,
      ids: this.ids,
      ...(options.retryClassForTopic ? { retryClassForTopic: options.retryClassForTopic } : {}),
      ...(options.maxAttemptsForTopic ? { maxAttemptsForTopic: options.maxAttemptsForTopic } : {}),
    });
    this.runner = new JobRunner({
      stores: this.stores,
      clock: this.clock,
      ids: this.ids,
      owner: options.workerOwner ?? "osas-governance-worker",
      ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
      handlers: options.handlers ?? {},
    });
  }

  static create(options: GovernanceRuntimeOptions = {}): GovernanceRuntime {
    return new GovernanceRuntime(options);
  }

  /**
   * Create the organization/workspace pair. Idempotent by tenant: provisioning
   * the same tenant twice returns the existing workspace instead of creating a
   * second one, which is what makes retried installs safe.
   */
  async provisionWorkspace(
    actor: GovernanceActor,
    input: ProvisionWorkspaceInput,
  ): Promise<{ organization: Organization; workspace: Workspace; created: boolean }> {
    requireCapability([...actor.roles], "workspace:write", actor.actorId);
    const tenantId = input.tenantId?.trim() || this.ids.next("tenant");
    const existing = await this.stores.workspaces.getByTenantId(tenantId);
    if (existing) {
      const organization = await this.stores.organizations.get(existing.organizationId);
      if (!organization) {
        throw new GovernanceConflictError(
          `workspace "${existing.id}" references missing organization "${existing.organizationId}"`,
          "workspace",
          existing.id,
        );
      }
      return { organization, workspace: existing, created: false };
    }
    const now = new Date(this.clock.now()).toISOString();
    const organization: Organization = {
      id: input.organizationId?.trim() || this.ids.next("org"),
      specVersion: GOVERNANCE_SPEC_VERSION,
      name: input.organizationName,
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { organization: storedOrg } = await this.stores.organizations.createIfAbsent(organization);
    const workspace: Workspace = {
      id: this.ids.next("ws"),
      specVersion: GOVERNANCE_SPEC_VERSION,
      organizationId: storedOrg.id,
      tenantId,
      name: input.workspaceName,
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { workspace: storedWs } = await this.stores.workspaces.createIfAbsent(workspace);
    return { organization: storedOrg, workspace: storedWs, created: true };
  }

  /** Idempotent control-plane metering. */
  async recordUsage(input: {
    tenantId: string;
    kind: GovernanceUsageKind;
    idempotencyKey: string;
    quantity?: number;
    connectionId?: string;
    caseId?: string;
  }): Promise<boolean> {
    return this.stores.usage.recordIfAbsent({
      id: this.ids.next("usage"),
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: input.tenantId,
      kind: input.kind,
      quantity: input.quantity ?? 1,
      idempotencyKey: input.idempotencyKey,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
      occurredAt: this.clock.now().toISOString(),
    });
  }

  async health(actor: GovernanceActor, tenantId: string): Promise<GovernanceHealth> {
    requireCapability([...actor.roles], "usage:read", actor.actorId);
    const workspace = await this.stores.workspaces.getByTenantId(tenantId);
    const organization = workspace
      ? await this.stores.organizations.get(workspace.organizationId)
      : undefined;
    const connections = await this.stores.connections.list(tenantId);
    const connectionCounts: Record<Connection["status"], number> = {
      active: 0,
      paused: 0,
      error: 0,
      revoked: 0,
    };
    for (const connection of connections) connectionCounts[connection.status] += 1;
    const health: GovernanceHealth = {
      tenantId,
      connections: connectionCounts,
      integrationEvents: await this.stores.integrationEvents.countByStatus(tenantId),
      jobs: await this.stores.jobs.countByStatus(tenantId),
      reconciliations: { open: await this.stores.reconciliations.countOpen(tenantId) },
      usage: { total: await this.stores.usage.sum(tenantId) },
      registeredJobKinds: Object.keys(this.options.handlers ?? {}) as JobKind[],
    };
    if (workspace) health.workspace = workspace;
    if (organization) health.organization = organization;
    return health;
  }
}

/**
 * Reference (record-only) event consumer.
 *
 * It advances the inbox state machine — received -> processing -> processed —
 * and does nothing else. It exists so the reference API can demonstrate the
 * pipeline end to end; a real deployment replaces it with a handler that
 * performs the business action. It is never registered implicitly.
 */
export function createRecordOnlyEventConsumer(
  intake: IntegrationEventIntake,
): JobHandler {
  return async (job) => {
    const eventId = job.input.eventId;
    if (typeof eventId !== "string") {
      throw new Error("integration_event.process job is missing input.eventId");
    }
    await intake.markProcessing(job.tenantId, eventId);
    await intake.markProcessed(job.tenantId, eventId);
    return {
      eventId,
      outcome: "recorded",
      note: "record-only consumer: inbox state advanced, no business action performed",
    };
  };
}
