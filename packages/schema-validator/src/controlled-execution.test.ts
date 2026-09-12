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

  it("validates a Top-10 after-sales case and rejects an unknown status", () => {
    const value = {
      id: "ascase_1",
      tenantId: "tenant_demo",
      sourceCaseId: "case_refund",
      scenarioCode: "refund_request",
      orderId: "ord_small",
      customerId: "cus_verified",
      status: "pending_approval",
      riskLevel: "high",
      evidenceIds: ["ev_ord_small"],
      policyVersion: "1.0.0",
      idempotencyKey: "after-sales-schema-1",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    expect(validateInline(schema("after-sales-case"), value).valid).toBe(true);
    expect(
      validateInline(schema("after-sales-case"), { ...value, status: "executed" }).valid,
    ).toBe(false);
  });

  it("validates an after-sales decision and rejects unknown fields", () => {
    const value = {
      outcome: "approval_required",
      reasonCodes: ["OVER_THRESHOLD"],
      requiredEvidence: ["order"],
      missingEvidence: [],
      operatorSummary: "Human approval is required for this amount.",
    };
    expect(validateInline(schema("after-sales-decision"), value).valid).toBe(true);
    expect(validateInline(schema("after-sales-decision"), { ...value, unexpected: true }).valid).toBe(false);
  });
});
