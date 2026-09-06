import { performance } from "node:perf_hooks";
import type {
  ActionProposal,
  Customer,
  Evidence,
  HandoffReason,
  TenantPolicy,
} from "@osas/core";
import {
  InMemoryExecutionStore,
  evaluateProposal,
  executeProposal,
} from "@osas/policy-engine";
import { validate } from "@osas/schema-validator";
import type { EvalCase, EvalCategory } from "./types.js";

/**
 * Offline policy evaluation harness (Milestone 4). Deterministic: a fixed
 * `now`, a fixed eval policy (mirrors the §11 demo policy), no network, no
 * model calls. Gates (CI): 100% schema validity, 100% policy consistency,
 * zero overreach, zero duplicate executions, zero security-boundary bypass.
 */

export const EVAL_TENANT = "tenant_eval";
/** Fixed clock so evidence-age and identity-age checks are deterministic. */
export const EVAL_NOW = new Date("2026-01-01T00:00:00.000Z");

const DAY_S = 86_400;
const iso = (d: Date): string => d.toISOString();
const usd = (minorUnits: number) => ({ currency: "USD", minorUnits });

/** Mirrors the CONTRACTS.md §11 demo policy (tenant_eval). */
export function evalPolicy(): TenantPolicy {
  return {
    id: "pol_eval",
    specVersion: "0.1",
    tenantId: EVAL_TENANT,
    version: "eval-1.0.0",
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    duplicateWindowSeconds: DAY_S,
    maxEvidenceAgeSeconds: 7 * DAY_S,
    defaultDecision: "block",
    rules: [
      {
        actionType: "refund",
        decision: "auto_execute",
        maxAmount: usd(5000),
        reasonCodes: ["damaged", "wrong_item", "not_received", "other"],
        requireVerifiedIdentity: true,
        identityMaxAgeSeconds: 90 * DAY_S,
        allowedRegions: ["US", "CA", "GB", "DE", "FR", "JP", "AU"],
        blockedRegions: ["IR", "KP", "CU"],
      },
      {
        actionType: "reshipment",
        decision: "auto_execute",
        maxAmount: usd(3000),
        requireVerifiedIdentity: true,
        identityMaxAgeSeconds: 90 * DAY_S,
      },
      { actionType: "return_request", decision: "require_approval" },
      { actionType: "cancel_order", decision: "require_approval" },
      {
        actionType: "credit_apply",
        decision: "require_approval",
        maxAmount: usd(10000),
        reasonCodes: ["service_outage", "goodwill", "billing_error"],
      },
      { actionType: "subscription_cancel", decision: "require_approval" },
      { actionType: "plan_change", decision: "require_approval" },
      { actionType: "create_note", decision: "auto_execute" },
      { actionType: "create_escalation", decision: "auto_execute" },
    ],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

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

export function buildCustomer(c: EvalCase): Customer | undefined {
  const spec = c.input.customer ?? {};
  const identity = spec.identity ?? "verified";
  if (identity === "missing") return undefined;
  return {
    id: `cus_eval_${identity}`,
    specVersion: "0.1",
    tenantId: EVAL_TENANT,
    displayName: `Eval ${identity}`,
    region: spec.region ?? "US",
    identityVerification: IDENTITY_BY_STATE[identity],
    tags: ["eval"],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

export function buildEvidence(c: EvalCase): Evidence[] {
  const state = c.input.evidence ?? "fresh";
  if (state === "missing") return [];
  const stale = state === "expired";
  const retrievedAt = iso(new Date(EVAL_NOW.getTime() - (stale ? 30 * DAY_S : 3600) * 1000));
  return [
    {
      id: `ev_${c.id}`,
      specVersion: "0.1",
      tenantId: EVAL_TENANT,
      caseId: c.input.caseId,
      kind: "order",
      source: { system: "eval-harness", recordType: "order", recordId: c.input.orderId ?? "ord_eval" },
      summary: `Synthetic evidence for ${c.id}`,
      data: { orderId: c.input.orderId ?? "ord_eval" },
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
};

export function buildProposal(c: EvalCase): ActionProposal | undefined {
  if (c.expected.action === null) return undefined;
  const evidence = buildEvidence(c);
  const now = iso(EVAL_NOW);
  return {
    id: `prop_${c.id}`,
    specVersion: "0.1",
    tenantId: EVAL_TENANT,
    caseId: c.input.caseId ?? `eval_case_${c.id}`,
    profile: c.profile,
    actionType: c.expected.action,
    reasonCode: c.input.reasonCode ?? DEFAULT_REASON[c.expected.action] ?? "other",
    params: {
      ...(c.input.orderId ? { orderId: c.input.orderId } : {}),
      message: c.input.message,
    },
    requestedPermission: "request-approval",
    requestedBy: { actorType: "model", actorId: "eval-harness" },
    ...(c.input.amount ? { amount: c.input.amount } : {}),
    // "missing" evidence state means the proposal carries no references.
    evidenceIds: evidence.map((e) => e.id),
    idempotencyKey: `idem_eval_${c.id}`,
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

/** §4 reason code -> handoff reason (mirrors apps/api HANDOFF_BY_REASON). */
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

export interface CaseResult {
  id: string;
  category: EvalCategory;
  schemaValid: boolean;
  expectedDecision: string;
  actualDecision: string;
  decisionMatch: boolean;
  reasonCodesMatch: boolean;
  handoffMatch: boolean;
  /** Expected block/none but policy allowed auto_execute. */
  overreach: boolean;
  /** A duplicate request was allowed through. */
  duplicateAllowed: boolean;
  /** Security-boundary case whose actual outcome diverged from expected. */
  securityBypass: boolean;
  latencyMs: number;
  detail?: string;
}

export interface PolicyEvalReport {
  specVersion: "0.1";
  generator: "@osas/evals@0.1.1";
  runAt: string;
  totalCases: number;
  perCategory: Record<string, { total: number; accurate: number; accuracy: number }>;
  metrics: {
    schemaValidRate: number;
    policyConsistency: number;
    overreachCount: number;
    duplicateExecutionCount: number;
    securityBypassCount: number;
    /** Offline harness: no model calls, so cost is exactly 0. */
    costUsd: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  };
  gates: {
    schemaValid: boolean;
    policyConsistent: boolean;
    noOverreach: boolean;
    noDuplicateExecution: boolean;
    noSecurityBypass: boolean;
    ok: boolean;
  };
  failures: { id: string; detail: string }[];
}

export async function runCase(c: EvalCase): Promise<CaseResult> {
  const start = performance.now();
  const base: Omit<CaseResult, "detail"> = {
    id: c.id,
    category: c.category,
    schemaValid: true,
    expectedDecision: c.expected.policyDecision,
    actualDecision: "none",
    decisionMatch: false,
    reasonCodesMatch: true,
    handoffMatch: true,
    overreach: false,
    duplicateAllowed: false,
    securityBypass: false,
    latencyMs: 0,
  };

  const finish = (r: Omit<CaseResult, "latencyMs" | "detail"> & { detail?: string }): CaseResult => {
    const result: CaseResult = { ...r, latencyMs: performance.now() - start };
    if (r.detail) result.detail = r.detail;
    return result;
  };

  // No-action cases: the correct behavior is to not create a proposal at all.
  if (c.expected.action === null) {
    return finish({
      ...base,
      decisionMatch: c.expected.policyDecision === "none",
      ...(c.expected.policyDecision === "none"
        ? {}
        : { detail: "no-action case must expect policyDecision 'none'" }),
    });
  }

  const proposal = buildProposal(c)!;
  const schemaResult = validate("core/action-proposal", proposal) as { valid: boolean };
  base.schemaValid = Boolean(schemaResult.valid);

  const decision = evaluateProposal(proposal, {
    customer: buildCustomer(c),
    evidence: buildEvidence(c),
    policy: evalPolicy(),
    recentProposals: c.input.duplicate ? [duplicateOf(proposal)] : [],
    injectionSuspected: c.input.injection ?? false,
    now: EVAL_NOW,
  });

  const decisionMatch = decision.decision === c.expected.policyDecision;
  const expectedCodes = c.expected.reasonCodes ?? [];
  const actualCodes = new Set(decision.reasons.map((r) => r.code));
  const reasonCodesMatch = expectedCodes.every((code) => actualCodes.has(code));

  let handoffMatch = true;
  const uncertainProbe =
    c.input.executionOutcome === "uncertain" && c.expected.handoffReason === "external_uncertain";
  if (c.expected.handoffReason && !uncertainProbe) {
    const mapped = decision.reasons
      .map((r) => HANDOFF_BY_REASON[r.code])
      .find((h) => h !== undefined);
    handoffMatch = mapped === c.expected.handoffReason;
  }

  const overreach =
    (c.expected.policyDecision === "block" || c.expected.policyDecision === "none") &&
    decision.decision === "auto_execute";
  const duplicateAllowed = c.input.duplicate === true && decision.decision !== "block";

  // External-uncertainty probe: when the policy auto-executes but the
  // external executor reports uncertainty, the engine must park the proposal
  // in reconciliation_required (never auto-retry, handoff external_uncertain).
  let executionDetail = "";
  if (c.input.executionOutcome === "uncertain" && decision.decision === "auto_execute") {
    const approved: ActionProposal = { ...proposal, status: "approved" };
    const outcome = await executeProposal(
      approved,
      { executeAction: () => Promise.resolve({ status: "uncertain" as const, detail: "eval: executor timeout" }) },
      new InMemoryExecutionStore(),
      EVAL_NOW,
    );
    if (outcome.proposal.status !== "reconciliation_required") {
      executionDetail = `uncertain execution must park in reconciliation_required, got ${outcome.proposal.status}`;
      handoffMatch = c.expected.handoffReason === "external_uncertain" ? false : handoffMatch;
    }
  }

  const securityBypass =
    c.category === "security" &&
    (!decisionMatch || !reasonCodesMatch || !handoffMatch || overreach || Boolean(executionDetail));

  const mismatches: string[] = [];
  if (!decisionMatch) mismatches.push(`decision ${decision.decision} != expected ${c.expected.policyDecision}`);
  if (!reasonCodesMatch) mismatches.push(`missing reason codes ${expectedCodes.filter((x) => !actualCodes.has(x)).join(",")}`);
  if (!handoffMatch) mismatches.push(`handoff reason != expected ${c.expected.handoffReason}`);
  if (executionDetail) mismatches.push(executionDetail);

  return finish({
    ...base,
    actualDecision: decision.decision,
    decisionMatch,
    reasonCodesMatch,
    handoffMatch,
    overreach,
    duplicateAllowed,
    securityBypass,
    ...(mismatches.length > 0 ? { detail: mismatches.join("; ") } : {}),
  });
}

export function buildReport(results: CaseResult[]): PolicyEvalReport {
  const categories = [...new Set(results.map((r) => r.category))];
  const perCategory: PolicyEvalReport["perCategory"] = {};
  for (const cat of categories) {
    const rows = results.filter((r) => r.category === cat);
    const accurate = rows.filter(
      (r) => r.decisionMatch && r.reasonCodesMatch && r.handoffMatch && !r.overreach && !r.duplicateAllowed,
    ).length;
    perCategory[cat] = {
      total: rows.length,
      accurate,
      accuracy: rows.length === 0 ? 0 : accurate / rows.length,
    };
  }
  const schemaValid = results.filter((r) => r.schemaValid).length;
  const consistent = results.filter((r) => r.decisionMatch && r.reasonCodesMatch && r.handoffMatch).length;
  const overreachCount = results.filter((r) => r.overreach).length;
  const duplicateExecutionCount = results.filter((r) => r.duplicateAllowed).length;
  const securityBypassCount = results.filter((r) => r.securityBypass).length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;

  const gates = {
    schemaValid: schemaValid === results.length,
    policyConsistent: consistent === results.length,
    noOverreach: overreachCount === 0,
    noDuplicateExecution: duplicateExecutionCount === 0,
    noSecurityBypass: securityBypassCount === 0,
    ok: false,
  };
  gates.ok =
    gates.schemaValid &&
    gates.policyConsistent &&
    gates.noOverreach &&
    gates.noDuplicateExecution &&
    gates.noSecurityBypass;

  return {
    specVersion: "0.1",
    generator: "@osas/evals@0.1.1",
    runAt: new Date().toISOString(),
    totalCases: results.length,
    perCategory,
    metrics: {
      schemaValidRate: results.length === 0 ? 0 : schemaValid / results.length,
      policyConsistency: results.length === 0 ? 0 : consistent / results.length,
      overreachCount,
      duplicateExecutionCount,
      securityBypassCount,
      costUsd: 0,
      avgLatencyMs: results.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / results.length,
      p95LatencyMs: p95,
    },
    gates,
    failures: results
      .filter((r) => r.detail)
      .map((r) => ({ id: r.id, detail: r.detail as string })),
  };
}
