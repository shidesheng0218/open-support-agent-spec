import { describe, expect, test, vi } from "vitest";
import {
  InMemoryExecutionStore,
  executeProposal,
  reconcile,
  type ExecuteOutcome,
} from "@osas/policy-engine";
import { MockSupportAdapter, createDemoFixtures } from "@osas/mock-backend";
import { ReportCollector, runCase } from "./report.js";
import { makeProposal } from "./demo.js";

const SUITE = "idempotency-reconciliation";

type Any = Record<string, unknown>;

/**
 * executeProposal (policy-engine) calls adapter.executeAction({ tenantId }, p)
 * without a principal; MockSupportAdapter enforces execute-permission. Wrap the
 * mock so the executor presented to the engine is a spec-compliant
 * execute-permission principal. The spy sits on this wrapper.
 */
function makeExecutor() {
  const adapter = new MockSupportAdapter(createDemoFixtures());
  const executor = {
    executeAction: (ctx: { tenantId: string }, proposal: Any) =>
      adapter.executeAction(
        {
          tenantId: ctx.tenantId,
          principal: { actorType: "system", actorId: "policy-engine", permission: "execute" },
        } as never,
        proposal as never,
      ),
  };
  const spy = vi.spyOn(executor, "executeAction");
  return { adapter, executor, spy };
}

async function exec(
  proposal: Any,
  executor: ReturnType<typeof makeExecutor>["executor"],
  store: InMemoryExecutionStore,
): Promise<ExecuteOutcome> {
  return (await (executeProposal as unknown as (...a: unknown[]) => Promise<ExecuteOutcome>)(
    proposal,
    executor,
    store,
  )) as ExecuteOutcome;
}

export function registerIdempotencyReconciliation(collector: ReportCollector): void {
  describe(SUITE, () => {
    test("same idempotencyKey executes once; replay returns stored result", () =>
      runCase(collector, SUITE, "idempotency: same key executes once, replay served", async () => {
        const { executor, spy } = makeExecutor();
        const store = new InMemoryExecutionStore();
        const proposal = makeProposal({ status: "approved" });

        const first = await exec(proposal, executor, store);
        expect(first.proposal.status).toBe("executed");
        expect(first.replayed).toBe(false);

        const second = await exec(proposal, executor, store);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(second.replayed).toBe(true);
        expect(second.execution).toEqual(first.execution);
      }));

    test("replay has no side effects (no double refund)", () =>
      runCase(collector, SUITE, "idempotency: replay has no adapter side effects", async () => {
        const { executor, spy } = makeExecutor();
        const store = new InMemoryExecutionStore();
        const proposal = makeProposal({ status: "approved" });

        await exec(proposal, executor, store);
        await exec(proposal, executor, store);
        await exec(proposal, executor, store);
        expect(spy).toHaveBeenCalledTimes(1);
      }));

    test("uncertain outcome -> reconciliation_required, never auto-retried", () =>
      runCase(
        collector,
        SUITE,
        "uncertain -> reconciliation_required + no auto-retry",
        async () => {
          const { executor, spy } = makeExecutor();
          const store = new InMemoryExecutionStore();
          const proposal = makeProposal({
            status: "approved",
            params: { orderId: "ord_small", simulate: "timeout" },
          });

          const first = await exec(proposal, executor, store);
          expect(first.proposal.status).toBe("reconciliation_required");
          expect(first.execution.status).toBe("uncertain");
          expect(spy).toHaveBeenCalledTimes(1);

          // Re-attempting with the parked proposal must not reach the adapter
          // (status guard: only `approved` may execute — no blind retry, §2/§5).
          await exec(first.proposal as unknown as Any, executor, store).catch(() => undefined);
          expect(spy).toHaveBeenCalledTimes(1);
        },
      ));

    test("reconcile(succeeded) moves proposal to executed", () =>
      runCase(collector, SUITE, "reconcile: reconciliation_required -> executed", async () => {
        const { executor } = makeExecutor();
        const store = new InMemoryExecutionStore();
        const proposal = makeProposal({
          status: "approved",
          params: { orderId: "ord_small", simulate: "timeout" },
        });

        const first = await exec(proposal, executor, store);
        expect(first.proposal.status).toBe("reconciliation_required");

        const reconciled = reconcile(first.proposal, "succeeded") as unknown as Any;
        expect(reconciled.status).toBe("executed");

        // reconcile only from reconciliation_required: re-resolve must throw
        expect(() => reconcile(reconciled as never, "succeeded")).toThrow();
      }));
  });
}
