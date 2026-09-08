/**
 * Minimal embeddable example for @osas/policy-engine.
 *
 * The model proposes write actions; the deterministic policy engine decides.
 * No OSAS API server, MCP server, or database is involved — everything below
 * is plain in-memory TypeScript.
 *
 * Run from the repo root:
 *   pnpm install && pnpm build
 *   node examples/embed-policy-engine/dist/main.js
 */
import assert from "node:assert/strict";
import {
  evaluateProposal,
  type ActionProposal,
  type EvaluationContext,
  type Permission,
  type PolicyDecision,
  type TenantPolicy,
} from "@osas/policy-engine";

const NOW = new Date("2026-09-07T12:00:00.000Z");

// 1. Define the tenant policy: refunds auto-execute up to $50.00 USD,
//    anything larger escalates to a human. Everything unmatched is blocked
//    by default (defaultDecision is always "block").
const policy: TenantPolicy = {
  id: "pol_acme",
  specVersion: "0.2",
  tenantId: "tenant_acme",
  version: "1.0.0",
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  duplicateWindowSeconds: 86400,
  maxEvidenceAgeSeconds: 604800,
  rules: [
    {
      actionType: "refund",
      decision: "auto_execute",
      maxAmount: { currency: "USD", minorUnits: 5000 }, // $50.00
      reasonCodes: ["damaged", "wrong_item", "not_received"],
    },
  ],
  defaultDecision: "block",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

// Evaluation context: inject everything the engine may need to know.
// `now` is injectable so evaluation is fully deterministic in tests.
const ctx: EvaluationContext = {
  policy,
  evidence: [],
  recentProposals: [],
  injectionSuspected: false,
  now: NOW,
};

let seq = 0;
function refundProposal(
  minorUnits: number,
  requestedPermission: Permission = "request-approval",
): ActionProposal {
  seq += 1;
  return {
    id: `prop_${seq}`,
    specVersion: "0.2",
    tenantId: policy.tenantId,
    caseId: "case_1001",
    profile: "ecommerce",
    actionType: "refund",
    reasonCode: "damaged",
    params: { orderId: "ord_5001" },
    requestedPermission,
    requestedBy: {
      actorType: "model",
      actorId: "support-agent-1",
      model: { provider: "example-provider", model: "support-llm-v1" },
    },
    amount: { currency: "USD", minorUnits },
    evidenceIds: ["ev_order_5001"],
    idempotencyKey: `idem_${seq}`,
    status: "proposed",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function show(label: string, decision: PolicyDecision): void {
  const reasons =
    decision.reasons.length > 0
      ? decision.reasons.map((r) => `${r.code} (${r.message})`).join("; ")
      : "none — all checks passed";
  console.log(`${label}`);
  console.log(`  decision: ${decision.decision}`);
  console.log(`  reasons:  ${reasons}`);
  console.log();
}

// 2. Small refund, within the rule limit -> auto_execute.
const small = evaluateProposal(refundProposal(2500), ctx);
show("$25.00 refund, within the $50.00 rule limit:", small);
assert.equal(small.decision, "auto_execute");

// 3. Refund above maxAmount -> require_approval (route it to your human queue).
const large = evaluateProposal(refundProposal(50000), ctx);
show("$500.00 refund, above the $50.00 rule limit:", large);
assert.equal(large.decision, "require_approval");
assert.ok(large.reasons.some((r) => r.code === "OVER_THRESHOLD"));

// 4. A model principal requesting "execute" is always blocked (§3).
const overreach = evaluateProposal(refundProposal(2500, "execute"), ctx);
show("model principal requests the 'execute' permission:", overreach);
assert.equal(overreach.decision, "block");
assert.ok(overreach.reasons.some((r) => r.code === "PERMISSION_OVERREACH"));

console.log("All assertions passed.");
