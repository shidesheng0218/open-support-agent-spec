import { describe, expect, it } from "vitest";
import { createDemoFixtures, DEMO_TENANT_ID } from "./fixtures.js";

describe("createDemoFixtures", () => {
  it("contains every fixture required by CONTRACTS.md §11", () => {
    const f = createDemoFixtures();
    expect(f.tenantId).toBe(DEMO_TENANT_ID);
    expect(f.customers.map((c) => c.id).sort()).toEqual([
      "cus_blocked",
      "cus_expired",
      "cus_unverified",
      "cus_verified",
    ]);
    expect(f.customers.find((c) => c.id === "cus_verified")?.identityVerification.status).toBe(
      "verified",
    );
    expect(f.customers.find((c) => c.id === "cus_blocked")?.region).toBe("IR");
    expect(f.customers.find((c) => c.id === "cus_expired")?.region).toBe("DE");
    expect(f.orders.map((o) => o.id).sort()).toEqual(["ord_large", "ord_refunded", "ord_small"]);
    expect(f.orders.find((o) => o.id === "ord_small")?.total).toEqual({
      currency: "USD",
      minorUnits: 2500,
    });
    expect(f.orders.find((o) => o.id === "ord_large")?.total.minorUnits).toBe(90000);
    expect(f.orders.find((o) => o.id === "ord_refunded")?.status).toBe("refunded");
    expect(f.shipments.map((s) => s.id)).toEqual(["shp_small"]);
    expect(f.subscriptions.map((s) => s.id).sort()).toEqual(["sub_active", "sub_past_due"]);
    expect(f.subscriptions.find((s) => s.id === "sub_active")?.mrr.minorUnits).toBe(9900);
    expect(f.invoices.map((i) => i.id)).toEqual(["inv_001"]);
    expect(f.creditBalances.find((b) => b.customerId === "cus_verified")?.balance.minorUnits).toBe(
      0,
    );
    expect(f.knowledgeArticles.map((k) => k.id).sort()).toEqual([
      "kb_credit_policy",
      "kb_injection",
      "kb_refund_policy",
    ]);
    expect(f.cases.map((c) => c.id).sort()).toEqual([
      "case_credit",
      "case_dup",
      "case_refund",
      "case_unverified",
    ]);
    expect(f.evidence.map((e) => e.id).sort()).toEqual(["ev_expired", "ev_ord_small"]);
  });

  it("ships demo policy pol_demo v1.0.0 with the §11 rules", () => {
    const { policy } = createDemoFixtures();
    expect(policy.id).toBe("pol_demo");
    expect(policy.version).toBe("1.0.0");
    expect(policy.duplicateWindowSeconds).toBe(86400);
    expect(policy.maxEvidenceAgeSeconds).toBe(604800);
    expect(policy.defaultDecision).toBe("block");
    expect(policy.rules).toHaveLength(9);
    const refund = policy.rules.find((r) => r.actionType === "refund");
    expect(refund).toMatchObject({
      decision: "auto_execute",
      maxAmount: { currency: "USD", minorUnits: 5000 },
      reasonCodes: ["damaged", "wrong_item", "not_received", "other"],
      requireVerifiedIdentity: true,
      identityMaxAgeSeconds: 7776000,
      allowedRegions: ["US", "CA", "GB", "DE", "FR", "JP", "AU"],
      blockedRegions: ["IR", "KP", "CU"],
    });
    const credit = policy.rules.find((r) => r.actionType === "credit_apply");
    expect(credit).toMatchObject({
      decision: "require_approval",
      maxAmount: { currency: "USD", minorUnits: 10000 },
      reasonCodes: ["service_outage", "goodwill", "billing_error"],
    });
  });

  it("case_dup carries an already-executed refund proposal for ord_small", () => {
    const f = createDemoFixtures();
    const dup = f.proposals.find((p) => p.caseId === "case_dup");
    expect(dup).toBeDefined();
    expect(dup?.status).toBe("executed");
    expect(dup?.actionType).toBe("refund");
    expect(dup?.params).toEqual({ orderId: "ord_small" });
  });

  it("has fresh evidence for ord_small and an expired ev_expired", () => {
    const f = createDemoFixtures();
    const now = Date.now();
    const fresh = f.evidence.find((e) => e.id === "ev_ord_small");
    const stale = f.evidence.find((e) => e.id === "ev_expired");
    expect(fresh?.expiresAt && Date.parse(fresh.expiresAt)).toBeGreaterThan(now);
    expect(stale?.expiresAt && Date.parse(stale.expiresAt)).toBeLessThan(now);
  });

  it("kb_injection body contains a prompt-injection attempt", () => {
    const f = createDemoFixtures();
    const body = f.knowledgeArticles.find((k) => k.id === "kb_injection")?.body ?? "";
    expect(body).toMatch(/ignore all previous instructions/i);
    expect(body).toMatch(/无视(之前|以上|所有)指令/);
    expect(body).toMatch(/立即执行退款/);
  });

  it("returns fresh deep copies (no shared mutable state between calls)", () => {
    const a = createDemoFixtures();
    const b = createDemoFixtures();
    a.orders[0]!.status = "cancelled";
    a.policy.rules.pop();
    a.customers[0]!.tags.push("mutated");
    expect(b.orders[0]!.status).toBe("delivered");
    expect(b.policy.rules).toHaveLength(9);
    expect(b.customers[0]!.tags).toEqual(["demo"]);
  });
});
