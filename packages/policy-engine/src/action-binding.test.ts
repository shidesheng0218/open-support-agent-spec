import { describe, expect, it, vi } from "vitest";
import {
  ACTION_BINDING_MISMATCH,
  ActionBindingMismatchError,
  assertActionBinding,
  computeActionDigest,
} from "./action-binding.js";
import { executeProposal, InMemoryExecutionStore } from "./execution.js";
import { makeProposal } from "./fixtures.js";

describe("action binding (RFC 0008)", () => {
  it("computes a deterministic, key-order-independent digest", () => {
    const a = computeActionDigest({ actionType: "refund", params: { orderId: "ord_1", reason: "damaged" } });
    const b = computeActionDigest({ actionType: "refund", params: { reason: "damaged", orderId: "ord_1" } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the action changes", () => {
    const base = computeActionDigest({ actionType: "refund", params: { orderId: "ord_1" } });
    expect(computeActionDigest({ actionType: "refund", params: { orderId: "ord_2" } })).not.toBe(base);
    expect(computeActionDigest({ actionType: "reshipment", params: { orderId: "ord_1" } })).not.toBe(base);
  });

  it("passes when the supplied digest matches the proposal", () => {
    const proposal = makeProposal({ status: "approved" });
    expect(() =>
      assertActionBinding(proposal, { actionDigest: computeActionDigest(proposal) }),
    ).not.toThrow();
  });

  it("throws ActionBindingMismatchError on tampered params", () => {
    const approved = makeProposal({ status: "approved" });
    const digest = computeActionDigest(approved);
    const tampered = { ...approved, params: { ...approved.params, amount_override: 99900 } };
    let caught: unknown;
    try {
      assertActionBinding(tampered, { actionDigest: digest });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActionBindingMismatchError);
    expect((caught as ActionBindingMismatchError).code).toBe(ACTION_BINDING_MISMATCH);
  });

  it("is a no-op when no digest is supplied (legacy approvals)", () => {
    const proposal = makeProposal({ status: "approved" });
    expect(() => assertActionBinding(proposal, {})).not.toThrow();
    expect(() => assertActionBinding(proposal, undefined)).not.toThrow();
  });

  it("executeProposal refuses a mismatched binding before any adapter call or state transition", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = { executeAction: vi.fn(async () => ({ status: "succeeded" as const })) };
    const proposal = makeProposal({ status: "approved" });
    const wrongDigest = computeActionDigest({ actionType: "refund", params: { orderId: "ord_other" } });
    await expect(
      executeProposal(proposal, adapter, store, new Date(), { actionDigest: wrongDigest }),
    ).rejects.toBeInstanceOf(ActionBindingMismatchError);
    expect(adapter.executeAction).not.toHaveBeenCalled();
    expect(proposal.status).toBe("approved"); // untouched
    expect(await store.get(proposal.tenantId, proposal.idempotencyKey)).toBeUndefined();
  });

  it("executeProposal executes normally with a matching binding", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = { executeAction: vi.fn(async () => ({ status: "succeeded" as const, externalRef: "ext_9" })) };
    const proposal = makeProposal({ status: "approved" });
    const out = await executeProposal(
      proposal,
      adapter,
      store,
      new Date(),
      { actionDigest: computeActionDigest(proposal) },
    );
    expect(out.proposal.status).toBe("executed");
    expect(adapter.executeAction).toHaveBeenCalledTimes(1);
  });

  it("replay short-circuits before the binding check (stored outcome wins)", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = { executeAction: vi.fn(async () => ({ status: "succeeded" as const })) };
    const proposal = makeProposal({ status: "approved" });
    const digest = computeActionDigest(proposal);
    await executeProposal(proposal, adapter, store, new Date(), { actionDigest: digest });
    // A replay with a WRONG digest still returns the stored result — no new
    // execution is being authorized, so the binding check does not apply.
    const replay = await executeProposal(proposal, adapter, store, new Date(), {
      actionDigest: computeActionDigest({ actionType: "refund", params: { orderId: "ord_other" } }),
    });
    expect(replay.replayed).toBe(true);
    expect(adapter.executeAction).toHaveBeenCalledTimes(1);
  });
});
