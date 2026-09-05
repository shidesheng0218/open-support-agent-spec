# @osas/compat-suite — OSAS v0.1 compatibility test suite

This package is the **profile-compatibility gate** for the Open Support Agent Spec (OSAS) v0.1.
Per GOVERNANCE.md, an implementation may only declare itself *"OSAS v0.1 profile-compatible"*
(core / ecommerce / saas) when this suite passes against its schemas, state machines, policy
engine, adapter surface, and MCP tool mapping.

## What the suite checks

| Suite | What it proves |
|---|---|
| `schema-core` | Every schema in `schemas/manifest.json` accepts the valid fixture and rejects: unknown additional properties, missing required fields, `specVersion: "0.2"`, enum violations, and float `minorUnits` in Money. |
| `schema-profiles` | Profile extension objects (order, shipment, subscription, invoice, credit-balance) valid/invalid cases, and the cross-profile rule (an `ecommerce` proposal with a `saas` actionType is rejected — by schema or by `PROFILE_MISMATCH`). |
| `tools-mapping` | `TOOL_DEFINITIONS` is exactly the 16 contract tools; each maps 1:1 to `schemas/tools/<name>.json` (required/properties consistent with `inputSchema`) and to a real method on `SupportAdapter`; `executeAction` is never a tool; proposal-creating tools require at most `request-approval`. |
| `state-machines` | Full legality tables for Case and ActionProposal transitions (every legal edge passes, illegal edges throw). |
| `policy-matrix` | The full §4 policy matrix on the demo fixtures: auto small refund, over-threshold→approval, unverified/expired identity→block, stale evidence→approval, blocked region (IR)→block, model execute-overreach→block, injection→block, duplicate→block, reason-code-not-allowed→block, currency mismatch→approval. |
| `idempotency-reconciliation` | Same `idempotencyKey` executes exactly once (replay returns the stored result, no side effects); `uncertain` → `reconciliation_required` with **no auto-retry**; `reconcile` resolves to `executed`. |

## Running the suite

From the repo root (reference implementation):

```bash
pnpm install
pnpm build
pnpm test:compat          # = pnpm --filter @osas/compat-suite test
```

For an **independent implementation**: keep the authoritative `schemas/` directory and this
`tests/compat/` package, point the workspace dependencies (`@osas/core`, `@osas/schema-validator`,
`@osas/policy-engine`, `@osas/adapter`, `@osas/mock-backend`, `@osas/mcp-server`) at your own
packages implementing the same exported surface (per CONTRACTS.md), then run:

```bash
git clone <your-repo> && cd <your-repo>
pnpm install && pnpm build
pnpm --filter @osas/compat-suite test
```

The suite is a plain pnpm workspace package, so `pnpm dlx` is not needed: any repo that vendors
`schemas/` + `tests/compat/` and satisfies the workspace deps can run it with the two commands
above. A failing case fails the vitest run (CI-red) *and* is recorded in the JSON report.

## Reading the report

Each run writes `tests/compat/report/latest.json`:

```json
{
  "specVersion": "0.1",
  "runAt": "2026-01-15T10:00:00.000Z",
  "generator": "@osas/compat-suite@0.1.0",
  "ok": true,
  "totals": { "passed": 120, "failed": 0 },
  "suites": [
    { "name": "schema-core", "passed": 40, "failed": 0,
      "cases": [{ "name": "case: valid fixture passes", "ok": true }] }
  ]
}
```

- `ok: true` ⇔ zero failed cases across all suites.
- Every case has `name`, `ok`, and (on failure) `detail` with the assertion message.
- The API serves this file at `GET /v1/compat/report`; the web console renders it under `/platform`.
- The file is a **generated artifact** (it carries a `runAt` timestamp): it is gitignored and NOT
  tracked in git, so a run does not dirty the working tree. It is produced locally by
  `pnpm --filter @osas/compat-suite test` and in CI on every run (`.github/workflows/ci.yml`,
  `compat` job), where it is also uploaded as a workflow artifact. A fresh clone returns 404
  from `/v1/compat/report` until the suite has been run once.

## Layout

```
src/
  index.test.ts                    single-entry vitest file (imports all suites, writes the report)
  report.ts                        report collector + JSON writer
  helpers.ts                       schema/fixture loading + schema-walking utilities
  demo.ts                          demo-fixture access + proposal builders
  schema-core.ts                   suite 1
  schema-profiles.ts               suite 2
  tools-mapping.ts                 suite 3
  state-machines.ts                suite 4
  policy-matrix.ts                 suite 5
  idempotency-reconciliation.ts    suite 6
  fixtures/valid/*.json            valid example objects (double as spec examples)
report/latest.json                 last run's machine-readable report
```
