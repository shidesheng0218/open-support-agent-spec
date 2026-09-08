/** Machine-readable black-box compatibility report (Milestone 4). */

export type CheckStatus = "pass" | "fail" | "skip";

export interface RunnerCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
}

export interface RunnerSuite {
  name: string;
  passed: number;
  failed: number;
  skipped: number;
  checks: RunnerCheck[];
}

export interface CompatRunReport {
  specVersion: "0.2";
  generator: "@osas/compat-runner@0.2.0";
  target: string;
  runAt: string;
  mode: {
    /** True when stateful (write) checks ran — requires conformance mode. */
    stateful: boolean;
  };
  ok: boolean;
  totals: { passed: number; failed: number; skipped: number };
  suites: RunnerSuite[];
}

export interface RunnerOptions {
  /** Base URL of the target implementation, e.g. http://localhost:3001 */
  target: string;
  /** Bearer token for jwt-mode targets (sent as Authorization: Bearer). */
  token?: string;
  /** Tenant id (path params + x-tenant-id demo header). Default tenant_demo. */
  tenant?: string;
  /** Demo-auth role used for privileged checks. Default policy_admin. */
  role?: string;
  /**
   * Enables the stateful suite. The target must run with
   * OSAS_CONFORMANCE_MODE=true and present this key. Never use against a
   * production deployment.
   */
  conformanceKey?: string;
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}
