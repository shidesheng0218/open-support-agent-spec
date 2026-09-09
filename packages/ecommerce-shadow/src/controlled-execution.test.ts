import { describe, expect, it } from "vitest";
import type { ActionProposal, ExecutionResult } from "@osas/core";
import {
  createExecutionAttempt,
  createExecutionReceipt,
  createReconciliationTask,
  InMemoryProviderEventStore,
} from "./controlled-execution.js";

const proposal: ActionProposal = {
  id: "prop_controlled",
  specVersion: "0.2",
  tenantId: "tenant_demo",
  caseId: "case_refund",
  profile: "ecommerce",
  actionType: "refund",
  reasonCode: "damaged",
  params: { orderId: "ord_small" },
  requestedPermission: "request-approval",
  requestedBy: { actorType: "human", actorId: "agent_1" },
  amount: { currency: "USD", minorUnits: 2500 },
  evidenceIds: ["ev_ord_small"],
  idempotencyKey: "controlled-1",
  status: "approved",
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};

describe("controlled execution records", () => {
  it("hashes the execution request deterministically", () => {
    const a = createExecutionAttempt(proposal, "sandbox", {
      id: "attempt_1",
      now: new Date("2026-09-09T00:00:00.000Z"),
    });
    const b = createExecutionAttempt(
      { ...proposal, params: { orderId: "ord_small" } },
      "sandbox",
      { id: "attempt_2", now: new Date("2026-09-09T00:00:00.000Z") },
    );
    expect(a.requestHash).toBe(b.requestHash);
    expect(a.status).toBe("started");
    expect(a.specVersion).toBe("0.3");
  });

  it("creates a non-retryable receipt and reconciliation task for uncertain results", () => {
    const attempt = createExecutionAttempt(proposal, "sandbox", { id: "attempt_1" });
    const result: ExecutionResult = {
      status: "uncertain",
      detail: "provider timeout",
      providerStatus: "sandbox_unknown",
    };
    const receipt = createExecutionReceipt(attempt, result, { id: "receipt_1" });
    const task = createReconciliationTask(attempt, result, { id: "recon_1" });
    expect(receipt.safeToRetry).toBe(false);
    expect(task.status).toBe("open");
    expect(task.queryKey).toBe("tenant_demo:controlled-1");
  });

  it("deduplicates provider events by tenant, provider and event id", async () => {
    const store = new InMemoryProviderEventStore();
    const event = {
      id: "event_1",
      specVersion: "0.3" as const,
      tenantId: "tenant_demo",
      provider: "sandbox",
      providerEventId: "evt_1",
      eventType: "refund.succeeded",
      idempotencyKey: "controlled-1",
      occurredAt: "2026-09-09T00:00:00.000Z",
      payloadHash: "hash",
      payload: { status: "succeeded" },
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    expect((await store.append(event)).duplicate).toBe(false);
    expect((await store.append({ ...event, id: "event_2" })).duplicate).toBe(true);
    expect((await store.list("tenant_demo"))).toHaveLength(1);
  });
});
