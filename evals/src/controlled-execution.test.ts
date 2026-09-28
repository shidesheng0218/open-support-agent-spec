import { describe, expect, it } from "vitest";
import { buildControlledExecutionReport } from "./controlled-execution-eval.js";

describe("controlled execution offline evaluation", () => {
  it("passes the v0.3 Draft safety gates", async () => {
    const report = await buildControlledExecutionReport();
    expect(report.specVersion).toBe("0.3");
    expect(report.profile).toBe("ecommerce-controlled-execution");
    expect(report.gates).toMatchObject({
      afterSalesCasesAtLeast100: true,
      everyScenarioAtLeast10: true,
      executionSchemasValid: true,
      uncertainNeverAutoRetried: true,
      idempotentReplayNoSecondCall: true,
      providerEventsDeduplicated: true,
      exchangeHumanOnly: true,
      ok: true,
    });
  });

  it("the behavioral gates fail if the engine regresses", async () => {
    // Sanity: the gate details carry real observations, not hardcoded passes.
    const report = await buildControlledExecutionReport();
    expect(report.checks.uncertainNeverAutoRetried?.detail).toContain("blind retry blocked=true");
    expect(report.checks.idempotentReplayNoSecondCall?.detail).toContain("adapterCalls=1");
    expect(report.checks.exchangeHumanOnly?.detail).toContain("adapterCalls=0");
  });
});
