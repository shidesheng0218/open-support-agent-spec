/**
 * The sandbox's decision logic — deliberately free of any DOM dependency.
 *
 * Every value here goes through the REAL @osas/policy-engine: the same
 * evaluateProposal() that the API and MCP layers call. The browser bundle is
 * only presentation; this module is what the tests pin.
 */
import {
  evaluateProposal,
  type ActionProposal,
  type EvaluationContext,
  type Permission,
  type PolicyDecision,
  type TenantPolicy,
} from "@osas/policy-engine";
import type { Evidence } from "@osas/core";

/** Fixed clock so the sandbox is deterministic and the evidence is "fresh". */
export const SANDBOX_NOW = new Date("2026-09-07T12:00:00.000Z");
export const TENANT_ID = "tenant_sandbox";
export const CASE_ID = "case_1001";
export const ORDER_ID = "ord_5001";
export const EVIDENCE_ID = "ev_order_5001";

/** $50.00 — the whole point of the demo: the gate sits at a visible number. */
export const AUTO_LIMIT_MINOR = 5_000;

export function sandboxPolicy(): TenantPolicy {
  return {
    id: "pol_sandbox",
    specVersion: "0.2",
    tenantId: TENANT_ID,
    version: "1.0.0",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    duplicateWindowSeconds: 86_400,
    maxEvidenceAgeSeconds: 604_800, // 7 days
    rules: [
      {
        actionType: "refund",
        decision: "auto_execute",
        maxAmount: { currency: "USD", minorUnits: AUTO_LIMIT_MINOR },
        reasonCodes: ["damaged", "wrong_item", "not_received"],
      },
    ],
    // Anything unmatched is blocked. Never "allow by default".
    defaultDecision: "block",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

export function orderEvidence(ageSeconds = 3_600): Evidence {
  const retrievedAt = new Date(SANDBOX_NOW.getTime() - ageSeconds * 1_000).toISOString();
  return {
    id: EVIDENCE_ID,
    specVersion: "0.2",
    tenantId: TENANT_ID,
    caseId: CASE_ID,
    kind: "order",
    source: { system: "mock-shop", recordType: "order", recordId: ORDER_ID },
    summary: "ord_5001 delivered; item reported damaged",
    data: { status: "delivered", totalMinor: 9_900, currency: "USD" },
    retrievedAt,
    createdAt: retrievedAt,
  };
}

export interface RefundInput {
  minorUnits: number;
  /** A model asking for "execute" is the overreach case (§3). */
  requestedPermission?: Permission;
  /** The customer message tried to instruct the agent. */
  injectionSuspected?: boolean;
  /** How old the order evidence is; the policy allows 7 days. */
  evidenceAgeSeconds?: number;
  reasonCode?: string;
  /** Simulate a matching proposal already inside the duplicate window. */
  duplicateWithinWindow?: boolean;
}

export function refundProposal(input: RefundInput): ActionProposal {
  const reasonCode = input.reasonCode ?? "damaged";
  return {
    id: "prop_sandbox",
    specVersion: "0.2",
    tenantId: TENANT_ID,
    caseId: CASE_ID,
    profile: "ecommerce",
    actionType: "refund",
    reasonCode,
    params: { orderId: ORDER_ID, reason: reasonCode },
    requestedPermission: input.requestedPermission ?? "request-approval",
    requestedBy: {
      actorType: "model",
      actorId: "support-agent-1",
      model: { provider: "sandbox", model: "support-llm" },
    },
    amount: { currency: "USD", minorUnits: input.minorUnits },
    evidenceIds: [EVIDENCE_ID],
    idempotencyKey: "idem_sandbox_1",
    status: "proposed",
    createdAt: SANDBOX_NOW.toISOString(),
    updatedAt: SANDBOX_NOW.toISOString(),
  };
}

/** Run one request through the real engine. */
export function evaluateRefund(input: RefundInput): PolicyDecision {
  const proposal = refundProposal(input);
  const ctx: EvaluationContext = {
    policy: sandboxPolicy(),
    evidence: [orderEvidence(input.evidenceAgeSeconds ?? 3_600)],
    // An empty array means "the duplicate window WAS loaded and was empty".
    // undefined would fail closed with DUPLICATE_WINDOW_UNAVAILABLE — which is
    // itself one of the sandbox's teachable cases.
    recentProposals: input.duplicateWithinWindow
      ? [{ ...refundProposal(input), id: "prop_earlier", status: "executed" }]
      : [],
    injectionSuspected: input.injectionSuspected ?? false,
    now: SANDBOX_NOW,
  };
  return evaluateProposal(proposal, ctx);
}

export type PresetId = "small" | "large" | "overreach" | "injection" | "stale";

export interface Preset {
  id: PresetId;
  input: RefundInput;
}

export const PRESETS: Preset[] = [
  { id: "small", input: { minorUnits: 2_500 } },
  { id: "large", input: { minorUnits: 12_000 } },
  { id: "overreach", input: { minorUnits: 2_500, requestedPermission: "execute" } },
  { id: "injection", input: { minorUnits: 2_500, injectionSuspected: true } },
  // 30 days old, policy allows 7.
  { id: "stale", input: { minorUnits: 2_500, evidenceAgeSeconds: 30 * 86_400 } },
];

/** Every preset, evaluated — used by the tests and by the UI's summary table. */
export function runPresets(): Array<{ preset: Preset; decision: PolicyDecision }> {
  return PRESETS.map((preset) => ({ preset, decision: evaluateRefund(preset.input) }));
}
