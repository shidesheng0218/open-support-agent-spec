# OSAS Conformance Matrix

Per-case pass matrix for implementations in
[implementations.json](implementations.json). Rows are case groups (by suite /
endpoint scenario), columns are implementations. **pass** = green in the latest
run; **candidate** = in-repo candidate still working through the suite.

## White-box compat suite (`pnpm test:compat`, `@osas/compat-suite`)

Source of truth for case names and per-case results:
`tests/compat/src/*.ts`, aggregated into `tests/compat/report/latest.json` on
every run.

| Case group | OSAS TS reference (v0.2) | Python reference candidate |
|---|---|---|
| `schema-core` — manifest entries, valid/invalid fixtures, `specVersion`, Money, enums (185 cases + 1 currently failing on in-flight `tenant-policy` edits outside this matrix) | pass | candidate |
| `schema-profiles` — order, shipment, subscription, invoice, credit-balance, shipment-incident, refund-transaction, item-claim, exchange-request, cross-profile rejection (23 cases) | pass | candidate |
| `tools-mapping` — exactly the 20 contract tools, 1:1 schema/adapter mapping, no `executeAction` tool, permission discipline (43 cases) | pass | candidate |
| `state-machines` — full legality tables for Case and ActionProposal transitions (36 cases) | pass | candidate |
| `policy-matrix` — §4 policy matrix: threshold, identity, evidence freshness, region, permission overreach, injection, duplicate, reason code, currency (11 cases) | pass | candidate |
| `idempotency-reconciliation` — idempotent replay, no side effects, `uncertain` → reconciliation without auto-retry, reconcile → executed (4 cases) | pass | candidate |
| `capabilities-policy-audit` — CapabilityManifest validation, 20 capabilities, tool capability mapping, policy lifecycle immutability, audit hash chain integrity and tenant isolation (8 cases) | pass | candidate |

Latest recorded run (2026-09-14): **310 passed / 1 failed** for the TypeScript
reference implementation. The single failure is `core/tenant-policy: enum
violation at 'approval.onTimeout' rejected`, caused by uncommitted
`tenant-policy`/`approval` schema edits in flight outside this page — the
committed baseline (2026-09-13) was 307 passed / 0 failed.

## Black-box runner (`pnpm osas:compat -- --target <url>`, `@osas/compat-runner`)

Source of truth for check names: `packages/compat-runner/src/runner.ts`.
Read-only suites run anywhere; the `stateful` and `controlled-execution`
suites require Conformance Mode (see [docs/conformance.md](../docs/conformance.md)).

| Runner check | OSAS TS reference (v0.2) | Python reference candidate |
|---|---|---|
| `discovery` — `/.well-known/osas`, manifest capabilities, spec-known profiles (3 checks) | pass | — |
| `schemas-tools` — `GET /v1/schemas`, per-schema JSON Schema, `GET /v1/meta/tools` (3 checks) | pass | — |
| `policy-read` — `GET /v1/policies/:tenant`, simulate with unknown version → 404 (2 checks) | pass | — |
| `stateful` — conformance key 403, reset restores demo fixtures, snapshot reports intact audit chain, policy lifecycle draft→simulated→approved→active→retire, illegal transitions → 409, active policy immutable (PUT → 409), idempotent execution replay, `support_agent` cannot administer policies (403), cross-tenant rejected (403), audit chain records lifecycle, final reset leaves clean state (10 checks) | pass | — |
| `controlled-execution` — sandbox execution contract advertised, conformance/provider keys required, sandbox refund returns attempt + receipt, `GET /v1/executions/:id`, idempotent replay, timeout → `reconciliation_required` without retry, provider-event dedup resolves uncertain result, policy-blocked action cannot execute (9 checks) | pass | — |

The TypeScript reference passes the full black-box runner including the
stateful suite for its declared profiles (see
[badges/osas-reference-v0.3.json](badges/osas-reference-v0.3.json)).

## Refreshing this matrix

```bash
pnpm test:compat                     # white-box suite → tests/compat/report/latest.json
pnpm osas:compat -- --target <url>   # black-box runner → console report JSON
```

This page is generated/verified by hand from those two artifacts; there is no
automatic renderer yet. If the numbers disagree with a fresh run, the run wins
— update this file in the same PR.

## Add a row for your implementation

1. Follow the [implementer guide](../docs/implementing-osas.md) and the
   [registration flow](README.md#registration-flow) in this directory.
2. Run both suites above against your target and attach the reports.
3. On acceptance, a maintainer PR adds your implementation column here (and to
   `implementations.json` + `badges/`), grouped by case name exactly as the
   suite emits them.
