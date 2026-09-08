import { describe, expect, it, vi } from "vitest";
import {
  ExecutionStatusError,
  InMemoryExecutionStore,
  NonExecutableActionError,
  ReconcileStatusError,
  executeProposal,
  reconcile,
  type ActionExecutor,
} from "./execution.js";
import type { ActionProposal, ExecutionResult } from "./types.js";
import { makeProposal } from "./fixtures.js";

function approvedProposal(over: Partial<ActionProposal> = {}): ActionProposal {
  return makeProposal({ status: "approved", ...over });
}

function executor(result: ExecutionResult): ActionExecutor & {
  executeAction: ReturnType<typeof vi.fn>;
} {
  return { executeAction: vi.fn(async () => result) };
}

describe("executeProposal — §5", () => {
  it("approved → executed on adapter success, result stored", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "succeeded", externalRef: "ext_1" });
    const out = await executeProposal(approvedProposal(), adapter, store);
    expect(out.proposal.status).toBe("executed");
    expect(out.execution.status).toBe("succeeded");
    expect(out.replayed).toBe(false);
    expect(adapter.executeAction).toHaveBeenCalledTimes(1);
    expect((await store.get("tenant_demo", "idem_1"))?.status).toBe("executed");
  });

  it("approved → failed on adapter failure, result stored", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "failed", detail: "card declined" });
    const out = await executeProposal(approvedProposal(), adapter, store);
    expect(out.proposal.status).toBe("failed");
    expect(out.execution.status).toBe("failed");
    expect((await store.get("tenant_demo", "idem_1"))?.status).toBe("failed");
  });

  it("uncertain → reconciliation_required, never retried, nothing stored", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "uncertain", detail: "timeout" });
    const out = await executeProposal(approvedProposal(), adapter, store);
    expect(out.proposal.status).toBe("reconciliation_required");
    expect(out.execution.status).toBe("uncertain");
    expect(adapter.executeAction).toHaveBeenCalledTimes(1);
    expect(await store.get("tenant_demo", "idem_1")).toBeUndefined();
  });

  it("replay with the same idempotency key returns the stored result without calling the adapter again", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "succeeded", externalRef: "ext_1" });
    const first = await executeProposal(approvedProposal(), adapter, store);
    expect(first.replayed).toBe(false);

    // Replay with a fresh proposal object carrying the same key.
    const replay = await executeProposal(approvedProposal(), adapter, store);
    expect(replay.replayed).toBe(true);
    expect(replay.execution).toEqual(first.execution);
    expect(adapter.executeAction).toHaveBeenCalledTimes(1);
  });

  it("keys executions by (tenantId, idempotencyKey)", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "succeeded" });
    await executeProposal(approvedProposal(), adapter, store);
    const otherTenant = await executeProposal(
      approvedProposal({ tenantId: "tenant_other" }),
      adapter,
      store,
    );
    expect(otherTenant.replayed).toBe(false);
    expect(adapter.executeAction).toHaveBeenCalledTimes(2);
  });

  it("throws ExecutionStatusError when the proposal is not approved", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "succeeded" });
    for (const status of ["proposed", "pending_approval", "executed"] as const) {
      await expect(
        executeProposal(approvedProposal({ status }), adapter, store),
      ).rejects.toBeInstanceOf(ExecutionStatusError);
    }
    expect(adapter.executeAction).not.toHaveBeenCalled();
  });

  it("refuses exchange_request even when approved (never model-executed)", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "succeeded" });
    const proposal = approvedProposal({
      actionType: "exchange_request",
      reasonCode: "wrong_item",
      params: { orderId: "ord_small", originalLineId: "line_1", replacementSku: "sku_mug_v2" },
    });
    await expect(executeProposal(proposal, adapter, store)).rejects.toBeInstanceOf(
      NonExecutableActionError,
    );
    await expect(executeProposal(proposal, adapter, store)).rejects.toMatchObject({
      code: "ACTION_NOT_EXECUTABLE",
    });
    // Fail closed: no adapter call, no state transition, nothing stored.
    expect(adapter.executeAction).not.toHaveBeenCalled();
    expect(proposal.status).toBe("approved");
    expect(await store.get("tenant_demo", "idem_1")).toBeUndefined();
  });

  it("refuses exchange_request regardless of proposal status", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "succeeded" });
    for (const status of ["proposed", "pending_approval", "approved"] as const) {
      await expect(
        executeProposal(approvedProposal({ status, actionType: "exchange_request" }), adapter, store),
      ).rejects.toBeInstanceOf(NonExecutableActionError);
    }
    expect(adapter.executeAction).not.toHaveBeenCalled();
  });
});

describe("reconcile — §5", () => {
  it("resolves reconciliation_required → executed on succeeded outcome", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "uncertain" });
    const out = await executeProposal(approvedProposal(), adapter, store);
    const resolved = reconcile(out.proposal, "succeeded");
    expect(resolved.status).toBe("executed");
  });

  it("resolves reconciliation_required → failed on failed outcome", async () => {
    const store = new InMemoryExecutionStore();
    const adapter = executor({ status: "uncertain" });
    const out = await executeProposal(approvedProposal(), adapter, store);
    const resolved = reconcile(out.proposal, "failed");
    expect(resolved.status).toBe("failed");
  });

  it("throws ReconcileStatusError from any other status", () => {
    expect(() => reconcile(approvedProposal(), "succeeded")).toThrow(
      ReconcileStatusError,
    );
    expect(() =>
      reconcile(approvedProposal({ status: "executed" }), "failed"),
    ).toThrow(ReconcileStatusError);
  });
});
