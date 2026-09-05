import { afterAll } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportCollector, writeReport } from "./report.js";
import { registerSchemaCore } from "./schema-core.js";
import { registerSchemaProfiles } from "./schema-profiles.js";
import { registerToolsMapping } from "./tools-mapping.js";
import { registerStateMachines } from "./state-machines.js";
import { registerPolicyMatrix } from "./policy-matrix.js";
import { registerIdempotencyReconciliation } from "./idempotency-reconciliation.js";

// Single-entry test file: vitest runs files in isolated workers, so all suites
// register through one shared collector here to guarantee a complete report.
const collector = new ReportCollector();

registerSchemaCore(collector);
registerSchemaProfiles(collector);
registerToolsMapping(collector);
registerStateMachines(collector);
registerPolicyMatrix(collector);
registerIdempotencyReconciliation(collector);

afterAll(() => {
  const report = collector.build();
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "../report/latest.json");
  writeReport(report, out);
  console.log(
    `[compat] report written to ${out} — ${report.totals.passed} passed, ${report.totals.failed} failed`,
  );
});
