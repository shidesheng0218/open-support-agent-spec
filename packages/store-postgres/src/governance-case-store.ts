import { GOVERNANCE_SPEC_VERSION, assertTransition } from "@osas/governance";
import type {
  GovernanceUsageEvent,
  GovernanceUsageKind,
  GovernanceUsageStore,
  GovernedCase,
  GovernedCaseState,
  GovernedCaseStore,
  Reconciliation,
  ReconciliationStatus,
  ReconciliationStore,
} from "@osas/governance";
import { GovernanceConflictError, GovernanceNotFoundError } from "@osas/governance";
import { ensureTenant, type Queryable } from "./pool.js";

/**
 * PostgreSQL governed-case, reconciliation, and usage stores (M1).
 *
 * The case transition applies the state machine inside the compare-and-set
 * statement's guard, so an illegal or racing transition can never be written:
 * the UPDATE matches zero rows and the caller gets a precise conflict.
 */

interface CaseRow {
  tenant_id: string;
  case_id: string;
  connection_id: string | null;
  external_case_id: string | null;
  subject: string;
  state: GovernedCaseState;
  priority: GovernedCase["priority"];
  idempotency_key: string;
  assigned_to: string | null;
  evidence_ids: string[];
  proposal_ids: string[];
  approval_ids: string[];
  execution_attempt_ids: string[];
  reconciliation_ids: string[];
  version: number;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

function toCase(r: CaseRow): GovernedCase {
  const governed: GovernedCase = {
    id: r.case_id,
    specVersion: GOVERNANCE_SPEC_VERSION,
    tenantId: r.tenant_id,
    subject: r.subject,
    state: r.state,
    priority: r.priority,
    idempotencyKey: r.idempotency_key,
    evidenceIds: r.evidence_ids,
    proposalIds: r.proposal_ids,
    approvalIds: r.approval_ids,
    executionAttemptIds: r.execution_attempt_ids,
    reconciliationIds: r.reconciliation_ids,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
  if (r.connection_id) governed.connectionId = r.connection_id;
  if (r.external_case_id) governed.externalCaseId = r.external_case_id;
  if (r.assigned_to) governed.assignedTo = r.assigned_to;
  if (r.closed_at) governed.closedAt = r.closed_at.toISOString();
  return governed;
}

const CASE_PATCH_KEYS = [
  "assignedTo",
  "priority",
  "evidenceIds",
  "proposalIds",
  "approvalIds",
  "executionAttemptIds",
  "reconciliationIds",
  "closedAt",
] as const;

export class PostgresGovernedCaseStore implements GovernedCaseStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresGovernedCaseStore {
    return new PostgresGovernedCaseStore(db);
  }

  async createIfAbsent(case_: GovernedCase) {
    await ensureTenant(this.db, case_.tenantId);
    const inserted = await this.db.query<CaseRow>(
      `INSERT INTO governed_cases
         (tenant_id, case_id, connection_id, external_case_id, subject, state, priority,
          idempotency_key, assigned_to, evidence_ids, proposal_ids, approval_ids,
          execution_attempt_ids, reconciliation_ids, version, created_at, updated_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        case_.tenantId,
        case_.id,
        case_.connectionId ?? null,
        case_.externalCaseId ?? null,
        case_.subject,
        case_.state,
        case_.priority,
        case_.idempotencyKey,
        case_.assignedTo ?? null,
        JSON.stringify(case_.evidenceIds),
        JSON.stringify(case_.proposalIds),
        JSON.stringify(case_.approvalIds),
        JSON.stringify(case_.executionAttemptIds),
        JSON.stringify(case_.reconciliationIds),
        case_.version,
        case_.createdAt,
        case_.updatedAt,
        case_.closedAt ?? null,
      ],
    );
    if (inserted.rows.length === 1) {
      return { inserted: true, case: toCase(inserted.rows[0]!) };
    }
    const byKey = await this.findByIdempotencyKey(case_.tenantId, case_.idempotencyKey);
    if (byKey) return { inserted: false, case: byKey };
    throw new GovernanceConflictError(`case "${case_.id}" already exists`, "case", case_.id);
  }

  async get(tenantId: string, id: string) {
    const { rows } = await this.db.query<CaseRow>(
      "SELECT * FROM governed_cases WHERE tenant_id = $1 AND case_id = $2",
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toCase(row) : undefined;
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    const { rows } = await this.db.query<CaseRow>(
      "SELECT * FROM governed_cases WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, idempotencyKey],
    );
    const row = rows[0];
    return row ? toCase(row) : undefined;
  }

  async list(
    tenantId: string,
    filter?: { state?: GovernedCaseState; connectionId?: string; assignedTo?: string },
    limit = 100,
  ) {
    const { rows } = await this.db.query<CaseRow>(
      `SELECT * FROM governed_cases
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR state = $2)
          AND ($3::text IS NULL OR connection_id = $3)
          AND ($4::text IS NULL OR assigned_to = $4)
        ORDER BY created_at ASC, case_id ASC
        LIMIT $5`,
      [
        tenantId,
        filter?.state ?? null,
        filter?.connectionId ?? null,
        filter?.assignedTo ?? null,
        limit,
      ],
    );
    return rows.map(toCase);
  }

  async transition(
    tenantId: string,
    id: string,
    expectedVersion: number,
    next: GovernedCaseState,
    patch: Partial<
      Pick<
        GovernedCase,
        | "assignedTo"
        | "priority"
        | "evidenceIds"
        | "proposalIds"
        | "approvalIds"
        | "executionAttemptIds"
        | "reconciliationIds"
        | "closedAt"
      >
    >,
    now: Date,
  ) {
    const current = await this.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("case", id);
    if (current.version !== expectedVersion) {
      throw new GovernanceConflictError(
        `case "${id}" was modified (expected version ${expectedVersion}, found ${current.version})`,
        "case",
        id,
      );
    }
    // Same machine as the in-memory store; the CAS below re-checks the version.
    assertTransition(current.state, next);
    const json: Record<string, unknown> = {};
    for (const key of CASE_PATCH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        json[key] = (patch as Record<string, unknown>)[key] ?? null;
      }
    }
    const { rows } = await this.db.query<CaseRow>(
      `UPDATE governed_cases SET
         state = $4,
         assigned_to = CASE WHEN $5::jsonb ? 'assignedTo' THEN $5::jsonb->>'assignedTo' ELSE assigned_to END,
         priority = CASE WHEN $5::jsonb ? 'priority' THEN $5::jsonb->>'priority' ELSE priority END,
         evidence_ids = CASE WHEN $5::jsonb ? 'evidenceIds' THEN $5::jsonb->'evidenceIds' ELSE evidence_ids END,
         proposal_ids = CASE WHEN $5::jsonb ? 'proposalIds' THEN $5::jsonb->'proposalIds' ELSE proposal_ids END,
         approval_ids = CASE WHEN $5::jsonb ? 'approvalIds' THEN $5::jsonb->'approvalIds' ELSE approval_ids END,
         execution_attempt_ids = CASE WHEN $5::jsonb ? 'executionAttemptIds' THEN $5::jsonb->'executionAttemptIds' ELSE execution_attempt_ids END,
         reconciliation_ids = CASE WHEN $5::jsonb ? 'reconciliationIds' THEN $5::jsonb->'reconciliationIds' ELSE reconciliation_ids END,
         closed_at = CASE
           WHEN $5::jsonb ? 'closedAt' THEN ($5::jsonb->>'closedAt')::timestamptz
           WHEN $4 = 'resolved' THEN COALESCE(closed_at, $6)
           ELSE closed_at END,
         version = version + 1,
         updated_at = $6
       WHERE tenant_id = $1 AND case_id = $2 AND version = $3
       RETURNING *`,
      [tenantId, id, expectedVersion, next, JSON.stringify(json), now.toISOString()],
    );
    const row = rows[0];
    if (row) return toCase(row);
    const after = await this.get(tenantId, id);
    throw new GovernanceConflictError(
      `case "${id}" was modified concurrently`,
      "case",
      after?.id ?? id,
    );
  }
}

/* --------------------------------------------------------- reconciliation -- */

interface ReconciliationRow {
  tenant_id: string;
  reconciliation_id: string;
  reason: Reconciliation["reason"];
  status: ReconciliationStatus;
  dedupe_key: string;
  job_run_id: string | null;
  connection_id: string | null;
  case_id: string | null;
  proposal_id: string | null;
  idempotency_key: string | null;
  detail: Record<string, unknown>;
  resolved_by: string | null;
  resolution: string | null;
  version: number;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toReconciliation(r: ReconciliationRow): Reconciliation {
  const record: Reconciliation = {
    id: r.reconciliation_id,
    specVersion: GOVERNANCE_SPEC_VERSION,
    tenantId: r.tenant_id,
    reason: r.reason,
    status: r.status,
    dedupeKey: r.dedupe_key,
    detail: r.detail,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
  if (r.job_run_id) record.jobRunId = r.job_run_id;
  if (r.connection_id) record.connectionId = r.connection_id;
  if (r.case_id) record.caseId = r.case_id;
  if (r.proposal_id) record.proposalId = r.proposal_id;
  if (r.idempotency_key) record.idempotencyKey = r.idempotency_key;
  if (r.resolved_by) record.resolvedBy = r.resolved_by;
  if (r.resolution) record.resolution = r.resolution;
  if (r.resolved_at) record.resolvedAt = r.resolved_at.toISOString();
  return record;
}

export class PostgresGovernanceReconciliationStore implements ReconciliationStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresGovernanceReconciliationStore {
    return new PostgresGovernanceReconciliationStore(db);
  }

  async createIfAbsent(reconciliation: Reconciliation) {
    await ensureTenant(this.db, reconciliation.tenantId);
    const inserted = await this.db.query<ReconciliationRow>(
      `INSERT INTO reconciliations
         (tenant_id, reconciliation_id, reason, status, dedupe_key, job_run_id, connection_id,
          case_id, proposal_id, idempotency_key, detail, resolved_by, resolution, version,
          resolved_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        reconciliation.tenantId,
        reconciliation.id,
        reconciliation.reason,
        reconciliation.status,
        reconciliation.dedupeKey,
        reconciliation.jobRunId ?? null,
        reconciliation.connectionId ?? null,
        reconciliation.caseId ?? null,
        reconciliation.proposalId ?? null,
        reconciliation.idempotencyKey ?? null,
        JSON.stringify(reconciliation.detail),
        reconciliation.resolvedBy ?? null,
        reconciliation.resolution ?? null,
        reconciliation.version,
        reconciliation.resolvedAt ?? null,
        reconciliation.createdAt,
        reconciliation.updatedAt,
      ],
    );
    if (inserted.rows.length === 1) {
      return { inserted: true, reconciliation: toReconciliation(inserted.rows[0]!) };
    }
    const { rows } = await this.db.query<ReconciliationRow>(
      "SELECT * FROM reconciliations WHERE tenant_id = $1 AND dedupe_key = $2",
      [reconciliation.tenantId, reconciliation.dedupeKey],
    );
    const existing = rows[0];
    if (!existing) {
      throw new GovernanceConflictError(
        `reconciliation "${reconciliation.id}" could not be created`,
        "reconciliation",
        reconciliation.id,
      );
    }
    return { inserted: false, reconciliation: toReconciliation(existing) };
  }

  async get(tenantId: string, id: string) {
    const { rows } = await this.db.query<ReconciliationRow>(
      "SELECT * FROM reconciliations WHERE tenant_id = $1 AND reconciliation_id = $2",
      [tenantId, id],
    );
    const row = rows[0];
    return row ? toReconciliation(row) : undefined;
  }

  async list(
    tenantId: string,
    filter?: { status?: ReconciliationStatus; caseId?: string; jobRunId?: string },
    limit = 100,
  ) {
    const { rows } = await this.db.query<ReconciliationRow>(
      `SELECT * FROM reconciliations
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR case_id = $3)
          AND ($4::text IS NULL OR job_run_id = $4)
        ORDER BY created_at ASC, reconciliation_id ASC
        LIMIT $5`,
      [tenantId, filter?.status ?? null, filter?.caseId ?? null, filter?.jobRunId ?? null, limit],
    );
    return rows.map(toReconciliation);
  }

  async decide(
    tenantId: string,
    id: string,
    decision: { status: "resolved" | "dismissed"; resolvedBy: string; resolution: string },
    expectedVersion: number,
    now: Date,
  ) {
    const { rows } = await this.db.query<ReconciliationRow>(
      `UPDATE reconciliations SET
         status = $4, resolved_by = $5, resolution = $6,
         resolved_at = $7, updated_at = $7, version = version + 1
       WHERE tenant_id = $1 AND reconciliation_id = $2 AND version = $3 AND status = 'open'
       RETURNING *`,
      [tenantId, id, expectedVersion, decision.status, decision.resolvedBy, decision.resolution, now.toISOString()],
    );
    const row = rows[0];
    if (row) return toReconciliation(row);
    const current = await this.get(tenantId, id);
    if (!current) throw new GovernanceNotFoundError("reconciliation", id);
    if (current.status !== "open") {
      throw new GovernanceConflictError(
        `reconciliation "${id}" is already ${current.status}`,
        "reconciliation",
        id,
      );
    }
    throw new GovernanceConflictError(
      `reconciliation "${id}" was modified (expected version ${expectedVersion}, found ${current.version})`,
      "reconciliation",
      id,
    );
  }

  async countOpen(tenantId?: string) {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM reconciliations
        WHERE status = 'open' AND ($1::text IS NULL OR tenant_id = $1)`,
      [tenantId ?? null],
    );
    return rows[0]?.n ?? 0;
  }
}

/* ------------------------------------------------------------ usage events -- */

interface UsageRow {
  tenant_id: string;
  usage_id: string;
  kind: GovernanceUsageKind;
  quantity: number;
  idempotency_key: string;
  connection_id: string | null;
  case_id: string | null;
  occurred_at: Date;
}

function toUsage(r: UsageRow): GovernanceUsageEvent {
  const event: GovernanceUsageEvent = {
    id: r.usage_id,
    specVersion: GOVERNANCE_SPEC_VERSION,
    tenantId: r.tenant_id,
    kind: r.kind,
    quantity: r.quantity,
    idempotencyKey: r.idempotency_key,
    occurredAt: r.occurred_at.toISOString(),
  };
  if (r.connection_id) event.connectionId = r.connection_id;
  if (r.case_id) event.caseId = r.case_id;
  return event;
}

export class PostgresGovernanceUsageStore implements GovernanceUsageStore {
  constructor(private readonly db: Queryable) {}

  withClient(db: Queryable): PostgresGovernanceUsageStore {
    return new PostgresGovernanceUsageStore(db);
  }

  async recordIfAbsent(event: GovernanceUsageEvent) {
    await ensureTenant(this.db, event.tenantId);
    const { rows } = await this.db.query<{ usage_id: string }>(
      `INSERT INTO governance_usage_events
         (tenant_id, usage_id, kind, quantity, idempotency_key, connection_id, case_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING usage_id`,
      [
        event.tenantId,
        event.id,
        event.kind,
        event.quantity,
        event.idempotencyKey,
        event.connectionId ?? null,
        event.caseId ?? null,
        event.occurredAt,
      ],
    );
    return rows.length === 1;
  }

  async list(
    tenantId: string,
    filter?: { kind?: GovernanceUsageKind; from?: string; to?: string },
    limit = 200,
  ) {
    const { rows } = await this.db.query<UsageRow>(
      `SELECT * FROM governance_usage_events
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR kind = $2)
          AND ($3::timestamptz IS NULL OR occurred_at >= $3)
          AND ($4::timestamptz IS NULL OR occurred_at < $4)
        ORDER BY occurred_at ASC, usage_id ASC
        LIMIT $5`,
      [tenantId, filter?.kind ?? null, filter?.from ?? null, filter?.to ?? null, limit],
    );
    return rows.map(toUsage);
  }

  async sum(tenantId: string, kind?: GovernanceUsageKind) {
    const { rows } = await this.db.query<{ total: number }>(
      `SELECT COALESCE(SUM(quantity), 0)::int AS total FROM governance_usage_events
        WHERE tenant_id = $1 AND ($2::text IS NULL OR kind = $2)`,
      [tenantId, kind ?? null],
    );
    return rows[0]?.total ?? 0;
  }
}
