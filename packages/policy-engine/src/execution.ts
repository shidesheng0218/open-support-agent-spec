import {
  transitionProposal,
  type ActionProposal,
  type ExecutionResult,
  type ProposalStatus,
} from "@osas/core";

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

/** §5: executions keyed by (tenantId, idempotencyKey). Async since Milestone 2 (Postgres backends). */
export interface ExecutionStore {
  get(tenantId: string, idempotencyKey: string): Promise<StoredExecution | undefined>;
  put(record: StoredExecution): Promise<void>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly map = new Map<string, StoredExecution>();

  private static key(tenantId: string, idempotencyKey: string): string {
    return `${tenantId} ${idempotencyKey}`;
  }

  async get(tenantId: string, idempotencyKey: string): Promise<StoredExecution | undefined> {
    return this.map.get(InMemoryExecutionStore.key(tenantId, idempotencyKey));
  }

  async put(record: StoredExecution): Promise<void> {
    this.map.set(
      InMemoryExecutionStore.key(record.tenantId, record.idempotencyKey),
      record,
    );
  }

  /** Conformance Mode (Milestone 4, test-only): wipe all execution records. */
  reset(): void {
    this.map.clear();
  }
}

export class ExecutionStatusError extends Error {
  readonly code = "EXECUTION_STATUS_GUARD";
  constructor(status: ProposalStatus) {
    super(`executeProposal requires status 'approved'; got '${status}'`);
    this.name = "ExecutionStatusError";
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
 * - Status guard: proposal must be `approved`, otherwise throws
 *   {@link ExecutionStatusError} (API maps to 409).
 * - Transitions: approved → executing → executed | failed |
 *   reconciliation_required. Uncertain outcomes are NEVER auto-retried.
 */
export async function executeProposal(
  proposal: ActionProposal,
  adapter: ActionExecutor,
  store: ExecutionStore,
  now: Date = new Date(),
): Promise<ExecuteOutcome> {
  const prior = await store.get(proposal.tenantId, proposal.idempotencyKey);
  if (prior) {
    return { proposal, execution: prior.result, replayed: true };
  }

  if (proposal.status !== "approved") {
    throw new ExecutionStatusError(proposal.status);
  }

  const executing = transitionProposal(proposal, "executing");
  const result = await adapter.executeAction(
    { tenantId: proposal.tenantId },
    executing,
  );

  switch (result.status) {
    case "succeeded": {
      const executed = transitionProposal(executing, "executed");
      await store.put({
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
      await store.put({
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
      // Never auto-retry: park in reconciliation_required and do NOT store a
      // completed execution (a later reconcile() resolves the proposal; the
      // idempotency key only guards terminal adapter outcomes).
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
