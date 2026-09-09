import { describe, expect, it } from "vitest";
import { buildControlledExecutionReport } from "./controlled-execution-eval.js";

describe("controlled execution offline evaluation", () => {
  it("passes the v0.3 Draft safety gates", () => {
    const report = buildControlledExecutionReport();
    expect(report.specVersion).toBe("0.3");
    expect(report.profile).toBe("ecommerce-controlled-execution");
    expect(report.gates).toMatchObject({
      afterSalesCasesAtLeast100: true,
      everyScenarioAtLeast10: true,
      executionSchemasValid: true,
      uncertainNeverAutoRetried: true,
      providerEventsDeduplicated: true,
      exchangeHumanOnly: true,
      ok: true,
    });
  });
});
