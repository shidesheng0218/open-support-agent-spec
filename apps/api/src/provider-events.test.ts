import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("post-purchase provider event ingestion", () => {
  it("normalizes a verified UCP refund event before it enters the audit and reconciliation flow", async () => {
    app = await buildApp({
      logger: false,
      env: { OSAS_PROVIDER_EVENT_KEY: "provider-event-key" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/provider-events",
      headers: { "x-osas-provider-key": "provider-event-key" },
      payload: {
        provider: "ucp",
        providerEventId: "ucp_refund_123",
        eventType: "refund.succeeded",
        idempotencyKey: "refund_123",
        occurredAt: "2026-09-20T00:00:00.000Z",
        payload: { orderId: "ord_123", refundId: "refund_123", status: "succeeded" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().event).toMatchObject({
      provider: "ucp",
      eventType: "refund.succeeded",
      payload: {
        source: { protocol: "ucp", eventType: "refund.succeeded" },
        data: { orderId: "ord_123", refundId: "refund_123", status: "succeeded" },
      },
    });
  });

  it("rejects unsupported UCP or ACP event types instead of treating them as a valid provider event", async () => {
    app = await buildApp({
      logger: false,
      env: { OSAS_PROVIDER_EVENT_KEY: "provider-event-key" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/provider-events",
      headers: { "x-osas-provider-key": "provider-event-key" },
      payload: {
        provider: "acp",
        providerEventId: "acp_refund_123",
        eventType: "refund.reversed",
        idempotencyKey: "refund_123",
        occurredAt: "2026-09-20T00:00:00.000Z",
        payload: { refundId: "refund_123", status: "succeeded" },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("SCHEMA_INVALID");
  });
});
