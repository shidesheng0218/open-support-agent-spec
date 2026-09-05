import {
  IllegalTransitionError,
  canTransitionPolicyVersion,
  type PolicyVersionStatus,
  type TenantPolicy,
} from "@osas/core";

/**
 * An immutable TenantPolicy version plus its lifecycle state and provenance
 * (v0.1.1). Active versions are never modified in place — every change is a
 * new version that supersedes (and retires) the previous active one.
 */
export interface PolicyVersionRecord extends TenantPolicy {
  status: PolicyVersionStatus;
  createdBy: string;
  simulatedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  activatedBy?: string;
  activatedAt?: string;
  retiredBy?: string;
  retiredAt?: string;
}

export class PolicyVersionNotFoundError extends Error {
  constructor(tenantId: string, version: string) {
    super(`Policy version ${version} for tenant ${tenantId} not found`);
    this.name = "PolicyVersionNotFoundError";
  }
}

export class PolicyVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyVersionConflictError";
  }
}

/**
 * Async since Milestone 2: backed by either memory (tests, local dev) or
 * PostgreSQL (@osas/store-postgres). All data is tenant-isolated.
 */
export interface PolicyStore {
  list(tenantId: string): Promise<PolicyVersionRecord[]>;
  get(tenantId: string, version: string): Promise<PolicyVersionRecord | undefined>;
  getActive(tenantId: string): Promise<PolicyVersionRecord | undefined>;
  /** Seed an already-active policy (e.g. an adapter's legacy policy). Idempotent per version. */
  importActive(policy: TenantPolicy, actorId: string): Promise<PolicyVersionRecord>;
  createDraft(tenantId: string, policy: TenantPolicy, actorId: string): Promise<PolicyVersionRecord>;
  markSimulated(tenantId: string, version: string): Promise<PolicyVersionRecord>;
  approve(tenantId: string, version: string, actorId: string): Promise<PolicyVersionRecord>;
  activate(
    tenantId: string,
    version: string,
    actorId: string,
  ): Promise<{ activated: PolicyVersionRecord; superseded?: PolicyVersionRecord }>;
  retire(tenantId: string, version: string, actorId: string): Promise<PolicyVersionRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);
const nowIso = (): string => new Date().toISOString();

export class InMemoryPolicyStore implements PolicyStore {
  private readonly byTenant = new Map<string, Map<string, PolicyVersionRecord>>();

  private versionsOf(tenantId: string): Map<string, PolicyVersionRecord> {
    let versions = this.byTenant.get(tenantId);
    if (!versions) {
      versions = new Map();
      this.byTenant.set(tenantId, versions);
    }
    return versions;
  }

  private mustGet(tenantId: string, version: string): PolicyVersionRecord {
    const found = this.versionsOf(tenantId).get(version);
    if (!found) throw new PolicyVersionNotFoundError(tenantId, version);
    return found;
  }

  private transition(
    tenantId: string,
    version: string,
    to: PolicyVersionStatus,
    stamp: Partial<PolicyVersionRecord>,
  ): PolicyVersionRecord {
    const record = this.mustGet(tenantId, version);
    if (record.status !== to && !canTransitionPolicyVersion(record.status, to)) {
      throw new IllegalTransitionError("policyVersion", record.status, to);
    }
    const updated: PolicyVersionRecord = { ...record, ...stamp, status: to, updatedAt: nowIso() };
    this.versionsOf(tenantId).set(version, updated);
    return clone(updated);
  }

  async list(tenantId: string): Promise<PolicyVersionRecord[]> {
    return clone([...this.versionsOf(tenantId).values()]);
  }

  async get(tenantId: string, version: string): Promise<PolicyVersionRecord | undefined> {
    const found = this.versionsOf(tenantId).get(version);
    return found ? clone(found) : undefined;
  }

  async getActive(tenantId: string): Promise<PolicyVersionRecord | undefined> {
    const found = [...this.versionsOf(tenantId).values()].find((v) => v.status === "active");
    return found ? clone(found) : undefined;
  }

  async importActive(policy: TenantPolicy, actorId: string): Promise<PolicyVersionRecord> {
    const versions = this.versionsOf(policy.tenantId);
    const existing = versions.get(policy.version);
    if (existing) return clone(existing);
    const ts = nowIso();
    const record: PolicyVersionRecord = {
      ...clone(policy),
      status: "active",
      createdBy: actorId,
      activatedBy: actorId,
      activatedAt: ts,
      updatedAt: ts,
    };
    versions.set(record.version, record);
    return clone(record);
  }

  async createDraft(
    tenantId: string,
    policy: TenantPolicy,
    actorId: string,
  ): Promise<PolicyVersionRecord> {
    const versions = this.versionsOf(tenantId);
    if (versions.has(policy.version)) {
      throw new PolicyVersionConflictError(
        `Policy version ${policy.version} already exists for tenant ${tenantId}; policy versions are immutable`,
      );
    }
    if (policy.tenantId !== tenantId) {
      throw new PolicyVersionConflictError(
        `Policy tenantId ${policy.tenantId} does not match tenant ${tenantId}`,
      );
    }
    const record: PolicyVersionRecord = {
      ...clone(policy),
      tenantId,
      status: "draft",
      createdBy: actorId,
      updatedAt: nowIso(),
    };
    versions.set(record.version, record);
    return clone(record);
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
    const activated = this.transition(tenantId, version, "active", {
      activatedBy: actorId,
      activatedAt: nowIso(),
    });
    const previous = [...this.versionsOf(tenantId).values()].find(
      (v) => v.status === "active" && v.version !== version,
    );
    let superseded: PolicyVersionRecord | undefined;
    if (previous) {
      superseded = this.transition(tenantId, previous.version, "retired", {
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
