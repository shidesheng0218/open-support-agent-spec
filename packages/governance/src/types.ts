/**
 * OSAS governance control-plane domain model (M0).
 *
 * These records are APPLICATION-layer. They are deliberately provider-neutral:
 * nothing in this file may mention a specific vendor's payload shape. Vendor
 * fields live in adapters and in the opaque payload snapshots carried by
 * IntegrationEvent / Connection, never in the core contract.
 *
 * Layering (see docs/adr/0001-platform-scope.md):
 *   OSAS Spec  ->  Governance Runtime (this package)  ->  Adapters  ->  Control Plane
 *
 * Two invariants hold everywhere in this package:
 *
 * 1. **No secret ever lands in a record.** Connections store an opaque
 *    credential *reference* (a key-manager pointer), never the token itself.
 *    ConnectionService fails closed when a caller passes something that looks
 *    like a raw credential.
 * 2. **Governance roles never widen the adapter permission ladder.** A
 *    governance role gates control-plane operations only. It can never grant
 *    "execute" on a SupportAdapter; see roles.ts.
 */

/** Every governance record carries the spec version it was written against. */
export const GOVERNANCE_SPEC_VERSION = "0.2" as const;
export type GovernanceSpecVersion = typeof GOVERNANCE_SPEC_VERSION;

/* ------------------------------------------------------------------ *
 * Identity: Organization -> Workspace -> Membership
 * ------------------------------------------------------------------ */

export type OrganizationStatus = "active" | "suspended";

export interface Organization {
  id: string;
  specVersion: GovernanceSpecVersion;
  name: string;
  status: OrganizationStatus;
  /** Optimistic-concurrency version; every update must carry it. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceStatus = "active" | "suspended" | "archived";

/**
 * A Workspace is the unit of tenant isolation.
 *
 * `tenantId` is the OSAS tenant scope consumed by every existing
 * tenant-scoped store (policy, audit, execution, usage, after-sales). A
 * workspace owns exactly one tenant; a tenant belongs to exactly one
 * workspace. That 1:1 mapping is what lets the governance plane sit on top of
 * the v0.2 runtime without rewriting it.
 */
export interface Workspace {
  id: string;
  specVersion: GovernanceSpecVersion;
  organizationId: string;
  tenantId: string;
  name: string;
  status: WorkspaceStatus;
  /** Optimistic-concurrency version; every update must carry it. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Role bindings. `workspaceId` absent means the binding applies to every
 * workspace in the organization.
 */
export interface Membership {
  id: string;
  specVersion: GovernanceSpecVersion;
  organizationId: string;
  workspaceId?: string;
  principalId: string;
  role: GovernanceRole;
  createdBy: string;
  createdAt: string;
}

export type GovernanceRole =
  | "owner"
  | "admin"
  | "operator"
  | "approver"
  | "auditor"
  | "viewer";

/**
 * Control-plane capabilities. Names are resource:action so a denial is always
 * explainable. This list intentionally has no "execution" capability: running
 * an approved action stays behind the adapter's own permission ladder and the
 * policy engine, reachable only by the server-internal system principal.
 */
export type GovernanceCapability =
  | "organization:read"
  | "organization:write"
  | "workspace:read"
  | "workspace:write"
  | "member:read"
  | "member:write"
  | "connection:read"
  | "connection:write"
  | "connection:rotate"
  | "case:read"
  | "case:write"
  | "event:read"
  | "event:write"
  | "job:read"
  | "job:operate"
  | "approval:read"
  | "approval:decide"
  | "reconciliation:read"
  | "reconciliation:resolve"
  | "audit:read"
  | "usage:read";

/* ------------------------------------------------------------------ *
 * Connection lifecycle
 * ------------------------------------------------------------------ */

export type ConnectionStatus = "active" | "paused" | "revoked" | "error";

/**
 * A connection is a tenant-scoped link to one external account.
 *
 * Capabilities are the *declared, server-side* set of actions the connection
 * may perform. Read and write capabilities are separate strings so a
 * read-only integration cannot be escalated by configuration alone.
 */
export interface Connection {
  id: string;
  specVersion: GovernanceSpecVersion;
  tenantId: string;
  /** Free-form provider key, e.g. "shopify", "zendesk", "mock". */
  provider: string;
  /** Provider-side account identity (shop domain, subdomain, account id). */
  externalAccountId: string;
  displayName: string;
  status: ConnectionStatus;
  capabilities: string[];
  /** Declared OAuth scopes or API permissions, for audit and drift checks. */
  scopes: string[];
  apiVersion?: string;
  /**
   * Opaque pointer into a secret manager. NEVER the credential itself.
   * ConnectionService rejects values that look like raw secrets.
   */
  credentialRef?: string;
  lastVerifiedAt?: string;
  lastErrorAt?: string;
  lastErrorCode?: string;
  /** Optimistic-concurrency version; every update must carry it. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export type ConnectionPatch = Partial<
  Pick<
    Connection,
    | "displayName"
    | "status"
    | "capabilities"
    | "scopes"
    | "apiVersion"
    | "credentialRef"
    | "lastVerifiedAt"
    | "lastErrorAt"
    | "lastErrorCode"
    | "revokedAt"
  >
>;

/* ------------------------------------------------------------------ *
 * Reliable events: inbox -> job -> reconciliation
 * ------------------------------------------------------------------ */

export type IntegrationEventStatus =
  | "received"
  | "processing"
  | "processed"
  | "duplicate"
  | "failed"
  | "stale_ignored";

/**
 * Inbox record for one externally delivered event (webhook, poll result,
 * provider callback).
 *
 * Deduplication is provider-authoritative: the tuple
 * (tenantId, connectionId, topic, externalEventId) is unique. Replays are
 * recorded as "duplicate" and never produce a second job.
 */
export interface IntegrationEvent {
  id: string;
  specVersion: GovernanceSpecVersion;
  tenantId: string;
  connectionId: string;
  provider: string;
  topic: string;
  /** Provider's own event id; the dedupe key with connectionId + topic. */
  externalEventId: string;
  /** Provider time. Ordering decisions use this, never the receipt time. */
  occurredAt: string;
  receivedAt: string;
  status: IntegrationEventStatus;
  /** Opaque, sanitized provider payload snapshot. */
  payload: Record<string, unknown>;
  /** False for unsigned/unknown topics; such events must not be acted on. */
  signatureVerified: boolean;
  attempts: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface IntegrationEventInput {
  tenantId: string;
  connectionId: string;
  topic: string;
  externalEventId: string;
  occurredAt: string;
  payload?: Record<string, unknown>;
  signatureVerified: boolean;
}

export interface IntegrationEventIntakeResult {
  /** "accepted" enqueues work; "duplicate"/"out_of_order" never do. */
  outcome: "accepted" | "duplicate" | "out_of_order";
  event: IntegrationEvent;
  jobRunId?: string;
  reconciliationId?: string;
}

export type JobKind =
  | "integration_event.process"
  | "connection.verify"
  | "reconciliation.refetch";

/**
 * Job lifecycle. Note there is no "failed" resting state: a failure either
 * returns to "queued" for a permitted retry or ends in "dead_letter". That
 * makes "is this still going to happen?" answerable from the status alone.
 */
export type JobStatus =
  | "queued"
  | "leased"
  | "succeeded"
  | "dead_letter"
  | "cancelled";

/**
 * Retry classification is a safety property, not a tuning knob.
 *
 * - safe_read: idempotent reads may be retried within maxAttempts.
 * - side_effecting: anything that may have mutated provider state is NEVER
 *   retried automatically. A failure opens a reconciliation instead, because
 *   "probably worked" is exactly the state OSAS refuses to guess at.
 */
export type JobRetryClass = "safe_read" | "side_effecting";

export interface JobRun {
  id: string;
  specVersion: GovernanceSpecVersion;
  tenantId: string;
  kind: JobKind;
  status: JobStatus;
  retryClass: JobRetryClass;
  attempts: number;
  maxAttempts: number;
  /** Earliest time a worker may claim this job (backoff / retry-after). */
  runAt: string;
  /** Hard deadline; past it the job stops being claimable. */
  deadlineAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the job produced or joined a reconciliation. */
  reconciliationId?: string;
}

export interface JobFailure {
  errorCode: string;
  errorMessage: string;
  /**
   * Force dead-lettering regardless of retry class or remaining attempts.
   * Used for configuration faults (no handler registered for a claimed job),
   * which retrying can never fix.
   */
  deadLetter?: boolean;
  /** Absolute time the next attempt becomes claimable. */
  nextRunAt?: string;
  /** Absolute time the job becomes unclaimable. */
  deadlineAt?: string;
}

export type ReconciliationReason =
  | "unknown_outcome"
  | "out_of_order_event"
  | "provider_error"
  | "manual";

export type ReconciliationStatus = "open" | "resolved" | "dismissed";

/**
 * A reconciliation is the ONLY allowed endpoint for an uncertain outcome.
 * It is created by the runtime, never by a model or an external caller.
 */
export interface Reconciliation {
  id: string;
  specVersion: GovernanceSpecVersion;
  tenantId: string;
  reason: ReconciliationReason;
  status: ReconciliationStatus;
  /**
   * Stable dedupe key so the same uncertainty never opens a second record
   * (e.g. "job:<id>" or "idem:<tenant>:<key>").
   */
  dedupeKey: string;
  jobRunId?: string;
  connectionId?: string;
  caseId?: string;
  proposalId?: string;
  idempotencyKey?: string;
  detail: Record<string, unknown>;
  resolvedBy?: string;
  resolution?: string;
  /** Optimistic-concurrency version; decision is compare-and-set. */
  version: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

/* ------------------------------------------------------------------ *
 * Governed case
 * ------------------------------------------------------------------ */

export const GOVERNED_CASE_STATES = [
  "intake",
  "evidence_required",
  "proposed",
  "pending_approval",
  "executing",
  "reconciliation_required",
  "resolved",
  "blocked",
] as const;

export type GovernedCaseState = (typeof GOVERNED_CASE_STATES)[number];

export type CasePriority = "low" | "normal" | "high" | "urgent";

/**
 * Provider-neutral case record. It is the join point between the governance
 * plane and the v0.2 runtime: evidenceIds / proposalIds / approvalIds point at
 * the existing OSAS records, while externalCaseId points at the provider.
 */
export interface GovernedCase {
  id: string;
  specVersion: GovernanceSpecVersion;
  tenantId: string;
  connectionId?: string;
  externalCaseId?: string;
  subject: string;
  state: GovernedCaseState;
  priority: CasePriority;
  /** Idempotency key: one live case per (tenantId, idempotencyKey). */
  idempotencyKey: string;
  assignedTo?: string;
  evidenceIds: string[];
  proposalIds: string[];
  approvalIds: string[];
  executionAttemptIds: string[];
  reconciliationIds: string[];
  /** Optimistic-concurrency version; transitions are compare-and-set. */
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

/* ------------------------------------------------------------------ *
 * Control-plane usage metering
 * ------------------------------------------------------------------ */

export type GovernanceUsageKind =
  | "case_intake"
  | "proposal_created"
  | "approval_decided"
  | "execution_attempted"
  | "reconciliation_opened";

/**
 * Control-plane metering. Deliberately coarse and explainable: it counts
 * governed objects, never tokens. Recording is idempotent on
 * (tenantId, idempotencyKey).
 */
export interface GovernanceUsageEvent {
  id: string;
  specVersion: GovernanceSpecVersion;
  tenantId: string;
  kind: GovernanceUsageKind;
  quantity: number;
  idempotencyKey: string;
  connectionId?: string;
  caseId?: string;
  occurredAt: string;
}
