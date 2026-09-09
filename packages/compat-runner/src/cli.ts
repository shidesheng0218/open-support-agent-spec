#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { runCompat } from "./runner.js";
import type { RunnerOptions } from "./types.js";

const USAGE = `Usage: osas-compat --target <baseUrl> [options]

Black-box OSAS compatibility runner (Milestone 4).

Options:
  --target <url>           Base URL of the target implementation (required)
  --token <token>          Bearer token for jwt-mode targets
  --tenant <id>            Tenant id (default: tenant_demo)
  --role <role>            Demo-auth role for privileged checks (default: policy_admin)
  --profile <name>         v0.2 (default) or controlled-execution
  --provider-event-key <key> Provider Event key for controlled-execution checks
  --conformance-key <key>  Enable stateful checks (target must run with
                           OSAS_CONFORMANCE_MODE=true). Alternatively set env
                           OSAS_CONFORMANCE_MODE=true + OSAS_CONFORMANCE_KEY.
  --timeout <ms>           Per-request timeout (default: 10000)
  --out <file>             Also write the JSON report to a file
  -h, --help               Show this help

Exit codes: 0 = all checks passed, 1 = one or more checks failed, 2 = usage error.
`;

function parseArgs(argv: string[]): RunnerOptions & { out?: string } {
  const opts: RunnerOptions & { out?: string } = { target: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--target": opts.target = next(); break;
      case "--token": opts.token = next(); break;
      case "--tenant": opts.tenant = next(); break;
      case "--role": opts.role = next(); break;
      case "--profile": {
        const profile = next();
        if (profile !== "v0.2" && profile !== "controlled-execution") {
          throw new Error(`--profile must be v0.2 or controlled-execution; got ${profile}`);
        }
        opts.profile = profile;
        break;
      }
      case "--provider-event-key": opts.providerEventKey = next(); break;
      case "--conformance-key": opts.conformanceKey = next(); break;
      case "--timeout": opts.timeoutMs = Number(next()); break;
      case "--out": opts.out = next(); break;
      case "--": break; // pnpm argument-forwarding separator
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main(): Promise<number> {
  let opts: RunnerOptions & { out?: string };
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return 2;
  }
  if (!opts.target) {
    console.error("--target is required");
    console.error(USAGE);
    return 2;
  }
  // Stateful suite enablement (env): OSAS_CONFORMANCE_MODE=true + key.
  if (!opts.conformanceKey && (process.env.OSAS_CONFORMANCE_MODE ?? "").trim() === "true") {
    const key = process.env.OSAS_CONFORMANCE_KEY?.trim();
    if (key) opts.conformanceKey = key;
  }
  if (!opts.providerEventKey) {
    const key = process.env.OSAS_PROVIDER_EVENT_KEY?.trim();
    if (key) opts.providerEventKey = key;
  }
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    console.error("--timeout must be a positive number");
    return 2;
  }

  const report = await runCompat(opts);
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (opts.out) writeFileSync(opts.out, json + "\n", "utf8");
  return report.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
