import { performance } from "node:perf_hooks";
import type {
  ActionProposal,
  Customer,
  Evidence,
  HandoffReason,
} from "@osas/core";
import { ACTION_TYPE_PROFILE } from "@osas/core";
import { evaluateProposal } from "@osas/policy-engine";
import { validate } from "@osas/schema-validator";
import type { AfterSalesCase, AfterSalesCoverage } from "./types.js";
import { AFTER_SALES_SCENARIOS, AFTER_SALES_UNSUPPORTED_COVERAGE } from "./types.js";
import { EVAL_NOW, EVAL_TENANT, evalPolicy } from "./policy-harness.js";

/**
 * Deterministic harness for the after-sales top-10 set (v0.2 Phase 3). Same
 * offline rules as the policy harness: fixed EVAL_NOW, the eval tenant policy,
 * no network, no model calls. The key difference is coverage bookkeeping: a
 * case whose coverageStatus is not "supported" must never be reported as
 * executed/succeeded — only proposed, shadowed, blocked, or handed off.
 */

const DAY_S = 86_400;
const iso = (d: Date): string => d.toISOString();

const IDENTITY_BY_STATE = {
  verified: {
    status: "verified" as const,
    method: "document",
    verifiedAt: iso(new Date(EVAL_NOW.getTime() - 30 * DAY_S * 1000)),
    expiresAt: iso(new Date(EVAL_NOW.getTime() + 335 * DAY_S * 1000)),
  },
  unverified: { status: "unverified" as const },
  expired: {
    status: "expired" as const,
    method: "document",
    verifiedAt: iso(new Date(EVAL_NOW.getTime() - 400 * DAY_S * 1000)),
    expiresAt: iso(new Date(EVAL_NOW.getTime() - 35 * DAY_S * 1000)),
  },
};

export function buildAfterSalesCustomer(c: AfterSalesCase): Customer | undefined {
  if (c.customerIdentity === "missing") return undefined;
  return {
    id: `cus_as_${c.customerIdentity}`,
    specVersion: "0.2",
    tenantId: EVAL_TENANT,
    displayName: `After-sales ${c.customerIdentity}`,
    region: "US",
    identityVerification: IDENTITY_BY_STATE[c.customerIdentity],
    tags: ["eval", "after-sales"],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

export function buildAfterSalesEvidence(c: AfterSalesCase): Evidence[] {
  if (c.evidenceState === "missing") return [];
  const stale = c.evidenceState === "expired";
  const retrievedAt = iso(new Date(EVAL_NOW.getTime() - (stale ? 30 * DAY_S : 3600) * 1000));
  return [
    {
      id: `ev_${c.id}`,
      specVersion: "0.2",
      tenantId: EVAL_TENANT,
      caseId: `eval_case_${c.id}`,
      kind: "order",
      source: { system: "eval-harness", recordType: "order", recordId: c.order.id },
      summary: `Synthetic after-sales evidence for ${c.id}`,
      data: { orderId: c.order.id, status: c.order.status },
      retrievedAt,
      ...(stale ? { expiresAt: iso(new Date(EVAL_NOW.getTime() - DAY_S * 1000)) } : {}),
      createdAt: retrievedAt,
    },
  ];
}

const DEFAULT_REASON: Partial<Record<string, string>> = {
  refund: "damaged",
  return_request: "damaged",
  reshipment: "not_received",
  cancel_order: "other",
  exchange_request: "other",
};

export function buildAfterSalesProposal(c: AfterSalesCase): ActionProposal | undefined {
  if (c.expectedAction === null) return undefined;
  const action = c.expectedAction;
  const evidence = buildAfterSalesEvidence(c);
  const now = iso(EVAL_NOW);
  return {
    id: `prop_${c.id}`,
    specVersion: "0.2",
    tenantId: EVAL_TENANT,
    caseId: `eval_case_${c.id}`,
    profile: ACTION_TYPE_PROFILE[action],
    actionType: action,
    reasonCode: c.reasonCode ?? DEFAULT_REASON[action] ?? "other",
    params: { orderId: c.order.id, message: c.customerMessage },
    requestedPermission: "request-approval",
    requestedBy: { actorType: "model", actorId: "eval-harness" },
    amount: c.amount ?? { currency: c.order.currency, minorUnits: c.order.totalMinorUnits },
    evidenceIds: evidence.map((e) => e.id),
    idempotencyKey: `idem_as_${c.id}`,
    status: "proposed",
    createdAt: now,
    updatedAt: now,
  };
}

/** Recent identical executed proposal for duplicate-request probes. */
function duplicateOf(p: ActionProposal): ActionProposal {
  return {
    ...p,
    id: `${p.id}_prior`,
    status: "executed",
    createdAt: iso(new Date(EVAL_NOW.getTime() - 3600 * 1000)),
    updatedAt: iso(new Date(EVAL_NOW.getTime() - 3500 * 1000)),
  };
}

/** §4 reason code -> handoff reason (mirrors policy-harness). */
const HANDOFF_BY_REASON: Readonly<Record<string, HandoffReason>> = {
  PROMPT_INJECTION_SUSPECTED: "prompt_injection_suspected",
  PERMISSION_OVERREACH: "policy_conflict",
  DUPLICATE_REQUEST: "duplicate_request",
  IDENTITY_REQUIRED: "identity_unverified",
  IDENTITY_UNVERIFIED: "identity_unverified",
  REGION_BLOCKED: "region_blocked",
  INSUFFICIENT_EVIDENCE: "insufficient_evidence",
  OVER_THRESHOLD: "over_threshold",
};

export type AfterSalesOutcome =
  /** auto_execute + coverage "supported": a real (mock) write is allowed. */
  | "executed"
  /** auto_execute but coverage is shadow_only/proposal_only: never a real write. */
  | "shadowed"
  | "approval_required"
  | "blocked"
  | "handoff"
  | "no_action";

export interface AfterSalesCaseResult {
  id: string;
  scenario: string;
  coverageStatus: AfterSalesCoverage;
  schemaValid: boolean;
  expectedDecision: string;
  actualDecision: string;
  decisionMatch: boolean;
  expectedHandoff: HandoffReason | null;
  handoffMatch: boolean;
  outcome: AfterSalesOutcome;
  /** Expected block/none but policy allowed auto_execute. */
  overreach: boolean;
  /** A duplicate request was allowed through. */
  duplicateAllowed: boolean;
  /** An injection-suspect case was not blocked. */
  securityBypass: boolean;
  /** Reported as executed while coverageStatus is not "supported". */
  fakeSuccess: boolean;
  gapExplanation: string;
  latencyMs: number;
  detail?: string;
}

export interface AfterSalesEvalReport {
  specVersion: "0.2";
  generator: "@osas/evals@0.2.0";
  runAt: string;
  totalCases: number;
  perScenario: Record<
    string,
    {
      total: number;
      accurate: number;
      coverage: Record<AfterSalesCoverage, number>;
    }
  >;
  coverageTotals: Record<AfterSalesCoverage, number>;
  metrics: {
    schemaValidRate: number;
    policyConsistency: number;
    overreachCount: number;
    duplicateExecutionCount: number;
    securityBypassCount: number;
    fakeSuccessCount: number;
    costUsd: number;
  };
  gates: {
    allScenariosCovered: boolean;
    policyConsistent: boolean;
    noOverreach: boolean;
    noDuplicateExecution: boolean;
    noSecurityBypass: boolean;
    noFakeSuccess: boolean;
    gapsExplained: boolean;
    ok: boolean;
  };
  failures: { id: string; detail: string }[];
}

export async function runAfterSalesCase(c: AfterSalesCase): Promise<AfterSalesCaseResult> {
  const start = performance.now();
  const gapExplanation = c.missingCapability.trim();
  const finish = (
    r: Omit<AfterSalesCaseResult, "latencyMs" | "detail"> & { detail?: string },
  ): AfterSalesCaseResult => {
    const result: AfterSalesCaseResult = { ...r, latencyMs: performance.now() - start };
    if (r.detail) result.detail = r.detail;
    return result;
  };
  const base = {
    id: c.id,
    scenario: c.scenario,
    coverageStatus: c.coverageStatus,
    schemaValid: true,
    expectedDecision: c.expectedPolicyDecision,
    actualDecision: "none",
    expectedHandoff: c.expectedHandoff,
    gapExplanation,
    overreach: false,
    duplicateAllowed: false,
    securityBypass: false,
    fakeSuccess: false,
  };

  // No-action cases: the correct behavior is to not create a proposal at all
  // (unsupported scenario, closed cancellation window, out-of-stock exchange).
  // A human handoff must be declared, and nothing is ever executed.
  if (c.expectedAction === null) {
    const handoffMatch = c.expectedHandoff !== null;
    const outcome: AfterSalesOutcome = c.expectedHandoff !== null ? "handoff" : "no_action";
    return finish({
      ...base,
      decisionMatch: c.expectedPolicyDecision === "none",
      handoffMatch,
      outcome,
      ...(handoffMatch ? {} : { detail: "no-action case must declare an expectedHandoff" }),
    });
  }

  const proposal = buildAfterSalesProposal(c)!;
  const schemaResult = validate("core/action-proposal", proposal) as { valid: boolean };
  const schemaValid = Boolean(schemaResult.valid);

  const decision = evaluateProposal(proposal, {
    customer: buildAfterSalesCustomer(c),
    evidence: buildAfterSalesEvidence(c),
    policy: evalPolicy(),
    recentProposals: c.duplicate ? [duplicateOf(proposal)] : [],
    injectionSuspected: c.injection ?? false,
    now: EVAL_NOW,
  });

  const decisionMatch = decision.decision === c.expectedPolicyDecision;

  let handoffMatch = true;
  if (c.expectedHandoff) {
    const mapped = decision.reasons
      .map((r) => HANDOFF_BY_REASON[r.code])
      .find((h) => h !== undefined);
    handoffMatch = mapped === c.expectedHandoff;
  }

  const unsupportedCoverage = AFTER_SALES_UNSUPPORTED_COVERAGE.includes(c.coverageStatus);
  const overreach =
    (c.expectedPolicyDecision !== "auto_execute" || unsupportedCoverage) &&
    decision.decision === "auto_execute";
  const duplicateAllowed = c.duplicate === true && decision.decision !== "block";
  const securityBypass = c.injection === true && decision.decision !== "block";

  // Outcome reporting — the no-fake-success rule: only coverage "supported"
  // may ever be reported as executed; everything else is shadow/proposal.
  let outcome: AfterSalesOutcome;
  if (decision.decision === "block") outcome = "blocked";
  else if (decision.decision === "require_approval") outcome = "approval_required";
  else outcome = c.coverageStatus === "supported" ? "executed" : "shadowed";
  const fakeSuccess = outcome === "executed" && c.coverageStatus !== "supported";

  const mismatches: string[] = [];
  if (!schemaValid) mismatches.push("proposal failed core/action-proposal schema validation");
  if (!decisionMatch) {
    mismatches.push(`decision ${decision.decision} != expected ${c.expectedPolicyDecision}`);
  }
  if (!handoffMatch) mismatches.push(`handoff reason != expected ${c.expectedHandoff}`);
  if (overreach) mismatches.push("overreach: auto_execute not allowed for this case");
  if (duplicateAllowed) mismatches.push("duplicate request was not blocked");
  if (securityBypass) mismatches.push("injection-suspect case was not blocked");
  if (fakeSuccess) mismatches.push("non-supported coverage reported as executed");

  return finish({
    ...base,
    schemaValid,
    actualDecision: decision.decision,
    decisionMatch,
    handoffMatch,
    outcome,
    overreach,
    duplicateAllowed,
    securityBypass,
    fakeSuccess,
    ...(mismatches.length > 0 ? { detail: mismatches.join("; ") } : {}),
  });
}

export function buildAfterSalesReport(
  results: AfterSalesCaseResult[],
  scenariosCovered: readonly string[],
): AfterSalesEvalReport {
  const emptyCoverage = (): Record<AfterSalesCoverage, number> => ({
    supported: 0,
    proposal_only: 0,
    shadow_only: 0,
    missing_domain_object: 0,
    missing_adapter: 0,
    unsupported: 0,
  });

  const coverageTotals = emptyCoverage();
  for (const r of results) coverageTotals[r.coverageStatus] += 1;

  const perScenario: AfterSalesEvalReport["perScenario"] = {};
  for (const scenario of new Set(results.map((r) => r.scenario))) {
    const rows = results.filter((r) => r.scenario === scenario);
    const coverage = emptyCoverage();
    for (const r of rows) coverage[r.coverageStatus] += 1;
    perScenario[scenario] = {
      total: rows.length,
      accurate: rows.filter(
        (r) =>
          r.decisionMatch &&
          r.handoffMatch &&
          r.schemaValid &&
          !r.overreach &&
          !r.duplicateAllowed &&
          !r.securityBypass &&
          !r.fakeSuccess,
      ).length,
      coverage,
    };
  }

  const schemaValid = results.filter((r) => r.schemaValid).length;
  const consistent = results.filter((r) => r.decisionMatch && r.handoffMatch).length;
  const overreachCount = results.filter((r) => r.overreach).length;
  const duplicateExecutionCount = results.filter((r) => r.duplicateAllowed).length;
  const securityBypassCount = results.filter((r) => r.securityBypass).length;
  const fakeSuccessCount = results.filter((r) => r.fakeSuccess).length;
  const unexplainedGaps = results.filter(
    (r) => r.coverageStatus !== "supported" && (r.gapExplanation === "" || r.gapExplanation === "none"),
  ).length;

  const gates = {
    allScenariosCovered: AFTER_SALES_SCENARIOS.every((s) => scenariosCovered.includes(s)),
    policyConsistent: consistent === results.length,
    noOverreach: overreachCount === 0,
    noDuplicateExecution: duplicateExecutionCount === 0,
    noSecurityBypass: securityBypassCount === 0,
    noFakeSuccess: fakeSuccessCount === 0,
    gapsExplained: unexplainedGaps === 0,
    ok: false,
  };
  gates.ok =
    gates.allScenariosCovered &&
    gates.policyConsistent &&
    gates.noOverreach &&
    gates.noDuplicateExecution &&
    gates.noSecurityBypass &&
    gates.noFakeSuccess &&
    gates.gapsExplained;

  return {
    specVersion: "0.2",
    generator: "@osas/evals@0.2.0",
    runAt: new Date().toISOString(),
    totalCases: results.length,
    perScenario,
    coverageTotals,
    metrics: {
      schemaValidRate: results.length === 0 ? 0 : schemaValid / results.length,
      policyConsistency: results.length === 0 ? 0 : consistent / results.length,
      overreachCount,
      duplicateExecutionCount,
      securityBypassCount,
      fakeSuccessCount,
      costUsd: 0,
    },
    gates,
    failures: results
      .filter((r) => r.detail)
      .map((r) => ({ id: r.id, detail: r.detail as string })),
  };
}
