import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAfterSalesDataset } from "./dataset.js";
import {
  buildAfterSalesReport,
  runAfterSalesCase,
  type AfterSalesEvalReport,
} from "./after-sales-harness.js";
import { AFTER_SALES_COVERAGE_STATUSES } from "./types.js";

/**
 * `pnpm eval:after-sales` — offline deterministic evaluation of the
 * after-sales top-10 set. Runs in CI as a gate: any failed gate exits
 * non-zero. The run is fully offline (fixed clock, eval policy, no model
 * calls) and never reports a non-"supported" coverage case as executed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../report/after-sales-latest.json");

async function main(): Promise<number> {
  // Dataset validation is a hard gate: any invalid case aborts the run.
  const dataset = loadAfterSalesDataset();
  const results = [];
  for (const c of dataset.cases) {
    results.push(await runAfterSalesCase(c));
  }
  const report: AfterSalesEvalReport = buildAfterSalesReport(
    results,
    Object.keys(dataset.byScenario),
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`eval:after-sales — ${report.totalCases} cases across ${Object.keys(report.perScenario).length} scenarios`);

  // Console coverage matrix: scenario x coverage status.
  const header = ["scenario".padEnd(24), ...AFTER_SALES_COVERAGE_STATUSES.map((s) => s.padStart(21))].join("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const [scenario, row] of Object.entries(report.perScenario)) {
    const cells = AFTER_SALES_COVERAGE_STATUSES.map((s) =>
      String(row.coverage[s] || "").padStart(21),
    );
    console.log(scenario.padEnd(24) + cells.join(""));
  }
  const totals = AFTER_SALES_COVERAGE_STATUSES.map((s) =>
    String(report.coverageTotals[s] || "").padStart(21),
  );
  console.log("-".repeat(header.length));
  console.log("TOTAL".padEnd(24) + totals.join(""));

  console.log(
    `  schema-valid ${pct(report.metrics.schemaValidRate)} | policy-consistent ${pct(report.metrics.policyConsistency)}`,
  );
  console.log(
    `  overreach ${report.metrics.overreachCount} | duplicate-executions ${report.metrics.duplicateExecutionCount} | security-bypass ${report.metrics.securityBypassCount} | fake-success ${report.metrics.fakeSuccessCount}`,
  );
  for (const r of results) {
    console.log(
      `  ${r.id} ${r.scenario.padEnd(24)} ${r.coverageStatus.padEnd(21)} expected=${r.expectedDecision.padEnd(17)} actual=${r.actualDecision.padEnd(17)} outcome=${r.outcome}`,
    );
  }
  console.log(`report written to ${outPath}`);

  if (!report.gates.ok) {
    console.error("GATES FAILED:");
    for (const [gate, ok] of Object.entries(report.gates)) {
      if (!ok && gate !== "ok") console.error(`  - ${gate}`);
    }
    for (const f of report.failures.slice(0, 20)) console.error(`  * ${f.id}: ${f.detail}`);
    return 1;
  }
  console.log("all gates passed");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
