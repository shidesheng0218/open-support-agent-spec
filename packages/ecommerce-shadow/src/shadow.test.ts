import { describe, expect, it } from "vitest";
import type { ActionProposal, PolicyDecision, ShadowRun } from "@osas/core";
import {
  ExecutionModeConfigError,
  InMemoryShadowRunStore,
  LiveExecutionNotAvailableError,
  ShadowRunAlreadyReviewedError,
  loadExecutionMode,
  planShadowRun,
  reviewShadowRun,
} from "./index.js";

const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
  id: "prop_1",
  specVersion: "0.2",
  tenantId: "tenant_demo",
  caseId: "case_1",
  profile: "ecommerce",
  actionType: "refund",
  reasonCode: "damaged_item",
  params: { orderId: "order_1" },
  requestedPermission: "request-approval",
  requestedBy: { actorType: "model", actorId: "agent-1" },
  amount: { currency: "USD", minorUnits: 5000 },
  evidenceIds: ["ev_1"],
  idempotencyKey: "idem-1",
  status: "proposed",
  createdAt: "2026-01-15T10:00:00Z",
  updatedAt: "2026-01-15T10:00:00Z",
  ...over,
});

const decision = (d: PolicyDecision["decision"]): PolicyDecision => ({
  decision: d,
  reasons: [],
  policyVersion: "1.0.0",
  evaluatedAt: "2026-01-15T10:01:00Z",
});

describe("loadExecutionMode", () => {
  it("defaults to shadow when unset or empty", () => {
    expect(loadExecutionMode({}).mode).toBe("shadow");
    expect(loadExecutionMode({ OSAS_EXECUTION_MODE: "" }).mode).toBe("shadow");
    expect(loadExecutionMode({ OSAS_EXECUTION_MODE: " shadow " }).mode).toBe("shadow");
  });

  it("refuses live with LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1", () => {
    try {
      loadExecutionMode({ OSAS_EXECUTION_MODE: "live" });
      expect.unreachable("live must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LiveExecutionNotAvailableError);
      expect((err as LiveExecutionNotAvailableError).code).toBe(
        "LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1",
      );
    }
  });

  it("rejects unknown values", () => {
    expect(() => loadExecutionMode({ OSAS_EXECUTION_MODE: "yolo" })).toThrow(
      ExecutionModeConfigError,
    );
  });
});

describe("planShadowRun", () => {
  it("sets wouldAutoExecute only for an auto_execute decision", () => {
    const run = planShadowRun(proposal(), decision("auto_execute"), {
      id: "shadow_1",
      now: new Date("2026-01-15T10:02:00Z"),
    });
    expect(run.wouldAutoExecute).toBe(true);
    expect(run.humanOutcome).toBe("pending");
    expect(run.specVersion).toBe("0.2");
    expect(run.suggestedAction).toEqual({
      actionType: "refund",
      reasonCode: "damaged_item",
      params: { orderId: "order_1" },
      amount: { currency: "USD", minorUnits: 5000 },
    });
  });

  it.each(["require_approval", "block"] as const)(
    "never sets wouldAutoExecute for %s",
    (d) => {
      const run = planShadowRun(proposal(), decision(d), { id: "shadow_x" });
      expect(run.wouldAutoExecute).toBe(false);
    },
  );

  it("never touches the proposal status (record-only)", () => {
    const p = proposal();
    planShadowRun(p, decision("auto_execute"), { id: "shadow_1" });
    expect(p.status).toBe("proposed");
  });

  it("omits amount when the proposal has none", () => {
    const run = planShadowRun(proposal({ amount: undefined }), decision("block"), {
      id: "shadow_2",
    });
    expect(run.suggestedAction.amount).toBeUndefined();
  });
});

describe("reviewShadowRun", () => {
  const pending = (): ShadowRun =>
    planShadowRun(proposal(), decision("require_approval"), {
      id: "shadow_1",
      now: new Date("2026-01-15T10:02:00Z"),
    });

  it.each(["accepted", "rejected", "modified"] as const)(
    "records human outcome %s with comment, reference and reviewedAt",
    (outcome) => {
      const reviewed = reviewShadowRun(pending(), {
        outcome,
        humanComment: "checked the warehouse photos",
        externalReference: "zd-ticket-42",
        now: new Date("2026-01-15T11:00:00Z"),
      });
      expect(reviewed.humanOutcome).toBe(outcome);
      expect(reviewed.humanComment).toBe("checked the warehouse photos");
      expect(reviewed.externalReference).toBe("zd-ticket-42");
      expect(reviewed.reviewedAt).toBe("2026-01-15T11:00:00.000Z");
    },
  );

  it("is final: re-reviewing a reviewed run is a conflict", () => {
    const reviewed = reviewShadowRun(pending(), { outcome: "accepted" });
    expect(() => reviewShadowRun(reviewed, { outcome: "rejected" })).toThrow(
      ShadowRunAlreadyReviewedError,
    );
  });
});

describe("InMemoryShadowRunStore", () => {
  it("creates, gets, saves and lists per tenant with filters", async () => {
    const store = new InMemoryShadowRunStore();
    const run = planShadowRun(proposal(), decision("block"), {
      id: "shadow_1",
      now: new Date("2026-01-15T10:02:00Z"),
    });
    await store.create(run);

    expect(await store.get("tenant_demo", "shadow_1")).toMatchObject({ id: "shadow_1" });
    expect(await store.get("other_tenant", "shadow_1")).toBeUndefined();

    expect(await store.list("tenant_demo")).toHaveLength(1);
    expect(await store.list("tenant_demo", { proposalId: "prop_1" })).toHaveLength(1);
    expect(await store.list("tenant_demo", { proposalId: "prop_zzz" })).toHaveLength(0);
    expect(await store.list("tenant_demo", { humanOutcome: "pending" })).toHaveLength(1);
    expect(await store.list("tenant_demo", { humanOutcome: "accepted" })).toHaveLength(0);

    const reviewed = reviewShadowRun(run, { outcome: "modified", humanComment: "partial refund" });
    await store.save(reviewed);
    expect((await store.get("tenant_demo", "shadow_1"))?.humanOutcome).toBe("modified");
    expect(await store.list("tenant_demo", { humanOutcome: "pending" })).toHaveLength(0);
  });

  it("never aliases stored state", async () => {
    const store = new InMemoryShadowRunStore();
    const run = planShadowRun(proposal(), decision("block"), { id: "shadow_1" });
    await store.create(run);
    run.humanOutcome = "accepted";
    expect((await store.get("tenant_demo", "shadow_1"))?.humanOutcome).toBe("pending");
  });
});
