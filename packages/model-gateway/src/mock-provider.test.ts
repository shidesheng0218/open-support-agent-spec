import { describe, expect, it } from "vitest";
import { MockModelProvider } from "./mock-provider.js";
import type { ModelRequest } from "./types.js";

function req(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    tier: "standard",
    task: "propose",
    messages: [
      { role: "system", content: "You are a support agent for case_refund." },
      {
        role: "user",
        content: "Please refund order ord_small on case_refund, it arrived damaged. $25",
      },
    ],
    ...over,
  };
}

describe("MockModelProvider", () => {
  it("is deterministic: same input → same output", async () => {
    const p = new MockModelProvider();
    const a = await p.complete(req());
    const b = await p.complete(req());
    expect(a).toEqual(b);
    expect(a.telemetry.inputTokens).toBeGreaterThan(0);
    expect(a.telemetry.outputTokens).toBeGreaterThan(0);
    expect(a.telemetry.latencyMs).toBeGreaterThan(0);
    expect(a.telemetry.costUsd).toBeLessThan(0.001);
  });

  it("supports all tiers", () => {
    const p = new MockModelProvider();
    expect(p.supports("classify")).toBe(true);
    expect(p.supports("standard")).toBe(true);
    expect(p.supports("reasoning")).toBe(true);
  });

  it("propose + refund keyword → refund ActionProposal JSON", async () => {
    const p = new MockModelProvider();
    const res = await p.complete(req());
    const parsed = res.parsed as Record<string, any>;
    expect(parsed).toBeDefined();
    expect(parsed.actionType).toBe("refund");
    expect(parsed.profile).toBe("ecommerce");
    expect(parsed.caseId).toBe("case_refund");
    expect(parsed.params.orderId).toBe("ord_small");
    expect(parsed.amount).toEqual({ currency: "USD", minorUnits: 2500 });
    expect(parsed.requestedPermission).toBe("request-approval");
    expect(parsed.requestedBy.actorType).toBe("model");
    expect(parsed.requestedBy.actorId).toBe("mock-local");
    expect(parsed.idempotencyKey).toMatch(/^idem_mock_[0-9a-f]{8}$/);
  });

  it("propose + 退款 keyword → refund as well", async () => {
    const p = new MockModelProvider();
    const res = await p.complete(
      req({
        messages: [{ role: "user", content: "我要退款 case_refund ord_small" }],
      }),
    );
    expect((res.parsed as any).actionType).toBe("refund");
  });

  it("propose + credit keyword → credit_apply", async () => {
    const p = new MockModelProvider();
    const res = await p.complete(
      req({
        messages: [
          { role: "user", content: "Apply a $10 credit for case_credit cus_verified" },
        ],
      }),
    );
    const parsed = res.parsed as any;
    expect(parsed.actionType).toBe("credit_apply");
    expect(parsed.profile).toBe("saas");
    expect(parsed.amount).toEqual({ currency: "USD", minorUnits: 1000 });
  });

  it("propose + 额度 keyword → credit_apply", async () => {
    const p = new MockModelProvider();
    const res = await p.complete(
      req({ messages: [{ role: "user", content: "申请额度补偿 case_credit" }] }),
    );
    expect((res.parsed as any).actionType).toBe("credit_apply");
  });

  it("propose + cancel keyword → subscription_cancel with sub id", async () => {
    const p = new MockModelProvider();
    const res = await p.complete(
      req({
        messages: [
          { role: "user", content: "Cancel subscription sub_active on case_credit" },
        ],
      }),
    );
    const parsed = res.parsed as any;
    expect(parsed.actionType).toBe("subscription_cancel");
    expect(parsed.params.subscriptionId).toBe("sub_active");
    expect(parsed.amount).toBeUndefined();
  });

  it("propose + 取消 keyword → subscription_cancel", async () => {
    const p = new MockModelProvider();
    const res = await p.complete(
      req({
        messages: [{ role: "user", content: "取消订阅 sub_active case_credit" }],
      }),
    );
    expect((res.parsed as any).actionType).toBe("subscription_cancel");
  });

  it("defaults amount to 2500 USD minorUnits when no $ amount present", async () => {
    const p = new MockModelProvider();
    const res = await p.complete(
      req({
        messages: [{ role: "user", content: "refund ord_small case_refund" }],
      }),
    );
    expect((res.parsed as any).amount).toEqual({
      currency: "USD",
      minorUnits: 2500,
    });
  });

  it("reply task returns deterministic short support-reply text", async () => {
    const p = new MockModelProvider();
    const res = await p.complete(
      req({ task: "reply", messages: [{ role: "user", content: "hello, where is my order? case_refund" }] }),
    );
    expect(res.text).toContain("case_refund");
    expect(res.parsed).toBeUndefined();
    const again = await p.complete(
      req({ task: "reply", messages: [{ role: "user", content: "hello, where is my order? case_refund" }] }),
    );
    expect(again.text).toBe(res.text);
  });

  it("classify returns a category string", async () => {
    const p = new MockModelProvider();
    const refund = await p.complete(
      req({ task: "classify", messages: [{ role: "user", content: "I want a refund" }] }),
    );
    expect(refund.text).toBe("refund_request");
    const general = await p.complete(
      req({ task: "classify", messages: [{ role: "user", content: "hi there" }] }),
    );
    expect(general.text).toBe("general_inquiry");
  });

  it("idempotencyKey is stable per case+action+params and differs across scenarios", async () => {
    const p = new MockModelProvider();
    const a = await p.complete(req());
    const b = await p.complete(req());
    expect((a.parsed as any).idempotencyKey).toBe((b.parsed as any).idempotencyKey);
    const c = await p.complete(
      req({
        messages: [{ role: "user", content: "refund ord_large on case_refund $900" }],
      }),
    );
    expect((c.parsed as any).idempotencyKey).not.toBe(
      (a.parsed as any).idempotencyKey,
    );
  });
});
