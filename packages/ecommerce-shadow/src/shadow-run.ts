import type { ActionProposal, PolicyDecision, ShadowRun } from "@osas/core";
import { SPEC_VERSION } from "@osas/core";
import { ShadowRunAlreadyReviewedError } from "./errors.js";

/**
 * Build the ShadowRun for a proposal + simulated policy decision.
 *
 * `wouldAutoExecute` is true ONLY when the deterministic policy decision is
 * exactly "auto_execute" — every block/require_approval reason (injection,
 * unverified identity, stale evidence, over-threshold amounts, duplicates,
 * ...) therefore keeps the run out of wouldAutoExecute by construction.
 *
 * This is record-only: the proposal is never transitioned here, and Shadow
 * Mode never marks a proposal "executed".
 */
export function planShadowRun(
  proposal: ActionProposal,
  decision: PolicyDecision,
  input: { id: string; now?: Date },
): ShadowRun {
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: input.id,
    specVersion: SPEC_VERSION,
    tenantId: proposal.tenantId,
    proposalId: proposal.id,
    policyDecision: decision,
    wouldAutoExecute: decision.decision === "auto_execute",
    suggestedAction: {
      actionType: proposal.actionType,
      reasonCode: proposal.reasonCode,
      params: structuredClone(proposal.params ?? {}),
      ...(proposal.amount ? { amount: { ...proposal.amount } } : {}),
    },
    humanOutcome: "pending",
    createdAt: now,
  };
}

export interface ShadowReviewInput {
  outcome: Exclude<ShadowRun["humanOutcome"], "pending">;
  humanComment?: string;
  externalReference?: string;
  now?: Date;
}

/**
 * Apply the human review. Pure: returns the updated record; persistence and
 * the shadow_run_reviewed audit event are the caller's job. Throws
 * ShadowRunAlreadyReviewedError unless the run is still "pending".
 */
export function reviewShadowRun(run: ShadowRun, input: ShadowReviewInput): ShadowRun {
  if (run.humanOutcome !== "pending") {
    throw new ShadowRunAlreadyReviewedError(run.id, run.humanOutcome);
  }
  return {
    ...run,
    humanOutcome: input.outcome,
    ...(input.humanComment !== undefined ? { humanComment: input.humanComment } : {}),
    ...(input.externalReference !== undefined
      ? { externalReference: input.externalReference }
      : {}),
    reviewedAt: (input.now ?? new Date()).toISOString(),
  };
}
