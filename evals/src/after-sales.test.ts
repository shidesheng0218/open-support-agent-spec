import { describe, expect, it } from "vitest";
import { loadAfterSalesDataset, validateAfterSalesCase } from "./dataset.js";
import {
  buildAfterSalesReport,
  runAfterSalesCase,
  type AfterSalesCaseResult,
} from "./after-sales-harness.js";
import {
  AFTER_SALES_CASE_COUNT,
  AFTER_SALES_SCENARIOS,
  type AfterSalesCase,
} from "./types.js";

describe("after-sales top-10 dataset", () => {
  const dataset = loadAfterSalesDataset();

  it(`contains exactly ${AFTER_SALES_CASE_COUNT} valid cases covering all 10 scenarios`, () => {
    expect(dataset.cases).toHaveLength(AFTER_SALES_CASE_COUNT);
    for (const scenario of AFTER_SALES_SCENARIOS) {
      expect(dataset.byScenario[scenario]?.length ?? 0, scenario).toBeGreaterThanOrEqual(10);
    }
  });

  it("every case is structurally valid (no validation problems)", () => {
    for (const c of dataset.cases) {
      expect(validateAfterSalesCase(c, "dataset"), c.id).toEqual([]);
    }
  });

  it("every non-supported case carries a concrete gap note", () => {
    for (const c of dataset.cases) {
      if (c.coverageStatus === "supported") {
        expect(["", "none"], c.id).toContain(c.missingCapability.trim());
      } else {
        expect(c.missingCapability.trim().length, c.id).toBeGreaterThan(0);
        expect(c.missingCapability.trim(), c.id).not.toBe("none");
      }
    }
  });

  it("no case carries real PII markers", () => {
    for (const c of dataset.cases) {
      expect(c.customerMessage).not.toMatch(/\b\d{3}[- ]?\d{3}[- ]?\d{4}\b/);
    }
  });

  it("the validator rejects a case with an invalid coverageStatus", () => {
    const broken = { ...dataset.cases[0], coverageStatus: "fully_live" };
    expect(validateAfterSalesCase(broken, "test").length).toBeGreaterThan(0);
  });

  it("the validator rejects an unsupported-coverage case expecting auto_execute", () => {
    const base = dataset.cases.find((c) => c.coverageStatus === "unsupported")!;
    const broken: AfterSalesCase = {
      ...base,
      expectedAction: "refund",
      expectedPolicyDecision: "auto_execute",
    };
    const problems = validateAfterSalesCase(broken, "test");
    expect(problems.some((p) => p.includes("auto_execute"))).toBe(true);
  });
});

describe("after-sales harness", () => {
  it("passes all CI gates on the checked-in dataset", async () => {
    const dataset = loadAfterSalesDataset();
    const results: AfterSalesCaseResult[] = [];
    for (const c of dataset.cases) results.push(await runAfterSalesCase(c));
    const report = buildAfterSalesReport(results, Object.keys(dataset.byScenario));
    expect(report.gates).toMatchObject({
      allScenariosCovered: true,
      policyConsistent: true,
      noOverreach: true,
      noDuplicateExecution: true,
      noSecurityBypass: true,
      noFakeSuccess: true,
      gapsExplained: true,
      ok: true,
    });
    expect(report.metrics.policyConsistency).toBe(1);
    expect(report.metrics.costUsd).toBe(0);
  });

  it("never reports a non-supported coverage case as executed", async () => {
    const dataset = loadAfterSalesDataset();
    for (const c of dataset.cases) {
      const r = await runAfterSalesCase(c);
      if (c.coverageStatus !== "supported") {
        expect(r.outcome, c.id).not.toBe("executed");
        expect(r.fakeSuccess, c.id).toBe(false);
      }
    }
  });

  it("detects a corrupted expectation (gate turns red)", async () => {
    const dataset = loadAfterSalesDataset();
    const blocked = dataset.cases.find((c) => c.expectedPolicyDecision === "block")!;
    const corrupted: AfterSalesCase = { ...blocked, expectedPolicyDecision: "auto_execute" };
    const result = await runAfterSalesCase(corrupted);
    const report = buildAfterSalesReport([result], [corrupted.scenario]);
    // The corrupted case expects auto_execute where the policy blocks: the
    // policy consistency gate must fail, proving the gate is not vacuous.
    expect(result.decisionMatch).toBe(false);
    expect(report.gates.policyConsistent).toBe(false);
    expect(report.gates.ok).toBe(false);
  });
});
