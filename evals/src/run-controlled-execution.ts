import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildControlledExecutionReport } from "./controlled-execution-eval.js";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../report/controlled-execution-latest.json");
const report = buildControlledExecutionReport();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`eval:controlled — ${report.profile}`);
for (const [name, result] of Object.entries(report.checks)) {
  console.log(`  ${result.ok ? "PASS" : "FAIL"} ${name}: ${result.detail}`);
}
console.log(`report written to ${outPath}`);
if (!report.gates.ok) process.exit(1);
