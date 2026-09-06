import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDataset } from "./dataset.js";
import { buildReport, runCase, type PolicyEvalReport } from "./policy-harness.js";

/**
 * `pnpm eval:policy` — fully offline deterministic policy evaluation over the
 * synthetic dataset. Runs in CI as a gate: any failed gate exits non-zero.
 */

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../report/policy-latest.json");

async function main(): Promise<number> {
  const dataset = loadDataset();
  const results = [];
  for (const c of dataset.cases) {
    results.push(await runCase(c));
  }
  const report: PolicyEvalReport = buildReport(results);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`eval:policy — ${report.totalCases} cases`);
  for (const [cat, row] of Object.entries(report.perCategory)) {
    console.log(`  ${cat.padEnd(12)} ${row.accurate}/${row.total} (${pct(row.accuracy)})`);
  }
  console.log(
    `  schema-valid ${pct(report.metrics.schemaValidRate)} | policy-consistent ${pct(report.metrics.policyConsistency)}`,
  );
  console.log(
    `  overreach ${report.metrics.overreachCount} | duplicate-executions ${report.metrics.duplicateExecutionCount} | security-bypass ${report.metrics.securityBypassCount}`,
  );
  console.log(
    `  cost $${report.metrics.costUsd.toFixed(4)} | avg latency ${report.metrics.avgLatencyMs.toFixed(2)}ms | p95 ${report.metrics.p95LatencyMs.toFixed(2)}ms`,
  );
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
