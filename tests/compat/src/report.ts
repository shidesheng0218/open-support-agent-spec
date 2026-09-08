import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ReportCase {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ReportSuite {
  name: string;
  passed: number;
  failed: number;
  cases: ReportCase[];
}

export interface CompatReport {
  specVersion: "0.2";
  runAt: string;
  generator: "@osas/compat-suite@0.2.0";
  ok: boolean;
  totals: { passed: number; failed: number };
  suites: ReportSuite[];
}

export class ReportCollector {
  private suites = new Map<string, ReportCase[]>();

  addCase(suite: string, c: ReportCase): void {
    const list = this.suites.get(suite) ?? [];
    list.push(c);
    this.suites.set(suite, list);
  }

  build(): CompatReport {
    const suites: ReportSuite[] = [...this.suites.entries()].map(([name, cases]) => ({
      name,
      passed: cases.filter((c) => c.ok).length,
      failed: cases.filter((c) => !c.ok).length,
      cases,
    }));
    const passed = suites.reduce((n, s) => n + s.passed, 0);
    const failed = suites.reduce((n, s) => n + s.failed, 0);
    return {
      specVersion: "0.2",
      runAt: new Date().toISOString(),
      generator: "@osas/compat-suite@0.2.0",
      ok: failed === 0,
      totals: { passed, failed },
      suites,
    };
  }
}

export function writeReport(report: CompatReport, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}

/** Run one named check: record the outcome, rethrow on failure so vitest fails too. */
export async function runCase(
  collector: ReportCollector,
  suite: string,
  name: string,
  fn: () => unknown | Promise<unknown>,
  okDetail?: string,
): Promise<void> {
  try {
    await fn();
    collector.addCase(suite, { name, ok: true, ...(okDetail ? { detail: okDetail } : {}) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    collector.addCase(suite, { name, ok: false, detail });
    throw err;
  }
}
