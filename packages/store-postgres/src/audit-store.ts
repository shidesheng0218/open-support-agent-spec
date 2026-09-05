import type { AuditEvent } from "@osas/core";
import { ensureTenant, type Queryable } from "./pool.js";

interface AuditRow {
  event_id: string;
  sequence: string | null; // bigint arrives as string
  previous_hash: string | null;
  event_hash: string | null;
  event_type: AuditEvent["eventType"];
  actor_type: AuditEvent["actorType"];
  actor_id: string;
  case_id: string | null;
  proposal_id: string | null;
  approval_id: string | null;
  policy_version: string | null;
  model_info: AuditEvent["modelInfo"] | null;
  detail: Record<string, unknown>;
  created_at: Date;
}

/** Append-only audit stream persistence (hash-chain fields included). */
export class PostgresAuditStore {
  constructor(private readonly db: Queryable) {}

  /** Bind to a transaction client (see withTransaction). */
  withClient(db: Queryable): PostgresAuditStore {
    return new PostgresAuditStore(db);
  }

  async append(event: AuditEvent): Promise<void> {
    await ensureTenant(this.db, event.tenantId);
    await this.db.query(
      `INSERT INTO audit_events
         (tenant_id, event_id, sequence, previous_hash, event_hash, event_type,
          actor_type, actor_id, case_id, proposal_id, approval_id,
          policy_version, model_info, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [
        event.tenantId,
        event.id,
        event.sequence ?? null,
        event.previousHash ?? null,
        event.eventHash ?? null,
        event.eventType,
        event.actorType,
        event.actorId,
        event.caseId ?? null,
        event.proposalId ?? null,
        event.approvalId ?? null,
        event.policyVersion ?? null,
        event.modelInfo ? JSON.stringify(event.modelInfo) : null,
        JSON.stringify(event.detail),
        event.createdAt,
      ],
    );
  }

  async list(
    tenantId: string,
    q: { caseId?: string; proposalId?: string } = {},
  ): Promise<AuditEvent[]> {
    const { rows } = await this.db.query<AuditRow>(
      `SELECT event_id, sequence, previous_hash, event_hash, event_type,
              actor_type, actor_id, case_id, proposal_id, approval_id,
              policy_version, model_info, detail, created_at
         FROM audit_events
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR case_id = $2)
          AND ($3::text IS NULL OR proposal_id = $3)
        ORDER BY sequence ASC NULLS LAST, created_at ASC`,
      [tenantId, q.caseId ?? null, q.proposalId ?? null],
    );
    return rows.map((r) => {
      const event: AuditEvent = {
        id: r.event_id,
        specVersion: "0.1",
        tenantId,
        eventType: r.event_type,
        actorType: r.actor_type,
        actorId: r.actor_id,
        detail: r.detail,
        createdAt: r.created_at.toISOString(),
      };
      if (r.case_id) event.caseId = r.case_id;
      if (r.proposal_id) event.proposalId = r.proposal_id;
      if (r.approval_id) event.approvalId = r.approval_id;
      if (r.policy_version) event.policyVersion = r.policy_version;
      if (r.model_info) event.modelInfo = r.model_info;
      if (r.sequence !== null) event.sequence = Number(r.sequence);
      if (r.previous_hash) event.previousHash = r.previous_hash;
      if (r.event_hash) event.eventHash = r.event_hash;
      return event;
    });
  }
}
