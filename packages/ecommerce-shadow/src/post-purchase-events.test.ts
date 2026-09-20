import { describe, expect, it } from "vitest";
import { normalizePostPurchaseEvent } from "./post-purchase-events.js";

describe("post-purchase event normalization", () => {
  it("normalizes a verified UCP refund event into a tenant-scoped ProviderEvent", () => {
    const event = normalizePostPurchaseEvent({
      id: "event_ucp_refund_1",
      protocol: "ucp",
      tenantId: "tenant_acme",
      providerEventId: "ucp_refund_123",
      eventType: "refund.succeeded",
      idempotencyKey: "refund_123",
      occurredAt: "2026-09-20T00:00:00.000Z",
      payload: {
        orderId: "ord_123",
        refundId: "refund_123",
        amount: { currency: "USD", minorUnits: 2500 },
      },
      now: new Date("2026-09-20T00:01:00.000Z"),
    });

    expect(event).toMatchObject({
      id: "event_ucp_refund_1",
      specVersion: "0.3",
      tenantId: "tenant_acme",
      provider: "ucp",
      providerEventId: "ucp_refund_123",
      eventType: "refund.succeeded",
      idempotencyKey: "refund_123",
      occurredAt: "2026-09-20T00:00:00.000Z",
      createdAt: "2026-09-20T00:01:00.000Z",
      payload: {
        source: { protocol: "ucp", eventType: "refund.succeeded" },
        data: {
          orderId: "ord_123",
          refundId: "refund_123",
          amount: { currency: "USD", minorUnits: 2500 },
        },
      },
    });
    expect(event.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed for an unsupported post-purchase event type", () => {
    expect(() =>
      normalizePostPurchaseEvent({
        id: "event_ucp_unknown_1",
        protocol: "acp",
        tenantId: "tenant_acme",
        providerEventId: "acp_unknown_123",
        eventType: "refund.reversed",
        idempotencyKey: "refund_123",
        occurredAt: "2026-09-20T00:00:00.000Z",
        payload: { refundId: "refund_123" },
      }),
    ).toThrow("Unsupported post-purchase event type: refund.reversed");
  });

  it("rejects a missing provider event identity before it reaches event deduplication", () => {
    expect(() =>
      normalizePostPurchaseEvent({
        id: "event_acp_refund_1",
        protocol: "acp",
        tenantId: "tenant_acme",
        providerEventId: " ",
        eventType: "refund.succeeded",
        idempotencyKey: "refund_123",
        occurredAt: "2026-09-20T00:00:00.000Z",
        payload: { refundId: "refund_123" },
      }),
    ).toThrow("providerEventId must be a non-empty string");
  });
});
