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
 * Storage ports for the governance plane (M0).
 *
 * Every port is tenant-scoped except the organization/workspace stores, which
 * define the tenant boundary itself. Two rules hold for all implementations,
 * in-memory and PostgreSQL alike:
 *
 * 1. A read for tenant A never returns a record of tenant B — not by filter,
 *    not by id collision, not by error message.
 * 2. State changes that matter (connections, cases, jobs, events,
 *    reconciliations) are compare-and-set or idempotent-insert. Callers must
 *    pass the version they read.
 */

export interface OrganizationStore {
  createIfAbsent(org: Organization): Promise<{ inserted: boolean; organization: Organization }>;
  get(id: string): Promise<Organization | undefined>;
  list(): Promise<Organization[]>;
  update(
    id: string,
    patch: { name?: string; status?: Organization["status"] },
    expectedVersion: number,
  ): Promise<Organization>;
}

export interface WorkspaceStore {
  createIfAbsent(ws: Workspace): Promise<{ inserted: boolean; workspace: Workspace }>;
  get(id: string): Promise<Workspace | undefined>;
  getByTenantId(tenantId: string): Promise<Workspace | undefined>;
  listByOrganization(organizationId: string): Promise<Workspace[]>;
  update(
    id: string,
    patch: { name?: string; status?: Workspace["status"] },
    expectedVersion: number,
  ): Promise<Workspace>;
}

export interface MembershipStore {
  /** Idempotent on (principalId, organizationId, workspaceId). */
  put(membership: Membership): Promise<Membership>;
  listByPrincipal(principalId: string): Promise<Membership[]>;
  listByOrganization(organizationId: string): Promise<Membership[]>;
  remove(principalId: string, organizationId: string, workspaceId?: string): Promise<boolean>;
}

export interface ConnectionStore {
  createIfAbsent(connection: Connection): Promise<{ inserted: boolean; connection: Connection }>;
  get(tenantId: string, id: string): Promise<Connection | undefined>;
  list(tenantId: string, filter?: { status?: Connection["status"]; provider?: string }): Promise<Connection[]>;
  update(
    tenantId: string,
    id: string,
    patch: ConnectionPatch,
    expectedVersion: number,
  ): Promise<Connection>;
  /** Hard delete. Callers must have revoked the connection first. */
  remove(tenantId: string, id: string): Promise<boolean>;
}

export interface IntegrationEventStore {
  /**
   * Insert unless (tenantId, connectionId, topic, externalEventId) exists.
   * On conflict the EXISTING record is returned so a caller can report a
   * duplicate without inventing a second row.
   */
  insertIfAbsent(event: IntegrationEvent): Promise<{ inserted: boolean; event: IntegrationEvent }>;
  get(tenantId: string, id: string): Promise<IntegrationEvent | undefined>;
  list(
    tenantId: string,
    filter?: { connectionId?: string; status?: IntegrationEventStatus; topic?: string },
    limit?: number,
  ): Promise<IntegrationEvent[]>;
  markStatus(
    tenantId: string,
    id: string,
    status: IntegrationEventStatus,
    error?: { code: string; message: string },
  ): Promise<IntegrationEvent>;
  /**
   * Highest provider timestamp already accepted for this connection — the
   * watermark used to detect out-of-order delivery.
   */
  acceptedWatermark(tenantId: string, connectionId: string): Promise<string | undefined>;
  /** Exact counts per status — a control-plane overview must not guess. */
  countByStatus(tenantId: string): Promise<Record<IntegrationEventStatus, number>>;
}

export interface JobClaimInput {
  owner: string;
  now: Date;
  leaseMs: number;
  limit: number;
  /** Omit to claim across tenants (worker role). */
  tenantId?: string;
  /**
   * Only claim kinds this worker can actually handle. A queued job with no
   * registered handler stays visible in the queue instead of being claimed and
   * destroyed.
   */
  kinds?: readonly JobKind[];
}

export interface JobStore {
  create(job: JobRun): Promise<JobRun>;
  get(tenantId: string, id: string): Promise<JobRun | undefined>;
  list(
    tenantId: string,
    filter?: { status?: JobStatus; kind?: JobKind },
    limit?: number,
  ): Promise<JobRun[]>;
  /** Lease up to `limit` claimable jobs. Claiming is atomic per job. */
  claim(input: JobClaimInput): Promise<JobRun[]>;
  complete(tenantId: string, id: string, result: Record<string, unknown>, now: Date): Promise<JobRun>;
  /**
   * Apply the retry decision: back to "queued" with a new runAt, or to
   * "dead_letter". Side-effecting jobs never return to "queued".
   */
  fail(tenantId: string, id: string, failure: JobFailure, now: Date): Promise<JobRun>;
  /**
   * Return jobs whose lease expired to "queued" (worker crash recovery).
   * Returns the reclaimed jobs so the caller can route an unknown outcome of a
   * side-effecting job to reconciliation instead of silently retrying it.
   */
  reclaimExpiredLeases(now: Date): Promise<JobRun[]>;
  countByStatus(tenantId?: string): Promise<Record<JobStatus, number>>;
}

export interface ReconciliationStore {
  /** Idempotent on (tenantId, dedupeKey). */
  createIfAbsent(
    reconciliation: Reconciliation,
  ): Promise<{ inserted: boolean; reconciliation: Reconciliation }>;
  get(tenantId: string, id: string): Promise<Reconciliation | undefined>;
  list(
    tenantId: string,
    filter?: { status?: ReconciliationStatus; caseId?: string; jobRunId?: string },
    limit?: number,
  ): Promise<Reconciliation[]>;
  decide(
    tenantId: string,
    id: string,
    decision: { status: Extract<ReconciliationStatus, "resolved" | "dismissed">; resolvedBy: string; resolution: string },
    expectedVersion: number,
    now: Date,
  ): Promise<Reconciliation>;
  countOpen(tenantId?: string): Promise<number>;
}

export interface GovernedCaseStore {
  /** Idempotent on (tenantId, idempotencyKey). */
  createIfAbsent(case_: GovernedCase): Promise<{ inserted: boolean; case: GovernedCase }>;
  get(tenantId: string, id: string): Promise<GovernedCase | undefined>;
  findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<GovernedCase | undefined>;
  list(
    tenantId: string,
    filter?: { state?: GovernedCaseState; connectionId?: string; assignedTo?: string },
    limit?: number,
  ): Promise<GovernedCase[]>;
  /** Compare-and-set transition; stale version -> GovernanceConflictError. */
  transition(
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
  ): Promise<GovernedCase>;
}

export interface GovernanceUsageStore {
  /** Idempotent on (tenantId, idempotencyKey). Returns false when replayed. */
  recordIfAbsent(event: GovernanceUsageEvent): Promise<boolean>;
  list(
    tenantId: string,
    filter?: { kind?: GovernanceUsageKind; from?: string; to?: string },
    limit?: number,
  ): Promise<GovernanceUsageEvent[]>;
  sum(tenantId: string, kind?: GovernanceUsageKind): Promise<number>;
}

/** Every store the governance runtime needs, in one bundle. */
export interface GovernanceStores {
  organizations: OrganizationStore;
  workspaces: WorkspaceStore;
  memberships: MembershipStore;
  connections: ConnectionStore;
  integrationEvents: IntegrationEventStore;
  jobs: JobStore;
  reconciliations: ReconciliationStore;
  cases: GovernedCaseStore;
  usage: GovernanceUsageStore;
}
