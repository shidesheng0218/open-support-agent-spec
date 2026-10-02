import { GOVERNANCE_SPEC_VERSION } from "@osas/governance";
import type {
  IntegrationEvent,
  IntegrationEventStatus,
  IntegrationEventStore,
} from "@osas/governance";
import { GovernanceNotFoundError } from "@osas/governance";
import { ensureTenant, type Queryable } from "./pool.js";

/**
 * PostgreSQL integration inbox (M1).
 *
 * The UNIQUE (tenant_id, connection_id, topic, external_event_id) constraint is
 * the dedupe authority: a replay cannot insert a second row even under
 * concurrent delivery, so the service's duplicate check is a race-free fact
 * rather than a best effort.
 */

/** Statuses that mean "we took responsibility for this event". */
const ACCEPTED_EVENT_STATUSES: readonly IntegrationEventStatus[] = [
  "received",
  "processing",
  "processed",
  "failed",
];

const EVENT_STATUSES: readonly IntegrationEventStatus[] = [
  "received",
  "processing",
  "processed",
  "duplicate",
  "failed",
  "stale_ignored",
];

interface EventRow {
  tenant_id: string;
  event_id: string;
  connection_id: string;
  provider: string;
  topic: string;
  external_event_id: string;
  occurred_at: Date;
  received_at: Date;
  status: IntegrationEventStatus;
  payload: Record<string, unknown>;
  signature_verified: boolean;
  attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
}

function toEvent(r: EventRow): IntegrationEvent {
  const event: IntegrationEvent = {
    id: r.event_id,
    specVersion: GOVERNANCE_SPEC_VERSION,
    tenantId: r.tenant_id,
    connectionId: r.connection_id,
    provider: r.provider,
    topic: r.topic,
    externalEventId: r.external_event_id,
    occurredAt: r.occurred_at.toISOString(),
    receivedAt: r.received_at.toISOString(),
    status: r.status,
    payload: r.payload,
    signatureVerified: r.signature_verified,
    attempts: r.attempts,
  };
  if (r.last_error_code) event.lastErrorCode = r.last_error_code;
  if (r.last_error_message) event.lastErrorMessage = r.last_error_message;
  return event;
}

export class PostgresIntegrationEventStore implements IntegrationEventStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresIntegrationEventStore {
    return new PostgresIntegrationEventStore(db);
  }

  async insertIfAbsent(event: IntegrationEvent) {
    await ensureTenant(this.db, event.tenantId);
    const inserted = await this.db.query<EventRow>(
      `INSERT INTO integration_events
         (tenant_id, event_id, connection_id, provider, topic, external_event_id,
          occurred_at, received_at, status, payload, signature_verified, attempts,
          last_error_code, last_error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        event.tenantId,
        event.id,
        event.connectionId,
        event.provider,
        event.topic,
        event.externalEventId,
        event.occurredAt,
        event.receivedAt,
        event.status,
        JSON.stringify(event.payload),
        event.signatureVerified,
        event.attempts,
        event.lastErrorCode ?? null,
        event.lastErrorMessage ?? null,
      ],
    );
    if (inserted.rows.length === 1) {
      return { inserted: true, event: toEvent(inserted.rows[0]!) };
    }
    const existing = await this.findByProviderIdentity(event);
    if (!existing) {
      throw new GovernanceNotFoundError("integration event", event.id);
    }
    return { inserted: false, event: existing };
  }

  private async findByProviderIdentity(event: {
    tenantId: string;
    connectionId: string;
    topic: string;
    externalEventId: string;
  }): Promise<IntegrationEvent | undefined> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT * FROM integration_events
        WHERE tenant_id = $1 AND connection_id = $2 AND topic = $3 AND external_event_id = $4`,
      [event.tenantId, event.connectionId, event.topic, event.externalEventId],
    );
    const row = rows[0];
    return row ? toEvent(row) : undefined;
  }

  async get(tenantId: string, id: string) {
    const { rows } = await this.db.query<EventRow>(
      "SELECT * FROM integration_events WHERE tenant_id = $1 AND event_id = $2",
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toEvent(row) : undefined;
  }

  async list(
    tenantId: string,
    filter?: { connectionId?: string; status?: IntegrationEventStatus; topic?: string },
    limit = 100,
  ) {
    const { rows } = await this.db.query<EventRow>(
      `SELECT * FROM integration_events
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR connection_id = $2)
          AND ($3::text IS NULL OR status = $3)
          AND ($4::text IS NULL OR topic = $4)
        ORDER BY received_at ASC, event_id ASC
        LIMIT $5`,
      [tenantId, filter?.connectionId ?? null, filter?.status ?? null, filter?.topic ?? null, limit],
    );
    return rows.map(toEvent);
  }

  async markStatus(
    tenantId: string,
    id: string,
    status: IntegrationEventStatus,
    error?: { code: string; message: string },
  ) {
    const { rows } = await this.db.query<EventRow>(
      `UPDATE integration_events SET
         status = $3,
         last_error_code = COALESCE($4, last_error_code),
         last_error_message = COALESCE($5, last_error_message),
         attempts = attempts + CASE WHEN $4 IS NULL THEN 0 ELSE 1 END
       WHERE tenant_id = $1 AND event_id = $2
       RETURNING *`,
      [tenantId, id, status, error?.code ?? null, error?.message ?? null],
    );
    const row = rows[0];
    if (!row) throw new GovernanceNotFoundError("integration event", id);
    return toEvent(row);
  }

  async acceptedWatermark(tenantId: string, connectionId: string) {
    const { rows } = await this.db.query<{ watermark: Date | null }>(
      `SELECT MAX(occurred_at) AS watermark FROM integration_events
        WHERE tenant_id = $1 AND connection_id = $2 AND status = ANY($3::text[])`,
      [tenantId, connectionId, [...ACCEPTED_EVENT_STATUSES]],
    );
    const watermark = rows[0]?.watermark;
    return watermark ? watermark.toISOString() : undefined;
  }

  async countByStatus(tenantId: string): Promise<Record<IntegrationEventStatus, number>> {
    const { rows } = await this.db.query<{ status: IntegrationEventStatus; n: number }>(
      "SELECT status, COUNT(*)::int AS n FROM integration_events WHERE tenant_id = $1 GROUP BY status",
      [tenantId],
    );
    const counts = Object.fromEntries(EVENT_STATUSES.map((s) => [s, 0])) as Record<
      IntegrationEventStatus,
      number
    >;
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }
}
