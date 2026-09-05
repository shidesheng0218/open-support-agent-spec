import {
  ACTION_TYPE_PROFILE,
  FINANCIAL_ACTION_TYPES,
  type ActionProposal,
  type PolicyRule,
} from "@osas/core";
import { deepEqual } from "./stable-stringify.js";
import type { EvaluationContext, PolicyDecision } from "./types.js";

type DecisionGrade = "auto_execute" | "require_approval" | "block";

const SEVERITY: Readonly<Record<DecisionGrade, number>> = {
  auto_execute: 0,
  require_approval: 1,
  block: 2,
};

const GRADE_BY_SEVERITY: readonly DecisionGrade[] = [
  "auto_execute",
  "require_approval",
  "block",
];

const DUPLICATE_STATUSES = new Set([
  "executing",
  "executed",
  "pending_approval",
  "approved",
]);

/**
 * CONTRACTS.md §4 — deterministic policy evaluation.
 *
 * Runs ordered checks 1–11, collects ALL applicable reasons, and returns the
 * worst decision: block > require_approval > auto_execute. Pure: no side
 * effects (status changes, approvals, handoffs, audit events are the API
 * layer's job per §4 "Side effects").
 */
export function evaluateProposal(
  proposal: ActionProposal,
  ctx: EvaluationContext,
): PolicyDecision {
  const now = ctx.now ?? new Date();
  const reasons: { code: string; message: string }[] = [];
  let worst = SEVERITY.auto_execute;

  const add = (code: string, message: string, grade: DecisionGrade): void => {
    reasons.push({ code, message });
    if (SEVERITY[grade] > worst) worst = SEVERITY[grade];
  };

  // 1. PERMISSION_OVERREACH (§3): models are capped at request-approval.
  if (
    proposal.requestedPermission === "execute" &&
    proposal.requestedBy.actorType === "model"
  ) {
    add(
      "PERMISSION_OVERREACH",
      "model principals are capped at request-approval; requestedPermission 'execute' is not allowed",
      "block",
    );
  }

  // 2. PROMPT_INJECTION_SUSPECTED.
  if (ctx.injectionSuspected) {
    add(
      "PROMPT_INJECTION_SUSPECTED",
      "prompt injection suspected in the originating conversation",
      "block",
    );
  }

  // 3. PROFILE_MISMATCH: actionType must belong to proposal.profile.
  const expectedProfile = ACTION_TYPE_PROFILE[proposal.actionType] as
    | string
    | undefined;
  if (expectedProfile === undefined || expectedProfile !== proposal.profile) {
    add(
      "PROFILE_MISMATCH",
      `actionType '${proposal.actionType}' does not belong to profile '${proposal.profile}'`,
      "block",
    );
  }

  // 4. NO_RULE: default block when no rule matches the actionType.
  const rule: PolicyRule | undefined = ctx.policy.rules.find(
    (r) => r.actionType === proposal.actionType,
  );
  if (!rule) {
    add(
      "NO_RULE",
      `no policy rule matches actionType '${proposal.actionType}'; default decision is block`,
      "block",
    );
  } else {
    // 5. REASON_CODE_NOT_ALLOWED.
    if (rule.reasonCodes && !rule.reasonCodes.includes(proposal.reasonCode)) {
      add(
        "REASON_CODE_NOT_ALLOWED",
        `reasonCode '${proposal.reasonCode}' is not in the allowed list for actionType '${rule.actionType}'`,
        "block",
      );
    }

    // 7. OVER_THRESHOLD / CURRENCY_MISMATCH.
    if (proposal.amount && rule.maxAmount) {
      if (proposal.amount.currency !== rule.maxAmount.currency) {
        add(
          "CURRENCY_MISMATCH",
          `amount currency ${proposal.amount.currency} does not match rule.maxAmount currency ${rule.maxAmount.currency}`,
          "require_approval",
        );
      } else if (proposal.amount.minorUnits > rule.maxAmount.minorUnits) {
        add(
          "OVER_THRESHOLD",
          `amount ${proposal.amount.minorUnits} ${proposal.amount.currency} exceeds rule maxAmount ${rule.maxAmount.minorUnits} ${rule.maxAmount.currency}`,
          "require_approval",
        );
      }
    }

    // 8. IDENTITY_REQUIRED / IDENTITY_UNVERIFIED.
    if (rule.requireVerifiedIdentity) {
      const iv = ctx.customer?.identityVerification;
      if (!ctx.customer || !iv) {
        add(
          "IDENTITY_REQUIRED",
          "rule requires a verified identity but no customer identity record is available",
          "block",
        );
      } else if (iv.status !== "verified") {
        add(
          "IDENTITY_UNVERIFIED",
          `rule requires a verified identity but status is '${iv.status}'`,
          "block",
        );
      } else if (rule.identityMaxAgeSeconds !== undefined) {
        if (!iv.verifiedAt) {
          add(
            "IDENTITY_UNVERIFIED",
            "identity is verified but verifiedAt is missing; age cannot be validated",
            "block",
          );
        } else {
          const ageSeconds =
            (now.getTime() - new Date(iv.verifiedAt).getTime()) / 1000;
          if (ageSeconds > rule.identityMaxAgeSeconds) {
            add(
              "IDENTITY_UNVERIFIED",
              `identity verification is ${Math.floor(ageSeconds)}s old, exceeding identityMaxAgeSeconds ${rule.identityMaxAgeSeconds}`,
              "block",
            );
          }
        }
      }
    }

    // 9. REGION_BLOCKED / REGION_UNLISTED.
    const region = ctx.customer?.region;
    if (region !== undefined) {
      if (rule.blockedRegions?.includes(region)) {
        add(
          "REGION_BLOCKED",
          `customer region '${region}' is in blockedRegions for actionType '${rule.actionType}'`,
          "block",
        );
      } else if (rule.allowedRegions && !rule.allowedRegions.includes(region)) {
        add(
          "REGION_UNLISTED",
          `customer region '${region}' is not in allowedRegions for actionType '${rule.actionType}'`,
          "require_approval",
        );
      }
    }
  }

  // 6. DUPLICATE_REQUEST: same tenantId+caseId+actionType, deep-equal params,
  //    created within duplicateWindowSeconds, in an active status.
  const windowMs = ctx.policy.duplicateWindowSeconds * 1000;
  const duplicate = ctx.recentProposals.find(
    (p) =>
      p.id !== proposal.id &&
      p.tenantId === proposal.tenantId &&
      p.caseId === proposal.caseId &&
      p.actionType === proposal.actionType &&
      DUPLICATE_STATUSES.has(p.status) &&
      now.getTime() - new Date(p.createdAt).getTime() <= windowMs &&
      deepEqual(p.params, proposal.params),
  );
  if (duplicate) {
    add(
      "DUPLICATE_REQUEST",
      `proposal '${duplicate.id}' with identical params is already ${duplicate.status} within the duplicate window`,
      "block",
    );
  }

  // 10. INSUFFICIENT_EVIDENCE / EVIDENCE_STALE.
  if (
    FINANCIAL_ACTION_TYPES.includes(proposal.actionType) &&
    proposal.evidenceIds.length === 0
  ) {
    add(
      "INSUFFICIENT_EVIDENCE",
      `financial actionType '${proposal.actionType}' requires at least one evidence reference`,
      "block",
    );
  }
  const referenced = ctx.evidence.filter((e) =>
    proposal.evidenceIds.includes(e.id),
  );
  const stale = referenced.filter((e) => {
    if (e.expiresAt && new Date(e.expiresAt).getTime() < now.getTime()) {
      return true;
    }
    const ageSeconds =
      (now.getTime() - new Date(e.retrievedAt).getTime()) / 1000;
    return ageSeconds > ctx.policy.maxEvidenceAgeSeconds;
  });
  if (stale.length > 0) {
    add(
      "EVIDENCE_STALE",
      `evidence expired or older than maxEvidenceAgeSeconds: ${stale.map((e) => e.id).join(", ")}`,
      "require_approval",
    );
  }

  // 11. Rule-matched baseline decision; final = worst of everything.
  if (rule && SEVERITY[rule.decision] > worst) {
    worst = SEVERITY[rule.decision];
  }

  return {
    decision: GRADE_BY_SEVERITY[worst] ?? "block",
    reasons,
    policyVersion: ctx.policy.version,
    evaluatedAt: now.toISOString(),
  };
}
