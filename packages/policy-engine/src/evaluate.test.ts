import { describe, expect, it } from "vitest";
import { evaluateProposal } from "./evaluate.js";
import {
  FIXTURE_NOW,
  daysAgo,
  makeCustomer,
  makeEvidence,
  makePolicy,
  makeProposal,
} from "./fixtures.js";
import { compareMoney, compareMoneySafe } from "./money.js";
import { stableStringify } from "./stable-stringify.js";
import type { ActionProposal } from "./types.js";

function baseCtx(over: Record<string, unknown> = {}) {
  return {
    customer: makeCustomer(),
    evidence: [makeEvidence()],
    policy: makePolicy(),
    recentProposals: [] as ActionProposal[],
    injectionSuspected: false,
    now: FIXTURE_NOW,
    ...over,
  };
}

describe("evaluateProposal — §4 policy matrix", () => {
  it("auto_execute: small verified fresh-evidence refund", () => {
    const d = evaluateProposal(makeProposal(), baseCtx());
    expect(d.decision).toBe("auto_execute");
    expect(d.reasons).toEqual([]);
    expect(d.policyVersion).toBe("1.0.0");
    expect(d.evaluatedAt).toBe(FIXTURE_NOW.toISOString());
  });

  it("require_approval: OVER_THRESHOLD when amount exceeds rule maxAmount", () => {
    const d = evaluateProposal(
      makeProposal({ amount: { currency: "USD", minorUnits: 9000 } }),
      baseCtx(),
    );
    expect(d.decision).toBe("require_approval");
    expect(d.reasons.map((r) => r.code)).toContain("OVER_THRESHOLD");
  });

  it("block: IDENTITY_UNVERIFIED when identity is unverified", () => {
    const customer = makeCustomer({
      identityVerification: { status: "unverified" },
    });
    const d = evaluateProposal(makeProposal(), baseCtx({ customer }));
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("IDENTITY_UNVERIFIED");
  });

  it("block: IDENTITY_UNVERIFIED when identity is expired", () => {
    const customer = makeCustomer({
      identityVerification: { status: "expired", verifiedAt: daysAgo(400) },
    });
    const d = evaluateProposal(makeProposal(), baseCtx({ customer }));
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("IDENTITY_UNVERIFIED");
  });

  it("block: IDENTITY_UNVERIFIED when verified identity is older than identityMaxAgeSeconds", () => {
    const customer = makeCustomer({
      identityVerification: { status: "verified", verifiedAt: daysAgo(100) },
    });
    const policy = makePolicy();
    policy.rules[0]!.identityMaxAgeSeconds = 86400; // 1 day
    const d = evaluateProposal(makeProposal(), baseCtx({ customer, policy }));
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("IDENTITY_UNVERIFIED");
  });

  it("block: IDENTITY_REQUIRED when customer is missing", () => {
    const d = evaluateProposal(makeProposal(), baseCtx({ customer: undefined }));
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("IDENTITY_REQUIRED");
  });

  it("block: REGION_BLOCKED for blocked region", () => {
    const customer = makeCustomer({ region: "IR" });
    const d = evaluateProposal(makeProposal(), baseCtx({ customer }));
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("REGION_BLOCKED");
  });

  it("require_approval: REGION_UNLISTED for region outside allowedRegions", () => {
    const customer = makeCustomer({ region: "BR" });
    const d = evaluateProposal(makeProposal(), baseCtx({ customer }));
    expect(d.decision).toBe("require_approval");
    expect(d.reasons.map((r) => r.code)).toContain("REGION_UNLISTED");
  });

  it("block: REASON_CODE_NOT_ALLOWED", () => {
    const d = evaluateProposal(
      makeProposal({ reasonCode: "changed_my_mind" }),
      baseCtx(),
    );
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("REASON_CODE_NOT_ALLOWED");
  });

  it("block: NO_RULE when no rule matches actionType", () => {
    const policy = makePolicy();
    policy.rules = policy.rules.filter((r) => r.actionType !== "refund");
    const d = evaluateProposal(makeProposal(), baseCtx({ policy }));
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("NO_RULE");
  });

  it("block: DUPLICATE_REQUEST within window with deep-equal params", () => {
    const prior = makeProposal({
      id: "prop_prior",
      status: "executed",
      createdAt: daysAgo(1),
      // params key order differs on purpose — deep-equal must be stable
      params: { reason: "damaged", orderId: "ord_small" },
    });
    const d = evaluateProposal(
      makeProposal(),
      baseCtx({ recentProposals: [prior] }),
    );
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("DUPLICATE_REQUEST");
  });

  it("no DUPLICATE_REQUEST when the prior proposal is outside the window", () => {
    const prior = makeProposal({
      id: "prop_prior",
      status: "executed",
      createdAt: daysAgo(3),
    });
    const d = evaluateProposal(
      makeProposal(),
      baseCtx({ recentProposals: [prior] }),
    );
    expect(d.decision).toBe("auto_execute");
  });

  it("no DUPLICATE_REQUEST when the prior proposal has different params or terminal status", () => {
    const different = makeProposal({
      id: "prop_a",
      status: "executed",
      createdAt: daysAgo(1),
      params: { orderId: "ord_large", reason: "damaged" },
    });
    const rejected = makeProposal({
      id: "prop_b",
      status: "rejected",
      createdAt: daysAgo(1),
    });
    const d = evaluateProposal(
      makeProposal(),
      baseCtx({ recentProposals: [different, rejected] }),
    );
    expect(d.decision).toBe("auto_execute");
  });

  it("require_approval: EVIDENCE_STALE when evidence is expired", () => {
    const evidence = makeEvidence({ expiresAt: daysAgo(1) });
    const d = evaluateProposal(makeProposal(), baseCtx({ evidence: [evidence] }));
    expect(d.decision).toBe("require_approval");
    expect(d.reasons.map((r) => r.code)).toContain("EVIDENCE_STALE");
  });

  it("require_approval: EVIDENCE_STALE when retrievedAt is older than maxEvidenceAgeSeconds", () => {
    const evidence = makeEvidence({ retrievedAt: daysAgo(10) });
    const d = evaluateProposal(makeProposal(), baseCtx({ evidence: [evidence] }));
    expect(d.decision).toBe("require_approval");
    expect(d.reasons.map((r) => r.code)).toContain("EVIDENCE_STALE");
  });

  it("block: INSUFFICIENT_EVIDENCE on financial action without evidenceIds", () => {
    const d = evaluateProposal(makeProposal({ evidenceIds: [] }), baseCtx());
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("INSUFFICIENT_EVIDENCE");
  });

  it("block: PERMISSION_OVERREACH when a model requests execute", () => {
    const d = evaluateProposal(
      makeProposal({ requestedPermission: "execute" }),
      baseCtx(),
    );
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("PERMISSION_OVERREACH");
  });

  it("no PERMISSION_OVERREACH when a human requests execute", () => {
    const d = evaluateProposal(
      makeProposal({
        requestedPermission: "execute",
        requestedBy: { actorType: "human", actorId: "agent_1" },
      }),
      baseCtx(),
    );
    expect(d.decision).toBe("auto_execute");
  });

  it("block: PROMPT_INJECTION_SUSPECTED", () => {
    const d = evaluateProposal(
      makeProposal(),
      baseCtx({ injectionSuspected: true }),
    );
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain(
      "PROMPT_INJECTION_SUSPECTED",
    );
  });

  it("require_approval: CURRENCY_MISMATCH between amount and rule maxAmount", () => {
    const d = evaluateProposal(
      makeProposal({ amount: { currency: "EUR", minorUnits: 2500 } }),
      baseCtx(),
    );
    expect(d.decision).toBe("require_approval");
    expect(d.reasons.map((r) => r.code)).toContain("CURRENCY_MISMATCH");
  });

  it("block: PROFILE_MISMATCH when actionType does not belong to proposal.profile", () => {
    const d = evaluateProposal(makeProposal({ profile: "saas" }), baseCtx());
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("PROFILE_MISMATCH");
  });

  it("collects multiple reasons and returns the worst decision", () => {
    const customer = makeCustomer({ region: "BR" }); // REGION_UNLISTED → require_approval
    const d = evaluateProposal(
      makeProposal({
        requestedPermission: "execute", // PERMISSION_OVERREACH → block
        amount: { currency: "USD", minorUnits: 9000 }, // OVER_THRESHOLD
      }),
      baseCtx({ customer, injectionSuspected: true }),
    );
    expect(d.decision).toBe("block");
    const codes = d.reasons.map((r) => r.code);
    expect(codes).toContain("PERMISSION_OVERREACH");
    expect(codes).toContain("PROMPT_INJECTION_SUSPECTED");
    expect(codes).toContain("OVER_THRESHOLD");
    expect(codes).toContain("REGION_UNLISTED");
  });

  it("rule.decision require_approval applies when no reasons fire", () => {
    const d = evaluateProposal(
      makeProposal({
        profile: "saas",
        actionType: "subscription_cancel",
        reasonCode: "other",
        params: { subscriptionId: "sub_active" },
        amount: undefined,
        evidenceIds: [],
      }),
      baseCtx(),
    );
    expect(d.decision).toBe("require_approval");
    expect(d.reasons).toEqual([]);
  });
});

describe("evaluateProposal — exchange_request (never model-executed)", () => {
  const exchangeProposal = (over: Record<string, unknown> = {}) =>
    makeProposal({
      actionType: "exchange_request",
      reasonCode: "wrong_item",
      params: {
        orderId: "ord_small",
        originalLineId: "line_1",
        replacementSku: "sku_mug_v2",
      },
      amount: undefined,
      evidenceIds: ["ev_order"],
      ...over,
    });

  it("require_approval by default with the demo policy rule", () => {
    const d = evaluateProposal(exchangeProposal(), baseCtx());
    expect(d.decision).toBe("require_approval");
  });

  it("capped at require_approval even when a tenant rule says auto_execute", () => {
    const policy = makePolicy();
    policy.rules = policy.rules.map((r) =>
      r.actionType === "exchange_request" ? { ...r, decision: "auto_execute" as const } : r,
    );
    const d = evaluateProposal(exchangeProposal(), baseCtx({ policy }));
    expect(d.decision).toBe("require_approval");
    expect(d.reasons.map((r) => r.code)).toContain("NEVER_AUTO_EXECUTE");
  });

  it("block: NO_RULE when no rule matches exchange_request (fail closed)", () => {
    const policy = makePolicy();
    policy.rules = policy.rules.filter((r) => r.actionType !== "exchange_request");
    const d = evaluateProposal(exchangeProposal(), baseCtx({ policy }));
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("NO_RULE");
  });

  it("block: INSUFFICIENT_EVIDENCE when no evidence references the original order", () => {
    const d = evaluateProposal(exchangeProposal({ evidenceIds: [] }), baseCtx());
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("INSUFFICIENT_EVIDENCE");
  });

  it("block: PROFILE_MISMATCH when proposed under a non-ecommerce profile", () => {
    const d = evaluateProposal(exchangeProposal({ profile: "core" }), baseCtx());
    expect(d.decision).toBe("block");
    expect(d.reasons.map((r) => r.code)).toContain("PROFILE_MISMATCH");
  });
});

describe("money helpers", () => {
  it("compares minorUnits within the same currency", () => {
    expect(
      compareMoney(
        { currency: "USD", minorUnits: 100 },
        { currency: "USD", minorUnits: 200 },
      ),
    ).toBeLessThan(0);
    expect(
      compareMoneySafe(
        { currency: "USD", minorUnits: 200 },
        { currency: "USD", minorUnits: 200 },
      ),
    ).toBe(0);
  });

  it("is currency-aware", () => {
    expect(() =>
      compareMoney(
        { currency: "USD", minorUnits: 1 },
        { currency: "EUR", minorUnits: 1 },
      ),
    ).toThrow(RangeError);
    expect(
      compareMoneySafe(
        { currency: "USD", minorUnits: 1 },
        { currency: "EUR", minorUnits: 1 },
      ),
    ).toBeNull();
  });
});

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ a: 1, b: { c: [1, 2], d: null } })).toBe(
      stableStringify({ b: { d: null, c: [1, 2] }, a: 1 }),
    );
  });
});
