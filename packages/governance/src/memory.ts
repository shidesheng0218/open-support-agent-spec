import { assertTransition } from "./case-machine.js";
import {
  GovernanceConflictError,
  GovernanceNotFoundError,
} from "./errors.js";
import type {
  ConnectionStore,
  GovernanceStores,
  GovernanceUsageStore,
  GovernedCaseStore,
  IntegrationEventStore,
  JobClaimInput,
  JobStore,
  MembershipStore,
  OrganizationStore,
  ReconciliationStore,
  WorkspaceStore,
} from "./ports.js";
import type {
  Connection,
  ConnectionPatch,
  GovernanceUsageEvent,
  GovernanceUsageKind,
  GovernedCase,
  GovernedCaseState,
  IntegrationEvent,
  IntegrationEventStatus,
  JobFailure,
  JobKind,
  JobRun,
  JobStatus,
  Membership,
  Organization,
  Reconciliation,
  ReconciliationStatus,
  Workspace,
} from "./types.js";

/**
 * In-memory governance stores.
 *
 * These are the reference semantics: the PostgreSQL implementations must match
 * them behaviourally (same dedupe keys, same CAS rules, same retry policy).
 * The parity is asserted by governance-memory.test.ts and, when DATABASE_URL
 * is set, by store-postgres governance tests.
 *
 * They are used by: local development, the demo stack, and every unit test —
 * so they must be correct, not merely convenient. Nothing here is a stub: an
 * unsupported operation raises rather than returning a plausible-looking
 * default.
 */

const clone = <T>(value: T): T => structuredClone(value);

const byCreatedThenId = <T extends { createdAt: string; id: string }>(a: T, b: T): number =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);

/** Events have no createdAt: receivedAt is when we accepted them. */
const byReceivedThenId = <T extends { receivedAt: string; id: string }>(a: T, b: T): number =>
  a.receivedAt === b.receivedAt ? a.id.localeCompare(b.id) : a.receivedAt.localeCompare(b.receivedAt);

const byOccurredThenId = <T extends { occurredAt: string; id: string }>(a: T, b: T): number =>
  a.occurredAt === b.occurredAt ? a.id.localeCompare(b.id) : a.occurredAt.localeCompare(b.occurredAt);

/** Statuses that mean "we took responsibility for this event". */
const ACCEPTED_EVENT_STATUSES: readonly IntegrationEventStatus[] = [
  "received",
  "processing",
  "processed",
  "failed",
];

const EMPTY_JOB_COUNTS = (): Record<JobStatus, number> => ({
  queued: 0,
  leased: 0,
  succeeded: 0,
  dead_letter: 0,
  cancelled: 0,
});

export class InMemoryOrganizationStore implements OrganizationStore {
  private readonly rows = new Map<string, Organization>();

  async createIfAbsent(org: Organization) {
    const existing = this.rows.get(org.id);
    if (existing) return { inserted: false, organization: clone(existing) };
    this.rows.set(org.id, clone(org));
    return { inserted: true, organization: clone(org) };
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? clone(row) : undefined;
  }

  async list() {
    return [...this.rows.values()].sort(byCreatedThenId).map(clone);
  }

  async update(
    id: string,
    patch: { name?: string; status?: Organization["status"] },
    expectedVersion: number,
  ) {
    const row = this.rows.get(id);
    if (!row) throw new GovernanceNotFoundError("organization", id);
    if (row.version !== expectedVersion) {
      throw new GovernanceConflictError(
        `organization "${id}" was modified (expected version ${expectedVersion}, found ${row.version})`,
        "organization",
        id,
      );
    }
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.status !== undefined) row.status = patch.status;
    row.version += 1;
    row.updatedAt = new Date().toISOString();
    return clone(row);
  }
}

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly rows = new Map<string, Workspace>();

  async createIfAbsent(ws: Workspace) {
    const existing = this.rows.get(ws.id);
    if (existing) return { inserted: false, workspace: clone(existing) };
    const taken = [...this.rows.values()].find((w) => w.tenantId === ws.tenantId);
    if (taken) {
      throw new GovernanceConflictError(
        `tenant "${ws.tenantId}" already belongs to workspace "${taken.id}"`,
        "workspace",
        ws.id,
      );
    }
    this.rows.set(ws.id, clone(ws));
    return { inserted: true, workspace: clone(ws) };
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? clone(row) : undefined;
  }

  async getByTenantId(tenantId: string) {
    const row = [...this.rows.values()].find((w) => w.tenantId === tenantId);
    return row ? clone(row) : undefined;
  }

  async listByOrganization(organizationId: string) {
    return [...this.rows.values()]
      .filter((w) => w.organizationId === organizationId)
      .sort(byCreatedThenId)
      .map(clone);
  }

  async update(
    id: string,
    patch: { name?: string; status?: Workspace["status"] },
    expectedVersion: number,
  ) {
    const row = this.rows.get(id);
    if (!row) throw new GovernanceNotFoundError("workspace", id);
    if (row.version !== expectedVersion) {
      throw new GovernanceConflictError(
        `workspace "${id}" was modified (expected version ${expectedVersion}, found ${row.version})`,
        "workspace",
        id,
      );
    }
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.status !== undefined) row.status = patch.status;
    row.version += 1;
    row.updatedAt = new Date().toISOString();
    return clone(row);
  }
}

const membershipKey = (m: { principalId: string; organizationId: string; workspaceId?: string }) =>
  `${m.organizationId}::${m.workspaceId ?? "*"}::${m.principalId}`;

export class InMemoryMembershipStore implements MembershipStore {
  private readonly rows = new Map<string, Membership>();

  async put(membership: Membership) {
    const key = membershipKey(membership);
    const existing = this.rows.get(key);
    const row: Membership = existing ? { ...membership, id: existing.id, createdAt: existing.createdAt } : clone(membership);
    this.rows.set(key, row);
    return clone(row);
  }

  async listByPrincipal(principalId: string) {
    return [...this.rows.values()].filter((m) => m.principalId === principalId).map(clone);
  }

  async listByOrganization(organizationId: string) {
    return [...this.rows.values()].filter((m) => m.organizationId === organizationId).map(clone);
  }

  async remove(principalId: string, organizationId: string, workspaceId?: string) {
    return this.rows.delete(membershipKey({ principalId, organizationId, workspaceId }));
  }
}

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly rows = new Map<string, Connection>();

  private key(tenantId: string, id: string) {
    return `${tenantId}::${id}`;
  }

  async createIfAbsent(connection: Connection) {
    const key = this.key(connection.tenantId, connection.id);
    const existing = this.rows.get(key);
    if (existing) return { inserted: false, connection: clone(existing) };
    // One live connection per provider account: two connections reading the
    // same account would double-ingest every event.
    const duplicate = [...this.rows.values()].find(
      (c) =>
        c.tenantId === connection.tenantId &&
        c.provider === connection.provider &&
        c.externalAccountId === connection.externalAccountId &&
        c.status !== "revoked",
    );
    if (duplicate) {
      throw new GovernanceConflictError(
        `tenant "${connection.tenantId}" already has a live ${connection.provider} connection for "${connection.externalAccountId}"`,
        "connection",
        duplicate.id,
      );
    }
    this.rows.set(key, clone(connection));
    return { inserted: true, connection: clone(connection) };
  }

  async get(tenantId: string, id: string) {
    const row = this.rows.get(this.key(tenantId, id));
    return row ? clone(row) : undefined;
  }

  async list(tenantId: string, filter?: { status?: Connection["status"]; provider?: string }) {
    return [...this.rows.values()]
      .filter((c) => c.tenantId === tenantId)
      .filter((c) => (filter?.status ? c.status === filter.status : true))
      .filter((c) => (filter?.provider ? c.provider === filter.provider : true))
      .sort(byCreatedThenId)
      .map(clone);
  }

  async update(
    tenantId: string,
    id: string,
    patch: ConnectionPatch,
    expectedVersion: number,
  ) {
    const key = this.key(tenantId, id);
    const row = this.rows.get(key);
    if (!row) throw new GovernanceNotFoundError("connection", id);
    if (row.version !== expectedVersion) {
      throw new GovernanceConflictError(
        `connection "${id}" was modified (expected version ${expectedVersion}, found ${row.version})`,
        "connection",
        id,
      );
    }
    Object.assign(row, patch);
    row.version += 1;
    row.updatedAt = new Date().toISOString();
    return clone(row);
  }

  async remove(tenantId: string, id: string) {
    return this.rows.delete(this.key(tenantId, id));
  }
}

export class InMemoryIntegrationEventStore implements IntegrationEventStore {
  private readonly rows = new Map<string, IntegrationEvent>();

  private key(e: { tenantId: string; connectionId: string; topic: string; externalEventId: string }) {
    return `${e.tenantId}::${e.connectionId}::${e.topic}::${e.externalEventId}`;
  }

  async insertIfAbsent(event: IntegrationEvent) {
    const key = this.key(event);
    const existing = [...this.rows.values()].find((r) => this.key(r) === key);
    if (existing) return { inserted: false, event: clone(existing) };
    this.rows.set(event.id, clone(event));
    return { inserted: true, event: clone(event) };
  }

  async get(tenantId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? clone(row) : undefined;
  }

  async list(
    tenantId: string,
    filter?: { connectionId?: string; status?: IntegrationEventStatus; topic?: string },
    limit = 100,
  ) {
    return [...this.rows.values()]
      .filter((e) => e.tenantId === tenantId)
      .filter((e) => (filter?.connectionId ? e.connectionId === filter.connectionId : true))
      .filter((e) => (filter?.status ? e.status === filter.status : true))
      .filter((e) => (filter?.topic ? e.topic === filter.topic : true))
      .sort(byReceivedThenId)
      .slice(0, limit)
      .map(clone);
  }

  async markStatus(
    tenantId: string,
    id: string,
    status: IntegrationEventStatus,
    error?: { code: string; message: string },
  ) {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) throw new GovernanceNotFoundError("integration event", id);
    row.status = status;
    if (error) {
      row.lastErrorCode = error.code;
      row.lastErrorMessage = error.message;
      row.attempts += 1;
    }
    return clone(row);
  }

  async countByStatus(tenantId: string) {
    const counts: Record<IntegrationEventStatus, number> = {
      received: 0,
      processing: 0,
      processed: 0,
      duplicate: 0,
      failed: 0,
      stale_ignored: 0,
    };
    for (const event of this.rows.values()) {
      if (event.tenantId !== tenantId) continue;
      counts[event.status] += 1;
    }
    return counts;
  }

  async acceptedWatermark(tenantId: string, connectionId: string) {
    const times = [...this.rows.values()]
      .filter((e) => e.tenantId === tenantId && e.connectionId === connectionId)
      .filter((e) => ACCEPTED_EVENT_STATUSES.includes(e.status))
      .map((e) => e.occurredAt);
    if (times.length === 0) return undefined;
    return times.sort().at(-1);
  }
}

export class InMemoryJobStore implements JobStore {
  private readonly rows = new Map<string, JobRun>();

  async create(job: JobRun) {
    if (this.rows.has(job.id)) {
      throw new GovernanceConflictError(`job "${job.id}" already exists`, "job", job.id);
    }
    this.rows.set(job.id, clone(job));
    return clone(job);
  }

  async get(tenantId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? clone(row) : undefined;
  }

  async list(
    tenantId: string,
    filter?: { status?: JobStatus; kind?: JobKind },
    limit = 100,
  ) {
    return [...this.rows.values()]
      .filter((j) => j.tenantId === tenantId)
      .filter((j) => (filter?.status ? j.status === filter.status : true))
      .filter((j) => (filter?.kind ? j.kind === filter.kind : true))
      .sort(byCreatedThenId)
      .slice(0, limit)
      .map(clone);
  }

  async claim(input: JobClaimInput) {
    const nowMs = input.now.getTime();
    const claimable = [...this.rows.values()]
      .filter((j) => j.status === "queued")
      .filter((j) => (input.tenantId ? j.tenantId === input.tenantId : true))
      .filter((j) => (input.kinds && input.kinds.length > 0 ? input.kinds.includes(j.kind) : true))
      .filter((j) => new Date(j.runAt).getTime() <= nowMs)
      .filter((j) => (j.deadlineAt ? new Date(j.deadlineAt).getTime() > nowMs : true))
      .sort((a, b) => (a.runAt === b.runAt ? a.createdAt.localeCompare(b.createdAt) : a.runAt.localeCompare(b.runAt)))
      .slice(0, input.limit);
    return claimable.map((job) => {
      job.status = "leased";
      job.leaseOwner = input.owner;
      job.leaseExpiresAt = new Date(nowMs + input.leaseMs).toISOString();
      job.attempts += 1;
      job.updatedAt = input.now.toISOString();
      return clone(job);
    });
  }

  async complete(tenantId: string, id: string, result: Record<string, unknown>, now: Date) {
    const job = this.rows.get(id);
    if (!job || job.tenantId !== tenantId) throw new GovernanceNotFoundError("job", id);
    job.status = "succeeded";
    job.result = clone(result);
    delete job.leaseOwner;
    delete job.leaseExpiresAt;
    job.updatedAt = now.toISOString();
    return clone(job);
  }

  async fail(tenantId: string, id: string, failure: JobFailure, now: Date) {
    const job = this.rows.get(id);
    if (!job || job.tenantId !== tenantId) throw new GovernanceNotFoundError("job", id);
    job.lastErrorCode = failure.errorCode;
    job.lastErrorMessage = failure.errorMessage;
    delete job.leaseOwner;
    delete job.leaseExpiresAt;
    if (failure.deadlineAt) job.deadlineAt = failure.deadlineAt;
    const exhausted = job.attempts >= job.maxAttempts;
    // Safety rule: a job that may have mutated provider state is never retried
    // automatically, no matter how many attempts remain.
    if (failure.deadLetter || job.retryClass === "side_effecting" || exhausted) {
      job.status = "dead_letter";
    } else {
      job.status = "queued";
      job.runAt = failure.nextRunAt ?? backoffFrom(now, job.attempts);
    }
    job.updatedAt = now.toISOString();
    return clone(job);
  }

  async reclaimExpiredLeases(now: Date) {
    const nowMs = now.getTime();
    const reclaimed: JobRun[] = [];
    for (const job of this.rows.values()) {
      if (job.status !== "leased" || !job.leaseExpiresAt) continue;
      if (new Date(job.leaseExpiresAt).getTime() > nowMs) continue;
      job.status = "queued";
      job.runAt = now.toISOString();
      delete job.leaseOwner;
      delete job.leaseExpiresAt;
      job.updatedAt = now.toISOString();
      reclaimed.push(clone(job));
    }
    return reclaimed.sort(byCreatedThenId);
  }

  async countByStatus(tenantId?: string) {
    const counts = EMPTY_JOB_COUNTS();
    for (const job of this.rows.values()) {
      if (tenantId && job.tenantId !== tenantId) continue;
      counts[job.status] += 1;
    }
    return counts;
  }
}

/** Exponential backoff with a cap; deterministic so tests can assert it. */
export function backoffFrom(now: Date, attempts: number): string {
  const base = 1_000;
  const cap = 60_000;
  const delay = Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delay).toISOString();
}

export class InMemoryReconciliationStore implements ReconciliationStore {
  private readonly rows = new Map<string, Reconciliation>();

  private key(tenantId: string, dedupeKey: string) {
    return `${tenantId}::${dedupeKey}`;
  }

  async createIfAbsent(reconciliation: Reconciliation) {
    const key = this.key(reconciliation.tenantId, reconciliation.dedupeKey);
    const existing = [...this.rows.values()].find((r) => this.key(r.tenantId, r.dedupeKey) === key);
    if (existing) return { inserted: false, reconciliation: clone(existing) };
    this.rows.set(reconciliation.id, clone(reconciliation));
    return { inserted: true, reconciliation: clone(reconciliation) };
  }

  async get(tenantId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? clone(row) : undefined;
  }

  async list(
    tenantId: string,
    filter?: { status?: ReconciliationStatus; caseId?: string; jobRunId?: string },
    limit = 100,
  ) {
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => (filter?.status ? r.status === filter.status : true))
      .filter((r) => (filter?.caseId ? r.caseId === filter.caseId : true))
      .filter((r) => (filter?.jobRunId ? r.jobRunId === filter.jobRunId : true))
      .sort(byCreatedThenId)
      .slice(0, limit)
      .map(clone);
  }

  async decide(
    tenantId: string,
    id: string,
    decision: { status: "resolved" | "dismissed"; resolvedBy: string; resolution: string },
    expectedVersion: number,
    now: Date,
  ) {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) throw new GovernanceNotFoundError("reconciliation", id);
    if (row.version !== expectedVersion) {
      throw new GovernanceConflictError(
        `reconciliation "${id}" was modified (expected version ${expectedVersion}, found ${row.version})`,
        "reconciliation",
        id,
      );
    }
    if (row.status !== "open") {
      throw new GovernanceConflictError(
        `reconciliation "${id}" is already ${row.status}`,
        "reconciliation",
        id,
      );
    }
    row.status = decision.status;
    row.resolvedBy = decision.resolvedBy;
    row.resolution = decision.resolution;
    row.resolvedAt = now.toISOString();
    row.updatedAt = now.toISOString();
    row.version += 1;
    return clone(row);
  }

  async countOpen(tenantId?: string) {
    return [...this.rows.values()].filter(
      (r) => r.status === "open" && (tenantId ? r.tenantId === tenantId : true),
    ).length;
  }
}

export class InMemoryGovernedCaseStore implements GovernedCaseStore {
  private readonly rows = new Map<string, GovernedCase>();

  async createIfAbsent(case_: GovernedCase) {
    const existing = [...this.rows.values()].find(
      (c) => c.tenantId === case_.tenantId && c.idempotencyKey === case_.idempotencyKey,
    );
    if (existing) return { inserted: false, case: clone(existing) };
    if (this.rows.has(case_.id)) {
      throw new GovernanceConflictError(`case "${case_.id}" already exists`, "case", case_.id);
    }
    this.rows.set(case_.id, clone(case_));
    return { inserted: true, case: clone(case_) };
  }

  async get(tenantId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? clone(row) : undefined;
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    const row = [...this.rows.values()].find(
      (c) => c.tenantId === tenantId && c.idempotencyKey === idempotencyKey,
    );
    return row ? clone(row) : undefined;
  }

  async list(
    tenantId: string,
    filter?: { state?: GovernedCaseState; connectionId?: string; assignedTo?: string },
    limit = 100,
  ) {
    return [...this.rows.values()]
      .filter((c) => c.tenantId === tenantId)
      .filter((c) => (filter?.state ? c.state === filter.state : true))
      .filter((c) => (filter?.connectionId ? c.connectionId === filter.connectionId : true))
      .filter((c) => (filter?.assignedTo ? c.assignedTo === filter.assignedTo : true))
      .sort(byCreatedThenId)
      .slice(0, limit)
      .map(clone);
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
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) throw new GovernanceNotFoundError("case", id);
    if (row.version !== expectedVersion) {
      throw new GovernanceConflictError(
        `case "${id}" was modified (expected version ${expectedVersion}, found ${row.version})`,
        "case",
        id,
      );
    }
    assertTransition(row.state, next);
    Object.assign(row, patch);
    row.state = next;
    row.version += 1;
    row.updatedAt = now.toISOString();
    if (next === "resolved" && !row.closedAt) row.closedAt = now.toISOString();
    return clone(row);
  }
}

export class InMemoryGovernanceUsageStore implements GovernanceUsageStore {
  private readonly rows = new Map<string, GovernanceUsageEvent>();

  private key(tenantId: string, idempotencyKey: string) {
    return `${tenantId}::${idempotencyKey}`;
  }

  async recordIfAbsent(event: GovernanceUsageEvent) {
    const key = this.key(event.tenantId, event.idempotencyKey);
    if ([...this.rows.values()].some((r) => this.key(r.tenantId, r.idempotencyKey) === key)) {
      return false;
    }
    this.rows.set(event.id, clone(event));
    return true;
  }

  async list(
    tenantId: string,
    filter?: { kind?: GovernanceUsageKind; from?: string; to?: string },
    limit = 200,
  ) {
    return [...this.rows.values()]
      .filter((e) => e.tenantId === tenantId)
      .filter((e) => (filter?.kind ? e.kind === filter.kind : true))
      .filter((e) => (filter?.from ? e.occurredAt >= filter.from : true))
      .filter((e) => (filter?.to ? e.occurredAt < filter.to : true))
      .sort(byOccurredThenId)
      .slice(0, limit)
      .map(clone);
  }

  async sum(tenantId: string, kind?: GovernanceUsageKind) {
    return [...this.rows.values()]
      .filter((e) => e.tenantId === tenantId)
      .filter((e) => (kind ? e.kind === kind : true))
      .reduce((total, e) => total + e.quantity, 0);
  }
}

/** All in-memory stores wired together — the default local/dev bundle. */
export function inMemoryGovernanceStores(): GovernanceStores {
  return {
    organizations: new InMemoryOrganizationStore(),
    workspaces: new InMemoryWorkspaceStore(),
    memberships: new InMemoryMembershipStore(),
    connections: new InMemoryConnectionStore(),
    integrationEvents: new InMemoryIntegrationEventStore(),
    jobs: new InMemoryJobStore(),
    reconciliations: new InMemoryReconciliationStore(),
    cases: new InMemoryGovernedCaseStore(),
    usage: new InMemoryGovernanceUsageStore(),
  };
}
