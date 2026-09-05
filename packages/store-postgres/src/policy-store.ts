import {
  IllegalTransitionError,
  canTransitionPolicyVersion,
  type PolicyVersionStatus,
  type TenantPolicy,
} from "@osas/core";
import {
  PolicyVersionConflictError,
  PolicyVersionNotFoundError,
  type PolicyStore,
  type PolicyVersionRecord,
} from "@osas/policy-engine";
import { ensureTenant, type Queryable } from "./pool.js";

const nowIso = (): string => new Date().toISOString();

interface PolicyRow {
  policy: TenantPolicy;
  status: PolicyVersionStatus;
  created_by: string;
  simulated_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  activated_by: string | null;
  activated_at: Date | null;
  retired_by: string | null;
  retired_at: Date | null;
}

function toRecord(tenantId: string, row: PolicyRow): PolicyVersionRecord {
  const record: PolicyVersionRecord = {
    ...row.policy,
    tenantId,
    status: row.status,
    createdBy: row.created_by,
  };
  if (row.simulated_at) record.simulatedAt = row.simulated_at.toISOString();
  if (row.approved_by) record.approvedBy = row.approved_by;
  if (row.approved_at) record.approvedAt = row.approved_at.toISOString();
  if (row.activated_by) record.activatedBy = row.activated_by;
  if (row.activated_at) record.activatedAt = row.activated_at.toISOString();
  if (row.retired_by) record.retiredBy = row.retired_by;
  if (row.retired_at) record.retiredAt = row.retired_at.toISOString();
  return record;
}

const SELECT_COLS =
  "policy, status, created_by, simulated_at, approved_by, approved_at, activated_by, activated_at, retired_by, retired_at";

/**
 * Versioned tenant policies on PostgreSQL. Versions are immutable: the
 * PRIMARY KEY (tenant_id, version) rejects reuse; lifecycle transitions
 * follow the same state machine as InMemoryPolicyStore.
 */
export class PostgresPolicyStore implements PolicyStore {
  constructor(private readonly db: Queryable) {}

  /** Bind to a transaction client (see withTransaction). */
  withClient(db: Queryable): PostgresPolicyStore {
    return new PostgresPolicyStore(db);
  }

  async list(tenantId: string): Promise<PolicyVersionRecord[]> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT ${SELECT_COLS} FROM policy_versions WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    );
    return rows.map((r) => toRecord(tenantId, r));
  }

  async get(tenantId: string, version: string): Promise<PolicyVersionRecord | undefined> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT ${SELECT_COLS} FROM policy_versions WHERE tenant_id = $1 AND version = $2`,
      [tenantId, version],
    );
    return rows[0] ? toRecord(tenantId, rows[0]) : undefined;
  }

  async getActive(tenantId: string): Promise<PolicyVersionRecord | undefined> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT ${SELECT_COLS} FROM policy_versions WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId],
    );
    return rows[0] ? toRecord(tenantId, rows[0]) : undefined;
  }

  async importActive(policy: TenantPolicy, actorId: string): Promise<PolicyVersionRecord> {
    const existing = await this.get(policy.tenantId, policy.version);
    if (existing) return existing;
    await ensureTenant(this.db, policy.tenantId);
    const ts = nowIso();
    const record: PolicyVersionRecord = {
      ...structuredClone(policy),
      status: "active",
      createdBy: actorId,
      activatedBy: actorId,
      activatedAt: ts,
      updatedAt: ts,
    };
    await this.insert(record);
    return record;
  }

  async createDraft(
    tenantId: string,
    policy: TenantPolicy,
    actorId: string,
  ): Promise<PolicyVersionRecord> {
    if (policy.tenantId !== tenantId) {
      throw new PolicyVersionConflictError(
        `Policy tenantId ${policy.tenantId} does not match tenant ${tenantId}`,
      );
    }
    await ensureTenant(this.db, tenantId);
    const record: PolicyVersionRecord = {
      ...structuredClone(policy),
      tenantId,
      status: "draft",
      createdBy: actorId,
      updatedAt: nowIso(),
    };
    try {
      await this.insert(record);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new PolicyVersionConflictError(
          `Policy version ${policy.version} already exists for tenant ${tenantId}; policy versions are immutable`,
        );
      }
      throw err;
    }
    return structuredClone(record);
  }

  private async insert(record: PolicyVersionRecord): Promise<void> {
    const { status, createdBy, simulatedAt, approvedBy, approvedAt, activatedBy, activatedAt, retiredBy, retiredAt, updatedAt: _u, ...policy } =
      record;
    await this.db.query(
      `INSERT INTO policy_versions
         (tenant_id, version, status, policy, created_by, simulated_at,
          approved_by, approved_at, activated_by, activated_at, retired_by, retired_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        record.tenantId,
        record.version,
        record.status,
        JSON.stringify({ ...policy, updatedAt: record.updatedAt }),
        createdBy,
        simulatedAt ?? null,
        approvedBy ?? null,
        approvedAt ?? null,
        activatedBy ?? null,
        activatedAt ?? null,
        retiredBy ?? null,
        retiredAt ?? null,
      ],
    );
  }

  private async transition(
    tenantId: string,
    version: string,
    to: PolicyVersionStatus,
    stamp: {
      simulatedAt?: string;
      approvedBy?: string;
      approvedAt?: string;
      activatedBy?: string;
      activatedAt?: string;
      retiredBy?: string;
      retiredAt?: string;
    },
  ): Promise<PolicyVersionRecord> {
    const record = await this.get(tenantId, version);
    if (!record) throw new PolicyVersionNotFoundError(tenantId, version);
    if (record.status !== to && !canTransitionPolicyVersion(record.status, to)) {
      throw new IllegalTransitionError("policyVersion", record.status, to);
    }
    const updated: PolicyVersionRecord = { ...record, ...stamp, status: to, updatedAt: nowIso() };
    const { status, createdBy: _c, simulatedAt, approvedBy, approvedAt, activatedBy, activatedAt, retiredBy, retiredAt, updatedAt: _u2, ...policy } =
      updated;
    await this.db.query(
      `UPDATE policy_versions
          SET status = $3, policy = $4, simulated_at = $5,
              approved_by = $6, approved_at = $7, activated_by = $8, activated_at = $9,
              retired_by = $10, retired_at = $11, updated_at = now()
        WHERE tenant_id = $1 AND version = $2`,
      [
        tenantId,
        version,
        status,
        JSON.stringify({ ...policy, updatedAt: updated.updatedAt }),
        simulatedAt ?? null,
        approvedBy ?? null,
        approvedAt ?? null,
        activatedBy ?? null,
        activatedAt ?? null,
        retiredBy ?? null,
        retiredAt ?? null,
      ],
    );
    return structuredClone(updated);
  }

  async markSimulated(tenantId: string, version: string): Promise<PolicyVersionRecord> {
    return this.transition(tenantId, version, "simulated", { simulatedAt: nowIso() });
  }

  async approve(tenantId: string, version: string, actorId: string): Promise<PolicyVersionRecord> {
    return this.transition(tenantId, version, "approved", {
      approvedBy: actorId,
      approvedAt: nowIso(),
    });
  }

  async activate(
    tenantId: string,
    version: string,
    actorId: string,
  ): Promise<{ activated: PolicyVersionRecord; superseded?: PolicyVersionRecord }> {
    const activated = await this.transition(tenantId, version, "active", {
      activatedBy: actorId,
      activatedAt: nowIso(),
    });
    const previous = (await this.list(tenantId)).find(
      (v) => v.status === "active" && v.version !== version,
    );
    let superseded: PolicyVersionRecord | undefined;
    if (previous) {
      superseded = await this.transition(tenantId, previous.version, "retired", {
        retiredBy: actorId,
        retiredAt: nowIso(),
      });
    }
    return { activated, ...(superseded ? { superseded } : {}) };
  }

  async retire(tenantId: string, version: string, actorId: string): Promise<PolicyVersionRecord> {
    return this.transition(tenantId, version, "retired", {
      retiredBy: actorId,
      retiredAt: nowIso(),
    });
  }
}
