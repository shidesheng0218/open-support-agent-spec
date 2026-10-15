import { describe, expect, it } from "vitest";
import type { Evidence, ExecutionResult, TenantPolicy } from "@osas/core";
import { createAgentGuard, GuardError, type ProposeInput } from "./index.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const TENANT = "tenant_acme";

const policy: TenantPolicy = {
  id: "pol_acme",
  specVersion: "0.2",
  tenantId: TENANT,
  version: "1.0.0",
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  duplicateWindowSeconds: 86400,
  maxEvidenceAgeSeconds: 604800,
  rules: [
    {
      actionType: "refund",
      decision: "auto_execute",
      maxAmount: { currency: "USD", minorUnits: 5000 },
      reasonCodes: ["damaged", "wrong_item", "not_received"],
    },
  ],
  defaultDecision: "block",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function evidence(id = "ev_1", tenantId = TENANT): Evidence {
  return {
    id,
    specVersion: "0.2",
    tenantId,
    caseId: "case_1",
    kind: "order",
    source: { system: "test", recordType: "order", recordId: "ord_1" },
    summary: "order",
    data: { orderId: "ord_1" },
    retrievedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  };
}

function refund(minorUnits: number, over: Partial<ProposeInput> = {}): ProposeInput {
  return {
    tenantId: TENANT,
    caseId: "case_1",
    actionType: "refund",
    reasonCode: "damaged",
    params: { orderId: "ord_1" },
    amount: { currency: "USD", minorUnits },
    evidence: [evidence()],
    idempotencyKey: `idem_${minorUnits}_${Math.random()}`,
    requestedBy: { actorType: "model", actorId: "agent_1", model: { provider: "p", model: "m" } },
    ...over,
  };
}

function setup(result: ExecutionResult = { status: "succeeded", externalRef: "re_1" }, ttl?: number) {
  const calls: unknown[] = [];
  let clock = NOW;
  const guard = createAgentGuard({
    executor: {
      async executeAction(_ctx, proposal) {
        calls.push(proposal);
        return result;
      },
    },
    policyFor: () => policy,
    now: () => clock,
    ...(ttl === undefined ? {} : { approvalTtlSeconds: ttl }),
  });
  return { guard, calls, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

describe("agent-guard", () => {
  it("executes a small refund automatically and calls the executor once", async () => {
    const { guard, calls } = setup();
    const r = await guard.propose(refund(2500));
    expect(r.outcome).toBe("executed");
    expect(calls).toHaveLength(1);
  });

  it("parks a large refund for approval without calling the executor", async () => {
    const { guard, calls } = setup();
    const r = await guard.propose(refund(50000));
    expect(r.outcome).toBe("pending_approval");
    if (r.outcome !== "pending_approval") return;
    expect(r.pending.actionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toHaveLength(0);
  });

  it("executes after a matching approval and only once", async () => {
    const { guard, calls } = setup();
    const r = await guard.propose(refund(50000));
    if (r.outcome !== "pending_approval") throw new Error("expected pending");
    const done = await guard.decide(r.pending, { approve: true, approverId: "alice" });
    expect(done.outcome).toBe("executed");
    expect(calls).toHaveLength(1);
    await expect(guard.decide(r.pending, { approve: true, approverId: "alice" })).rejects.toMatchObject({
      code: "UNKNOWN_PROPOSAL",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejecting executes nothing", async () => {
    const { guard, calls } = setup();
    const r = await guard.propose(refund(50000));
    if (r.outcome !== "pending_approval") throw new Error("expected pending");
    const done = await guard.decide(r.pending, { approve: false, approverId: "alice" });
    expect(done.outcome).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("refuses a digest that does not match what is held", async () => {
    const { guard, calls } = setup();
    const r = await guard.propose(refund(50000));
    if (r.outcome !== "pending_approval") throw new Error("expected pending");
    await expect(
      guard.decide({ ...r.pending, actionDigest: "a".repeat(64) }, { approve: true, approverId: "alice" }),
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    expect(calls).toHaveLength(0);
  });

  it("another tenant cannot decide this tenant's approval", async () => {
    const { guard, calls } = setup();
    const r = await guard.propose(refund(50000));
    if (r.outcome !== "pending_approval") throw new Error("expected pending");
    await expect(
      guard.decide({ ...r.pending, tenantId: "tenant_other" }, { approve: true, approverId: "mallory" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_PROPOSAL" });
    expect(calls).toHaveLength(0);
  });

  it("an expired approval cannot be used, and cannot be retried", async () => {
    const { guard, calls, advance } = setup(undefined, 60);
    const r = await guard.propose(refund(50000));
    if (r.outcome !== "pending_approval") throw new Error("expected pending");
    advance(61_000);
    await expect(guard.decide(r.pending, { approve: true, approverId: "alice" })).rejects.toMatchObject({
      code: "APPROVAL_EXPIRED",
    });
    await expect(guard.decide(r.pending, { approve: true, approverId: "alice" })).rejects.toMatchObject({
      code: "UNKNOWN_PROPOSAL",
    });
    expect(calls).toHaveLength(0);
  });

  it("requires an approver id", async () => {
    const { guard } = setup();
    const r = await guard.propose(refund(50000));
    if (r.outcome !== "pending_approval") throw new Error("expected pending");
    await expect(guard.decide(r.pending, { approve: true, approverId: "  " })).rejects.toBeInstanceOf(GuardError);
  });

  it("blocks an action with no rule, and a model asking for execute", async () => {
    const { guard, calls } = setup();
    const noRule = await guard.propose(refund(100, { actionType: "credit_apply" }));
    expect(noRule.outcome).toBe("blocked");
    const overreach = await guard.propose(refund(2500, { requestedPermission: "execute" }));
    expect(overreach.outcome).toBe("blocked");
    if (overreach.outcome === "blocked") {
      expect(overreach.decision.reasons.some((x) => x.code === "PERMISSION_OVERREACH")).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("does not trust evidence from another tenant", async () => {
    const { guard, calls } = setup();
    const r = await guard.propose(refund(2500, { evidence: [evidence("ev_x", "tenant_other")] }));
    expect(r.outcome).not.toBe("executed");
    expect(calls).toHaveLength(0);
  });

  it("blocks a refund with no evidence at all", async () => {
    const { guard, calls } = setup();
    const r = await guard.propose(refund(2500, { evidence: [] }));
    expect(r.outcome).not.toBe("executed");
    expect(calls).toHaveLength(0);
  });

  it("an executor failure is reported, not thrown", async () => {
    const { guard } = setup({ status: "failed", detail: "provider said no" });
    const r = await guard.propose(refund(2500));
    expect(r.outcome).toBe("execution_failed");
  });

  it("an uncertain outcome is parked for reconciliation, never retried", async () => {
    const { guard, calls } = setup({ status: "uncertain" });
    const r = await guard.propose(refund(2500));
    expect(r.outcome).toBe("needs_reconciliation");
    expect(calls).toHaveLength(1);
  });

  it("the same idempotency key never reaches the executor twice", async () => {
    const { guard, calls } = setup();
    const first = await guard.propose(refund(2500, { idempotencyKey: "idem_same" }));
    expect(first.outcome).toBe("executed");
    const second = await guard.propose(refund(2500, { idempotencyKey: "idem_same" }));
    expect(second.outcome === "executed" ? second.replayed : true).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("injection flagged by the pipeline stops auto execution", async () => {
    const calls: unknown[] = [];
    const guard = createAgentGuard({
      executor: {
        async executeAction(_c, p) {
          calls.push(p);
          return { status: "succeeded" };
        },
      },
      policyFor: () => policy,
      now: () => NOW,
      injectionSuspected: () => true,
    });
    const r = await guard.propose(refund(2500));
    expect(r.outcome).not.toBe("executed");
    expect(calls).toHaveLength(0);
  });
});
