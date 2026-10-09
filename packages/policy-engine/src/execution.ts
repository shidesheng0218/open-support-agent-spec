import {
  NEVER_AUTO_EXECUTE_ACTION_TYPES,
  transitionProposal,
  type ActionProposal,
  type ExecutionResult,
  type ProposalStatus,
} from "@osas/core";
import { assertActionBinding, type ActionBinding } from "./action-binding.js";
import { applyParamTransforms } from "./param-transforms.js";

/**
 * Minimal structural interface for the execution side of a SupportAdapter
 * (CONTRACTS.md §5–§6). Avoids a hard dependency on `@osas/adapter`; any
 * object with a compatible `executeAction` satisfies it.
 */
export interface ActionExecutor {
  executeAction(
    ctx: ActionExecutorContext,
    proposal: ActionProposal,
  ): Promise<ExecutionResult>;
}

export interface ActionExecutorContext {
  tenantId: string;
}

export interface StoredExecution {
  tenantId: string;
  idempotencyKey: string;
  proposalId: string;
  /** Terminal proposal status the execution produced. */
  status: Extract<ProposalStatus, "executed" | "failed">;
  result: ExecutionResult;
  completedAt: string;
}

/** Outcome of atomically reserving an execution slot (see ExecutionStore.claim). */
export type ExecutionClaim =
  | { outcome: "claimed" }
  | { outcome: "in_flight" }
  | { outcome: "completed"; record: StoredExecution };

/** §5: executions keyed by (tenantId, idempotencyKey). Async since Milestone 2 (Postgres backends). */
export interface ExecutionStore {
  get(tenantId: string, idempotencyKey: string): Promise<StoredExecution | undefined>;
  put(record: StoredExecution): Promise<void>;
  /**
   * Atomically reserve the (tenantId, idempotencyKey) slot BEFORE the adapter
   * call, so two concurrent attempts — or a retry after a crash or a failed
   * terminal write — cannot both reach the provider. Implement together with
   * `finalize`; durable backends (e.g. a primary-keyed row committed on its
   * own connection) are the point of the hook. Stores without it keep the
   * legacy replay-guarded behaviour.
   */
  claim?(tenantId: string, idempotencyKey: string, proposalId: string): Promise<ExecutionClaim>;
  /**
   * Write the terminal record for a slot reserved with `claim`: updates the
   * pending row in place so the store's own uniqueness constraint cannot
   * suppress the outcome. Falls back to `put` when absent.
   */
  finalize?(record: StoredExecution): Promise<void>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly map = new Map<string, StoredExecution>();
  /** Slots claimed but not yet finalized (in flight or parked uncertain). */
  private readonly inFlight = new Set<string>();

  private static key(tenantId: string, idempotencyKey: string): string {
    return `${tenantId} ${idempotencyKey}`;
  }

  async get(tenantId: string, idempotencyKey: string): Promise<StoredExecution | undefined> {
    return this.map.get(InMemoryExecutionStore.key(tenantId, idempotencyKey));
  }

  async claim(tenantId: string, idempotencyKey: string): Promise<ExecutionClaim> {
    const key = InMemoryExecutionStore.key(tenantId, idempotencyKey);
    const done = this.map.get(key);
    if (done) return { outcome: "completed", record: done };
    if (this.inFlight.has(key)) return { outcome: "in_flight" };
    this.inFlight.add(key);
    return { outcome: "claimed" };
  }

  async put(record: StoredExecution): Promise<void> {
    const key = InMemoryExecutionStore.key(record.tenantId, record.idempotencyKey);
    this.map.set(key, record);
    this.inFlight.delete(key);
  }

  async finalize(record: StoredExecution): Promise<void> {
    await this.put(record);
  }

  /** Conformance Mode (Milestone 4, test-only): wipe all execution records. */
  reset(): void {
    this.map.clear();
    this.inFlight.clear();
  }
}

export class ExecutionStatusError extends Error {
  readonly code = "EXECUTION_STATUS_GUARD";
  constructor(status: ProposalStatus) {
    super(`executeProposal requires status 'approved'; got '${status}'`);
    this.name = "ExecutionStatusError";
  }
}

/**
 * Thrown when executeProposal is asked to execute an actionType that is never
 * model-executed (NEVER_AUTO_EXECUTE_ACTION_TYPES, e.g. exchange_request).
 * Fail closed: no status transition, no adapter call, regardless of approval.
 */
export class NonExecutableActionError extends Error {
  readonly code = "ACTION_NOT_EXECUTABLE";
  constructor(actionType: string) {
    super(
      `actionType '${actionType}' is never executed by the policy engine; fulfillment is human-only after approval`,
    );
    this.name = "NonExecutableActionError";
  }
}

export class ReconcileStatusError extends Error {
  readonly code = "RECONCILE_STATUS_GUARD";
  constructor(status: ProposalStatus) {
    super(
      `reconcile requires status 'reconciliation_required'; got '${status}'`,
    );
    this.name = "ReconcileStatusError";
  }
}

/**
 * Thrown when a concurrent attempt for the same (tenantId, idempotencyKey)
 * finds the slot already claimed. Fail closed: the holder may already have a
 * provider side effect, so a second attempt must not start.
 */
export class ExecutionInFlightError extends Error {
  readonly code = "EXECUTION_IN_FLIGHT";
  constructor(tenantId: string, idempotencyKey: string) {
    super(
      `execution (${tenantId}, ${idempotencyKey}) is already in flight; ` +
        "refusing a concurrent attempt — reconcile the parked proposal instead of retrying",
    );
    this.name = "ExecutionInFlightError";
  }
}

export interface ExecuteOutcome {
  proposal: ActionProposal;
  execution: ExecutionResult;
  replayed: boolean;
}

/**
 * CONTRACTS.md §5 — execute an approved proposal through the adapter with
 * idempotent replay protection.
 *
 * - Replay: if (tenantId, idempotencyKey) already completed, returns the
 *   stored result with `replayed: true` and never calls the adapter.
 * - Claimed slot: when the store supports `claim`/`finalize`, the engine
 *   atomically reserves (tenantId, idempotencyKey) BEFORE the adapter call.
 *   A concurrent attempt — or a retry after a crash or a failed terminal
 *   write — is refused with {@link ExecutionInFlightError} (409
 *   `EXECUTION_IN_FLIGHT`) instead of reaching the provider again.
 * - Status guard: proposal must be `approved`, otherwise throws
 *   {@link ExecutionStatusError} (API maps to 409).
 * - Action binding (RFC 0008): when `binding.actionDigest` is supplied, the
 *   proposal's `{ actionType, params, amount? }` must hash to it, otherwise
 *   throws {@link ActionBindingMismatchError} before any transition or adapter
 *   call.
 * - Transitions: approved → executing → executed | failed |
 *   reconciliation_required. Uncertain outcomes are NEVER auto-retried and
 *   leave the claimed slot in place.
 * - §4 step 11: `proposal.policyDecision.transforms` (e.g. redaction) are
 *   applied to a deep clone of params before the adapter call, so policy-
 *   decided rewrites are enforced at the execution boundary for every
 *   embedding, not just the OSAS API server.
 */
export async function executeProposal(
  proposal: ActionProposal,
  adapter: ActionExecutor,
  store: ExecutionStore,
  now: Date = new Date(),
  binding?: ActionBinding,
): Promise<ExecuteOutcome> {
  // Fail closed: some actionTypes (exchange_request) are never executed, even
  // with an approval on record. Checked before replay and status guards.
  if (NEVER_AUTO_EXECUTE_ACTION_TYPES.includes(proposal.actionType)) {
    throw new NonExecutableActionError(proposal.actionType);
  }

  const prior = await store.get(proposal.tenantId, proposal.idempotencyKey);
  if (prior) {
    return { proposal, execution: prior.result, replayed: true };
  }

  if (proposal.status !== "approved") {
    throw new ExecutionStatusError(proposal.status);
  }

  // RFC 0008: an approval authorizes an exact action, not a proposal reference.
  // The digest covers the pre-transform input — what the approver saw.
  assertActionBinding(proposal, binding);

  // §5 atomic slot: reserve (tenantId, idempotencyKey) BEFORE the adapter call
  // so a concurrent or post-crash attempt cannot reach the provider twice.
  // Stores without `claim` keep the legacy replay-guarded behaviour.
  if (store.claim) {
    const claim = await store.claim(
      proposal.tenantId,
      proposal.idempotencyKey,
      proposal.id,
    );
    if (claim.outcome === "completed") {
      // Lost the race to a finished execution: replay it, zero side effects.
      return { proposal, execution: claim.record.result, replayed: true };
    }
    if (claim.outcome === "in_flight") {
      throw new ExecutionInFlightError(proposal.tenantId, proposal.idempotencyKey);
    }
  }

  const executing = transitionProposal(proposal, "executing");
  // §4 step 11: the decision's transforms (e.g. PII redaction) are applied by
  // the engine itself, deterministically, so the adapter NEVER sees raw params
  // when policy decided a rewrite. Redaction replaces the value at `path` with
  // `replacement ?? "***"`; unmatched paths are a no-op (see param-transforms.ts).
  const { params } = applyParamTransforms(
    proposal.params,
    proposal.policyDecision?.transforms,
  );
  const result = await adapter.executeAction(
    { tenantId: proposal.tenantId },
    { ...executing, params },
  );

  // Terminal writes finalize the claimed slot in place when the store supports
  // it; `put` keeps claim-less stores working.
  const settle = store.finalize ? store.finalize.bind(store) : store.put.bind(store);
  switch (result.status) {
    case "succeeded": {
      const executed = transitionProposal(executing, "executed");
      await settle({
        tenantId: proposal.tenantId,
        idempotencyKey: proposal.idempotencyKey,
        proposalId: proposal.id,
        status: "executed",
        result,
        completedAt: now.toISOString(),
      });
      return { proposal: executed, execution: result, replayed: false };
    }
    case "failed": {
      const failed = transitionProposal(executing, "failed");
      await settle({
        tenantId: proposal.tenantId,
        idempotencyKey: proposal.idempotencyKey,
        proposalId: proposal.id,
        status: "failed",
        result,
        completedAt: now.toISOString(),
      });
      return { proposal: failed, execution: result, replayed: false };
    }
    case "uncertain": {
      // Never auto-retry: park in reconciliation_required and leave the slot
      // claimed, so a same-key re-attempt is refused (EXECUTION_IN_FLIGHT)
      // rather than re-reaching the provider. Retries are new proposals with
      // new idempotency keys (spec §3.2); reconciliation resolves this one.
      const parked = transitionProposal(executing, "reconciliation_required");
      return { proposal: parked, execution: result, replayed: false };
    }
  }
}

/**
 * CONTRACTS.md §5 — resolve a proposal parked in `reconciliation_required`
 * with a human/system-determined outcome. Throws unless the proposal is in
 * `reconciliation_required`.
 */
export function reconcile(
  proposal: ActionProposal,
  outcome: "succeeded" | "failed",
): ActionProposal {
  if (proposal.status !== "reconciliation_required") {
    throw new ReconcileStatusError(proposal.status);
  }
  return transitionProposal(
    proposal,
    outcome === "succeeded" ? "executed" : "failed",
  );
}
