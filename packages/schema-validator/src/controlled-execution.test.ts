import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSchemasDir, validateInline } from "./index.js";

const schema = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(resolveSchemasDir(), "execution-v0.3", `${name}.json`), "utf8"),
  ) as Record<string, unknown>;

describe("controlled execution schemas", () => {
  it("validates an execution receipt", () => {
    const result = validateInline(schema("execution-receipt"), {
      id: "receipt_1",
      specVersion: "0.3",
      tenantId: "tenant_demo",
      proposalId: "prop_1",
      attemptId: "attempt_1",
      status: "uncertain",
      detail: "provider timeout",
      safeToRetry: false,
      createdAt: "2026-09-09T00:00:00.000Z",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects provider events with a wrong spec version or unknown fields", () => {
    const value = {
      id: "event_1",
      specVersion: "0.2",
      tenantId: "tenant_demo",
      provider: "sandbox",
      providerEventId: "evt_1",
      eventType: "refund.succeeded",
      idempotencyKey: "k1",
      occurredAt: "2026-09-09T00:00:00.000Z",
      payloadHash: "abc",
      payload: {},
      createdAt: "2026-09-09T00:00:00.000Z",
      unexpected: true,
    };
    expect(validateInline(schema("provider-event"), value).valid).toBe(false);
  });
});
