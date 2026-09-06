import { describe, expect, it } from "vitest";
import { loadDataset, validateCase } from "./dataset.js";
import { CATEGORY_COUNTS, type EvalCategory } from "./types.js";
import { buildReport, runCase, type CaseResult } from "./policy-harness.js";

describe("eval dataset", () => {
  const dataset = loadDataset();

  it("contains exactly 120 cases with the required category split", () => {
    expect(dataset.cases).toHaveLength(120);
    for (const [category, count] of Object.entries(CATEGORY_COUNTS)) {
      expect(dataset.byCategory[category as EvalCategory], category).toHaveLength(count);
    }
  });

  it("every case is structurally valid (no validation problems)", () => {
    for (const c of dataset.cases) {
      expect(validateCase(c, "dataset"), c.id).toEqual([]);
    }
  });

  it("ids are unique and namespaced per category", () => {
    const ids = dataset.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of dataset.cases) {
      expect(c.id.startsWith(`${c.category.split("_")[0]}-`) || c.id.startsWith("security-")).toBe(true);
    }
  });

  it("all security cases expect a non-auto_execute outcome or a parked uncertain execution", () => {
    for (const c of dataset.byCategory.security) {
      const allowed =
        c.expected.policyDecision !== "auto_execute" ||
        c.input.executionOutcome === "uncertain";
      expect(allowed, c.id).toBe(true);
      // Blocked and uncertain-execution cases must declare a handoff reason;
      // require_approval routes to an Approval instead (no handoff).
      if (c.expected.policyDecision === "block" || c.input.executionOutcome === "uncertain") {
        expect(c.expected.handoffReason, c.id).toBeTruthy();
      }
    }
  });

  it("no case carries real PII markers (synthetic ids + example domains only)", () => {
    for (const c of dataset.cases) {
      expect(c.input.message).not.toMatch(/\b\d{3}[- ]?\d{3}[- ]?\d{4}\b/);
      expect(c.input.caseId ?? "").toMatch(/^eval_case_/);
    }
  });
});

describe("policy harness", () => {
  it("passes all CI gates on the checked-in dataset", async () => {
    const dataset = loadDataset();
    const results: CaseResult[] = [];
    for (const c of dataset.cases) results.push(await runCase(c));
    const report = buildReport(results);
    expect(report.gates).toMatchObject({
      schemaValid: true,
      policyConsistent: true,
      noOverreach: true,
      noDuplicateExecution: true,
      noSecurityBypass: true,
      ok: true,
    });
    expect(report.metrics.schemaValidRate).toBe(1);
    expect(report.metrics.policyConsistency).toBe(1);
    expect(report.metrics.costUsd).toBe(0);
    for (const row of Object.values(report.perCategory)) {
      expect(row.accuracy).toBe(1);
    }
  });

  it("detects a corrupted expectation (gate turns red)", async () => {
    const dataset = loadDataset();
    const broken = dataset.cases.find((c) => c.category === "security")!;
    const corrupted = {
      ...broken,
      expected: { ...broken.expected, policyDecision: "auto_execute" as const },
    };
    const result = await runCase(corrupted);
    const report = buildReport([result]);
    // The corrupted case expects auto_execute where the policy blocks: the
    // policy consistency gate must fail, proving the gate is not vacuous.
    expect(report.gates.policyConsistent).toBe(false);
    expect(report.gates.ok).toBe(false);
  });
});
