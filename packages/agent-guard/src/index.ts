/**
 * @osas/agent-guard — a small gate in front of any support-agent write action.
 *
 *   model proposes -> policy decides -> (human approves) -> your executor runs
 *
 * Built only from @osas/policy-engine. No server, database or LLM call.
 * State (recent proposals, execution records) is in memory by default;
 * inject an ExecutionStore for anything that must survive a restart.
 */
import { randomUUID } from "node:crypto";
import {
  SPEC_VERSION,
  ACTION_TYPE_PROFILE,
  transitionProposal,
  type ActionProposal,
  type ActionType,
  type Evidence,
  type ExecutionResult,
  type Money,
  type Permission,
  type PolicyDecision,
  type RequestedBy,
  type TenantPolicy,
} from "@osas/core";
import {
  computeActionDigest,
  evaluateProposal,
  executeProposal,
  InMemoryExecutionStore,
  type ActionExecutor,
  type ExecutionStore,
} from "@osas/policy-engine";

export interface GuardOptions {
  /** Your write path. Only ever called for actions policy (and a human, if required) allowed. */
  executor: ActionExecutor;
  /** Policy for a tenant. Called on every proposal so policy changes apply immediately. */
  policyFor: (tenantId: string) => TenantPolicy | Promise<TenantPolicy>;
  /** Defaults to an in-memory store, which does not survive a restart. */
  executionStore?: ExecutionStore;
  /** How long a pending approval stays decidable. Default 24h. */
  approvalTtlSeconds?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Set when your input pipeline flags prompt injection; forces the engine's injection handling. */
  injectionSuspected?: (input: ProposeInput) => boolean;
}

export interface ProposeInput {
  tenantId: string;
  caseId: string;
  actionType: ActionType;
  reasonCode: string;
  params: Record<string, unknown>;
  amount?: Money;
  /** Evidence records you already hold. Ids must match what you cite in `evidenceIds`. */
  evidence?: Evidence[];
  /** Same action + same key is never executed twice. */
  idempotencyKey: string;
  requestedBy: RequestedBy;
  /** Defaults to "request-approval", the highest a model may ask for. */
  requestedPermission?: Permission;
}

export type GuardResult =
  | { outcome: "executed"; proposal: ActionProposal; decision: PolicyDecision; execution: ExecutionResult; replayed: boolean }
  | { outcome: "execution_failed"; proposal: ActionProposal; decision: PolicyDecision; execution: ExecutionResult }
  | { outcome: "needs_reconciliation"; proposal: ActionProposal; decision: PolicyDecision; execution: ExecutionResult }
  | { outcome: "pending_approval"; proposal: ActionProposal; decision: PolicyDecision; pending: PendingApproval }
  | { outcome: "blocked"; proposal: ActionProposal; decision: PolicyDecision };

/** What a human approver decides on. Hand `actionDigest` to them and back to `decide`. */
export interface PendingApproval {
  proposalId: string;
  tenantId: string;
  /** SHA-256 over { actionType, params, amount }. The approval authorizes exactly this. */
  actionDigest: string;
  expiresAt: string;
}

export type DecideResult =
  | { outcome: "rejected"; proposal: ActionProposal }
  | Extract<GuardResult, { outcome: "executed" | "execution_failed" | "needs_reconciliation" }>;

export class GuardError extends Error {
  constructor(
    readonly code: "UNKNOWN_PROPOSAL" | "NOT_PENDING" | "DIGEST_MISMATCH" | "APPROVAL_EXPIRED" | "APPROVER_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "GuardError";
  }
}

export interface AgentGuard {
  /** Evaluate, then execute / park for approval / block. Never throws for a policy outcome. */
  propose(input: ProposeInput): Promise<GuardResult>;
  /** Apply a human decision. `actionDigest` must be the one from the PendingApproval. */
  decide(
    pending: Pick<PendingApproval, "proposalId" | "tenantId" | "actionDigest">,
    decision: { approve: boolean; approverId: string },
  ): Promise<DecideResult>;
}

interface Held {
  proposal: ActionProposal;
  decision: PolicyDecision;
  actionDigest: string;
  expiresAt: Date;
}

export function createAgentGuard(options: GuardOptions): AgentGuard {
  const store = options.executionStore ?? new InMemoryExecutionStore();
  const clock = options.now ?? (() => new Date());
  const ttlMs = (options.approvalTtlSeconds ?? 86_400) * 1000;
  /** Proposals seen so far; feeds the engine's duplicate-window check. */
  const seen: ActionProposal[] = [];
  /** Proposals waiting on a human, keyed by `${tenantId}\u0000${proposalId}`. */
  const held = new Map<string, Held>();
  const key = (tenantId: string, id: string): string => `${tenantId}\u0000${id}`;

  const remember = (p: ActionProposal): void => {
    const i = seen.findIndex((s) => s.id === p.id);
    if (i >= 0) seen[i] = p;
    else seen.push(p);
  };

  async function run(
    proposal: ActionProposal,
    decision: PolicyDecision,
    actionDigest: string,
  ): Promise<Extract<GuardResult, { outcome: "executed" | "execution_failed" | "needs_reconciliation" }>> {
    const approved = transitionProposal(proposal, "approved");
    const out = await executeProposal(approved, options.executor, store, clock(), { actionDigest });
    remember(out.proposal);
    if (out.proposal.status === "executed") {
      return { outcome: "executed", proposal: out.proposal, decision, execution: out.execution, replayed: out.replayed };
    }
    if (out.proposal.status === "reconciliation_required") {
      return { outcome: "needs_reconciliation", proposal: out.proposal, decision, execution: out.execution };
    }
    return { outcome: "execution_failed", proposal: out.proposal, decision, execution: out.execution };
  }

  return {
    async propose(input) {
      const now = clock();
      const iso = now.toISOString();
      const policy = await options.policyFor(input.tenantId);
      const base: ActionProposal = {
        id: `prop_${randomUUID()}`,
        specVersion: SPEC_VERSION,
        tenantId: input.tenantId,
        caseId: input.caseId,
        profile: ACTION_TYPE_PROFILE[input.actionType],
        actionType: input.actionType,
        reasonCode: input.reasonCode,
        params: input.params,
        requestedPermission: input.requestedPermission ?? "request-approval",
        requestedBy: input.requestedBy,
        ...(input.amount ? { amount: input.amount } : {}),
        evidenceIds: (input.evidence ?? []).map((e) => e.id),
        idempotencyKey: input.idempotencyKey,
        status: "proposed",
        createdAt: iso,
        updatedAt: iso,
      };
      const decision = evaluateProposal(base, {
        policy,
        evidence: (input.evidence ?? []).filter((e) => e.tenantId === input.tenantId),
        recentProposals: seen.filter((s) => s.tenantId === input.tenantId),
        injectionSuspected: options.injectionSuspected?.(input) ?? false,
        now,
      });
      const proposal: ActionProposal = { ...base, policyDecision: decision };
      const actionDigest = computeActionDigest(proposal);

      if (decision.decision === "block") {
        const blocked = transitionProposal(proposal, "policy_rejected");
        remember(blocked);
        return { outcome: "blocked", proposal: blocked, decision };
      }
      if (decision.decision === "require_approval") {
        const pendingProposal = transitionProposal(proposal, "pending_approval");
        remember(pendingProposal);
        const expiresAt = new Date(now.getTime() + ttlMs);
        held.set(key(input.tenantId, pendingProposal.id), {
          proposal: pendingProposal,
          decision,
          actionDigest,
          expiresAt,
        });
        return {
          outcome: "pending_approval",
          proposal: pendingProposal,
          decision,
          pending: {
            proposalId: pendingProposal.id,
            tenantId: pendingProposal.tenantId,
            actionDigest,
            expiresAt: expiresAt.toISOString(),
          },
        };
      }
      // auto_execute: still bound to the digest of exactly what was evaluated.
      return run(proposal, decision, actionDigest);
    },

    async decide(pending, decision) {
      if (!decision.approverId.trim()) {
        throw new GuardError("APPROVER_REQUIRED", "approverId is required");
      }
      const k = key(pending.tenantId, pending.proposalId);
      const entry = held.get(k);
      if (!entry) {
        throw new GuardError("UNKNOWN_PROPOSAL", "no pending approval for this tenant and proposal");
      }
      if (entry.actionDigest !== pending.actionDigest) {
        throw new GuardError("DIGEST_MISMATCH", "the digest does not match the action held for approval");
      }
      // Decided once: remove before doing anything else so a second call cannot repeat it.
      held.delete(k);
      if (clock().getTime() > entry.expiresAt.getTime()) {
        throw new GuardError("APPROVAL_EXPIRED", "the approval window has passed; propose again");
      }
      if (!decision.approve) {
        const rejected = transitionProposal(entry.proposal, "rejected");
        remember(rejected);
        return { outcome: "rejected", proposal: rejected };
      }
      return run(entry.proposal, entry.decision, entry.actionDigest);
    },
  };
}

export { computeActionDigest } from "@osas/policy-engine";
export type { ActionExecutor, ExecutionStore } from "@osas/policy-engine";
