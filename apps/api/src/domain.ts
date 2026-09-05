import type { SupportAdapter, ToolContext } from "@osas/adapter";
import type {
  ActionProposal,
  Approval,
  AuditEvent,
  AuditEventType,
  Evidence,
  ExecutionResult,
  HandoffReason,
  HumanHandoff,
  PolicyDecision,
} from "@osas/core";
import { detectInjection } from "@osas/core";
import { evaluateProposal, executeProposal, reconcile } from "@osas/policy-engine";
import type { ExecutionStore } from "@osas/policy-engine";
import { ConflictError } from "./plugins.js";

type AuditInput = Omit<AuditEvent, "id" | "specVersion" | "createdAt" | "tenantId">;

export async function audit(
  adapter: SupportAdapter,
  ctx: ToolContext,
  event: AuditInput,
): Promise<AuditEvent> {
  return adapter.appendAuditEvent(ctx, { tenantId: ctx.tenantId, ...event });
}

// §4 rule 10: load referenced Evidence through the adapter. Records that
// cannot be loaded are skipped — they count as missing, which the policy
// engine treats as INSUFFICIENT_EVIDENCE / no usable evidence.
export async function collectEvidence(
  adapter: SupportAdapter,
  ctx: ToolContext,
  ids: string[],
): Promise<Evidence[]> {
  const out: Evidence[] = [];
  for (const id of ids) {
    try {
      out.push(await adapter.getEvidence(ctx, id));
    } catch {
      // missing evidence record — treated as no evidence
    }
  }
  return out;
}

const HANDOFF_BY_REASON: Record<string, { reason: HandoffReason; event?: AuditEventType }> = {
  PROMPT_INJECTION_SUSPECTED: { reason: "prompt_injection_suspected", event: "prompt_injection_blocked" },
  PERMISSION_OVERREACH: { reason: "policy_conflict", event: "permission_overreach_blocked" },
  DUPLICATE_REQUEST: { reason: "duplicate_request" },
  IDENTITY_REQUIRED: { reason: "identity_unverified" },
  IDENTITY_UNVERIFIED: { reason: "identity_unverified" },
  REGION_BLOCKED: { reason: "region_blocked" },
  INSUFFICIENT_EVIDENCE: { reason: "insufficient_evidence" },
};

export interface EvaluationOutcome {
  proposal: ActionProposal;
  decision: PolicyDecision;
  approval?: Approval;
  handoffs: HumanHandoff[];
}

// §4: evaluate + apply side effects (status transition, Approval, handoffs, audit events).
export async function runEvaluation(
  adapter: SupportAdapter,
  ctx: ToolContext,
  proposal: ActionProposal,
  opts: { injectionSuspected?: boolean } = {},
): Promise<EvaluationOutcome> {
  const kase = await adapter.getCase(ctx, proposal.caseId);
  const customer = await adapter.getCustomer(ctx, kase.customerId);
  const evidence = await collectEvidence(adapter, ctx, proposal.evidenceIds);
  const policy = await adapter.getPolicy(ctx, ctx.tenantId);
  const recentProposals = await adapter.listProposals(ctx, { caseId: proposal.caseId });
  const injectionSuspected =
    opts.injectionSuspected ?? detectInjection(JSON.stringify(proposal.params ?? {}));

  const decision = evaluateProposal(proposal, {
    customer,
    evidence,
    policy,
    recentProposals,
    injectionSuspected,
  });

  await audit(adapter, ctx, {
    caseId: proposal.caseId,
    proposalId: proposal.id,
    eventType: "policy_evaluated",
    actorType: "policy_engine",
    actorId: "osas-api",
    policyVersion: decision.policyVersion,
    detail: { decision: decision.decision, reasons: decision.reasons },
  });

  const handoffs: HumanHandoff[] = [];

  if (decision.decision === "block") {
    const updated = await adapter.updateProposalStatus(ctx, proposal.id, "policy_rejected", {
      policyDecision: decision,
    });
    const seen = new Set<string>();
    for (const reason of decision.reasons) {
      const mapping = HANDOFF_BY_REASON[reason.code];
      if (!mapping || seen.has(mapping.reason)) continue;
      seen.add(mapping.reason);
      const handoff = await adapter.createHandoff(ctx, {
        tenantId: ctx.tenantId,
        caseId: proposal.caseId,
        proposalId: proposal.id,
        reason: mapping.reason,
        notes: reason.message,
      });
      handoffs.push(handoff);
      await audit(adapter, ctx, {
        caseId: proposal.caseId,
        proposalId: proposal.id,
        eventType: "handoff_created",
        actorType: "policy_engine",
        actorId: "osas-api",
        policyVersion: decision.policyVersion,
        detail: { handoffId: handoff.id, reason: handoff.reason },
      });
      if (mapping.event) {
        await audit(adapter, ctx, {
          caseId: proposal.caseId,
          proposalId: proposal.id,
          eventType: mapping.event,
          actorType: "policy_engine",
          actorId: "osas-api",
          policyVersion: decision.policyVersion,
          detail: { code: reason.code, message: reason.message },
        });
      }
    }
    return { proposal: updated, decision, handoffs };
  }

  if (decision.decision === "require_approval") {
    const updated = await adapter.updateProposalStatus(ctx, proposal.id, "pending_approval", {
      policyDecision: decision,
    });
    const approval = await adapter.createApproval(ctx, {
      tenantId: ctx.tenantId,
      proposalId: proposal.id,
      status: "pending",
      policyVersion: decision.policyVersion,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await audit(adapter, ctx, {
      caseId: proposal.caseId,
      proposalId: proposal.id,
      approvalId: approval.id,
      eventType: "approval_requested",
      actorType: "policy_engine",
      actorId: "osas-api",
      policyVersion: decision.policyVersion,
      detail: { reasons: decision.reasons },
    });
    return { proposal: updated, decision, approval, handoffs };
  }

  const updated = await adapter.updateProposalStatus(ctx, proposal.id, "approved", {
    policyDecision: decision,
  });
  return { proposal: updated, decision, handoffs };
}

export interface ExecutionOutcome {
  proposal: ActionProposal;
  execution: ExecutionResult;
  replayed: boolean;
}

// §5: execute an approved proposal through the engine + ExecutionStore.
// The engine is pure (in-memory transitions); persistence of the executing/
// terminal transitions and the §5 audit events are the API layer's job.
export async function runExecution(
  adapter: SupportAdapter,
  ctx: ToolContext,
  store: ExecutionStore,
  proposal: ActionProposal,
): Promise<ExecutionOutcome> {
  const stored = store.get(ctx.tenantId, proposal.idempotencyKey);
  if (stored) {
    return { proposal, execution: stored.result, replayed: true };
  }
  if (proposal.status !== "approved") {
    throw new ConflictError(
      `Proposal ${proposal.id} is "${proposal.status}"; only approved proposals can be executed`,
    );
  }

  await adapter.updateProposalStatus(ctx, proposal.id, "executing");
  await audit(adapter, ctx, {
    caseId: proposal.caseId,
    proposalId: proposal.id,
    eventType: "execution_started",
    actorType: "system",
    actorId: "osas-api",
    detail: { idempotencyKey: proposal.idempotencyKey },
  });

  // The engine passes only { tenantId } to the executor; wrap the adapter so
  // executeAction still receives the full system ToolContext.
  const executor = {
    executeAction: (_executorCtx: { tenantId: string }, p: ActionProposal) =>
      adapter.executeAction(ctx, p),
  };
  const outcome = await executeProposal(proposal, executor, store);
  const persisted = await adapter.updateProposalStatus(ctx, proposal.id, outcome.proposal.status);

  const base = {
    caseId: proposal.caseId,
    proposalId: proposal.id,
    actorType: "system" as const,
    actorId: "osas-api",
  };
  if (outcome.execution.status === "succeeded") {
    await audit(adapter, ctx, { ...base, eventType: "execution_succeeded", detail: { ...outcome.execution } });
  } else if (outcome.execution.status === "failed") {
    await audit(adapter, ctx, { ...base, eventType: "execution_failed", detail: { ...outcome.execution } });
  } else {
    // uncertain: never auto-retry — park + open reconciliation + handoff.
    await audit(adapter, ctx, { ...base, eventType: "execution_uncertain", detail: { ...outcome.execution } });
    await audit(adapter, ctx, { ...base, eventType: "reconciliation_opened", detail: { idempotencyKey: proposal.idempotencyKey } });
    const handoff = await adapter.createHandoff(ctx, {
      tenantId: ctx.tenantId,
      caseId: proposal.caseId,
      proposalId: proposal.id,
      reason: "external_uncertain",
      notes: outcome.execution.detail,
    });
    await audit(adapter, ctx, {
      ...base,
      eventType: "handoff_created",
      detail: { handoffId: handoff.id, reason: handoff.reason },
    });
  }

  return { proposal: persisted, execution: outcome.execution, replayed: false };
}

// §5 reconcile: reconciliation_required -> executed|failed + reconciliation_resolved.
export async function runReconcile(
  adapter: SupportAdapter,
  ctx: ToolContext,
  proposal: ActionProposal,
  outcome: "succeeded" | "failed",
  note?: string,
): Promise<ActionProposal> {
  const resolved = reconcile(proposal, outcome); // throws ReconcileStatusError -> 409
  const updated = await adapter.updateProposalStatus(ctx, proposal.id, resolved.status);
  await audit(adapter, ctx, {
    caseId: proposal.caseId,
    proposalId: proposal.id,
    eventType: "reconciliation_resolved",
    actorType: "human",
    actorId: ctx.principal.actorId,
    detail: { outcome, note },
  });
  return updated;
}
