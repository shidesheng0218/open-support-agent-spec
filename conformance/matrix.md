# OSAS Conformance Matrix

Per-case pass matrix for implementations in
[implementations.json](implementations.json). Rows are case groups (by suite /
endpoint scenario), columns are implementations. **pass** = green in the latest
recorded run; **n/a** = suite does not apply to that implementation.

Latest recorded runs (2026-09-14): white-box **311 passed / 0 failed**
(TypeScript reference); black-box **22/22 passed** (v0.2 suites) and **29/29
passed** (v0.3 `controlled-execution` profile) for both the TypeScript
reference and the Python reference candidate.

## White-box compat suite (`pnpm test:compat`, `@osas/compat-suite`)

Source of truth for case names and per-case results:
`tests/compat/src/*.ts`, aggregated into `tests/compat/report/latest.json` on
every run. This suite imports the workspace packages and runs inside the
TypeScript workspace, so it only applies to the TypeScript reference; every
other implementation is verified through the black-box runner below.

| Case group | OSAS TS reference (v0.2) | Python reference candidate |
|---|---|---|
| `schema-core` — manifest entries, valid/invalid fixtures, `specVersion`, Money, enums (186 cases) | pass | n/a (TS-only suite) |
| `schema-profiles` — order, shipment, subscription, invoice, credit-balance, shipment-incident, refund-transaction, item-claim, exchange-request, cross-profile rejection (23 cases) | pass | n/a (TS-only suite) |
| `tools-mapping` — exactly the 20 contract tools, 1:1 schema/adapter mapping, no `executeAction` tool, permission discipline (43 cases) | pass | n/a (TS-only suite) |
| `state-machines` — full legality tables for Case and ActionProposal transitions (36 cases) | pass | n/a (TS-only suite) |
| `policy-matrix` — §4 policy matrix: threshold, identity, evidence freshness, region, permission overreach, injection, duplicate, reason code, currency (11 cases) | pass | n/a (TS-only suite) |
| `idempotency-reconciliation` — idempotent replay, no side effects, `uncertain` → reconciliation without auto-retry, reconcile → executed (4 cases) | pass | n/a (TS-only suite) |
| `capabilities-policy-audit` — CapabilityManifest validation, 20 capabilities, tool capability mapping, policy lifecycle immutability, audit hash chain integrity and tenant isolation (8 cases) | pass | n/a (TS-only suite) |

## Black-box runner (`pnpm osas:compat -- --target <url>`, `@osas/compat-runner`)

Source of truth for check names: `packages/compat-runner/src/runner.ts`.
Read-only suites run anywhere; the `stateful` and `controlled-execution`
suites require Conformance Mode (see [docs/conformance.md](../docs/conformance.md)).

| Runner suite | OSAS TS reference | Python reference candidate |
|---|---|---|
| `discovery` — `/.well-known/osas` responds, `specVersion` is "0.2", CapabilityManifest validates against `core/capability-manifest`, manifest declares known profiles and capabilities (4 checks) | pass | pass |
| `schemas-tools` — `GET /v1/schemas` lists the manifest, per-schema JSON Schema served, `GET /v1/meta/tools` maps schemas + capabilities, `POST /v1/validate` accepts valid and rejects invalid ActionProposals (5 checks) | pass | pass |
| `policy-read` — `GET /v1/policies/:tenant` validates against `core/tenant-policy`, simulate with unknown version → 404 (2 checks) | pass | pass |
| `stateful` — wrong conformance key → 403, reset restores demo fixtures, snapshot reports intact audit chain, policy lifecycle draft→simulated→approved→active→retire (with simulation assertions), illegal transition → 409, active policy immutable (PUT → 409 `POLICY_IMMUTABLE`), idempotent execution replay, `support_agent` cannot administer policies → 403, cross-tenant → 403 `TENANT_MISMATCH`, audit chain records lifecycle events, final reset (11 checks) | pass | pass |
| `controlled-execution` — Sandbox + refund execution contract advertised, sandbox refund returns attempt + receipt, `GET /v1/executions/:id`, idempotent replay, timeout → `reconciliation_required` without retry, Provider Event dedup resolves the uncertain result, policy-blocked action cannot execute (7 checks, v0.3 profile) | pass | pass |

Both implementations pass the full black-box runner including the stateful
suite for their declared profiles — see
[badges/](badges/) (`osas-reference-v0.3.json`,
`osas-python-reference-v0.2.json`, `osas-python-reference-v0.3.json`).

## Refreshing this matrix

```bash
pnpm test:compat                     # white-box suite → tests/compat/report/latest.json
pnpm osas:compat -- --target <url> --conformance-key <key>   # black-box suites
pnpm osas:compat -- --target <url> --profile controlled-execution \
  --conformance-key <key> --provider-event-key <key>         # v0.3 profile
```

This page is verified by hand from those artifacts; there is no automatic
renderer yet. If the numbers disagree with a fresh run, the run wins — update
this file in the same PR.

## Add a row for your implementation

1. Follow the [implementer guide](../docs/implementing-osas.md) and the
   [registration flow](README.md#registration-flow) in this directory.
2. Run the black-box suites above against your target and attach the reports.
3. On acceptance, a maintainer PR adds your implementation column here (and to
   `implementations.json` + `badges/`), grouped by suite name exactly as the
   runner emits them.