# Implementing OSAS — Third-Party Implementer Guide

[中文版](implementing-osas.zh-CN.md)

This guide is for teams building an **independent implementation** of the Open
Support Agent Spec (OSAS) — in any language or stack — and wanting to verify
and declare compatibility. It covers the minimal implementation path,
black-box verification with the compat runner, Conformance Mode, how to
declare compatibility, and how implementers participate in governance.

Independent implementations matter beyond interop: **≥3 passing independent
implementations are a hard gate for declaring OSAS v1.0**, and implementers
gain a formal governance seat at v1.0 (see
[GOVERNANCE.md](../GOVERNANCE.md#path-to-v10)).

## Sources of truth

| Artifact | Role |
|---|---|
| [docs/spec-v0.2.md](spec-v0.2.md) | Normative spec text (cited below by section number) |
| [schemas/manifest.json](../schemas/manifest.json) | Authoritative machine-readable list of every schema (`specVersion: "0.2"`) |
| [schemas/](../schemas/) | Authoritative JSON Schemas (draft 2020-12); the schema wins over prose |
| [CONTRACTS.md](../CONTRACTS.md) | Engineering contract: endpoint table (§9), demo fixtures (§11), error codes |
| [docs/conformance.md](conformance.md) | Conformance Mode contract for stateful verification |
| [GOVERNANCE.md](../GOVERNANCE.md) | Versioning, compatibility declarations, path to v1.0 |

Every persisted object carries `specVersion: "0.2"` as a schema-level `const`
(spec §10). Money is always `{ currency, minorUnits }` integers; timestamps are
ISO 8601 `date-time`; IDs are opaque strings.

## The minimal implementation path

`schemas/manifest.json` is the v0.2 authoritative inventory. It groups schemas by
profile: **core** (14 entries under `core/`), **ecommerce** (2 under
`profiles/ecommerce/`), **saas** (3 under `profiles/saas/`), and **tools**
(20 MCP tool input schemas under `tools/`). The v0.3 Draft execution schemas
are listed separately in `schemas/manifest-v0.3.json`.

### Core profile (required by every implementation)

| Area | What you must implement | Spec reference |
|---|---|---|
| Domain objects | Case, Customer, Evidence, ActionProposal, Approval, TenantPolicy, AuditEvent, HumanHandoff (+ CaseNote, Escalation, KnowledgeArticle) validating against `schemas/core/*.json` | spec §2 |
| State machines | CaseStatus and ProposalStatus transitions, terminal states, no blind retry | spec §3 |
| Permission ladder | `read < draft < request-approval < execute`; model actors capped at `request-approval` | spec §4 |
| Policy evaluation | The deterministic `evaluateProposal` algorithm (reason codes, worst-of decision, default block) | spec §5 |
| Execution | Idempotency by `(tenantId, idempotencyKey)` with replay, `uncertain` → reconciliation, never auto-retry | spec §6 |
| Tools | The 7 `osas_core_*` tool input schemas under `schemas/tools/` | spec §7 |
| Security | §9 requirements (no credentials to models, injection defense, redaction, default deny) | spec §9 |

### Ecommerce profile (additive over core)

- Schemas: `profiles/ecommerce/order.json`, `profiles/ecommerce/shipment.json`.
- Action types: `refund`, `return_request`, `reshipment`, `cancel_order`
  (financial rules for `refund`/`reshipment`: amount + ≥1 evidence).
- Tool input schemas: `osas_ecom_get_order`, `osas_ecom_list_orders`,
  `osas_ecom_get_shipment`.

### SaaS profile (additive over core)

- Schemas: `profiles/saas/subscription.json`, `profiles/saas/invoice.json`,
  `profiles/saas/credit-balance.json`.
- Action types: `credit_apply`, `subscription_cancel`, `plan_change`.
- Tool input schemas: the 6 `osas_saas_*` schemas under `schemas/tools/`.

### Extensions introduced in v0.1.1 (needed to pass the current compat runner)

Introduced as backward-compatible additions (spec §12), but the **current
black-box runner exercises them**, so treat them as required for a
compatibility claim today:

- **Capability manifest** (spec §12.1): publish a `CapabilityManifest`
  validating against `schemas/core/capability-manifest.json`, declaring only
  spec-known capabilities, via `/.well-known/osas` and/or `/v1/capabilities`.
- **Policy version lifecycle** (spec §12.2): immutable versions
  `draft → simulated → approved → active → retired`, lifecycle endpoints,
  `PUT` on the active policy → 409 `POLICY_IMMUTABLE`.
- **Audit hash chain** (spec §12.3): append-only per-tenant SHA-256 chain;
  `GET /v1/audit/verify` → `{ intact: true, ... }`.
- **Shadow Mode** (spec §14) is optional for compatibility — the runner does
  not exercise it.

### v0.3 Draft Controlled Execution profile

The `ecommerce-controlled-execution` profile is tested separately from the
stable v0.2 suite. Implementations must declare `sandbox` and per-action
`executionContracts`, then prove attempts, receipts, idempotency, uncertain
result reconciliation, Provider Event deduplication, and fail-closed policy
boundaries. Run it with:

```bash
pnpm osas:compat -- --target http://localhost:3001 \
  --profile controlled-execution \
  --conformance-key <test-only-key> \
  --provider-event-key <test-only-key> \
  --out controlled-execution-report.json
```

This report is `specVersion: "0.3"` and does not replace the v0.2 report.

### HTTP surface the runner expects

The runner is HTTP-only. The endpoint table in CONTRACTS.md §9 is the
reference; the checks below name exactly which routes are exercised. All
errors use the `{ error: { code, message, details? } }` envelope. Demo-auth
targets read the `x-tenant-id` / `x-osas-role` headers the runner sends;
JWT-mode targets are driven with `--token` (see below).

## Verifying with the compat runner

The black-box runner (`@osas/compat-runner`, `packages/compat-runner/src/`)
drives your implementation over HTTP only — it never imports your code. It
validates responses locally against the schemas in this repository.

### Setup

```bash
pnpm install && pnpm build      # builds @osas/core, schema-validator, runner deps
```

### Read-only suites (no key required)

```bash
pnpm osas:compat -- --target https://your-osas-service.example.com
```

Always executed:

| Suite | Checks |
|---|---|
| `discovery` | `GET /.well-known/osas` → 200 JSON object; `specVersion === "0.2"`; CapabilityManifest (embedded as `capabilities` or via `GET /v1/capabilities`) validates against `core/capability-manifest`; manifest declares only known profiles (`core`/`ecommerce`/`saas`) and spec-known capabilities |
| `schemas-tools` | `GET /v1/schemas` lists the manifest (must include `core/action-proposal`); `GET /v1/schemas/core/action-proposal` returns a JSON Schema; `GET /v1/meta/tools` lists tools with `name` + `inputSchema` + known `capabilityRequired`; `POST /v1/validate` accepts a valid ActionProposal (`{valid: true}`) and rejects an invalid one (`{valid: false}`) |
| `policy-read` | `GET /v1/policies/:tenant` returns the active TenantPolicy validating against `core/tenant-policy`; `POST /v1/policies/:tenant/simulate` with an unknown version → 404 |

Without a conformance key the stateful suite is recorded as **skipped** and
the run can still be `ok` — but a compatibility claim should be backed by a
full stateful run (see below).

### Stateful suite (requires Conformance Mode on your side)

Start your service with Conformance Mode enabled, then pass the key:

```bash
pnpm osas:compat -- --target http://localhost:8080 \
  --conformance-key <test-only-key> --out osas-compat-report.json
```

(Equivalently, set `OSAS_CONFORMANCE_MODE=true` + `OSAS_CONFORMANCE_KEY` in
the runner's own environment.) The stateful checks, in order:

| # | Check | Expectation |
|---|---|---|
| 1 | Wrong conformance key | `POST /v1/conformance/reset` with a bad key → 401 or 403 |
| 2 | `POST /v1/conformance/reset` | Restores the demo fixture state; response has `snapshot.counts` with `cases >= 1` |
| 3 | `GET /v1/conformance/snapshot` | `auditChain.intact === true` |
| 4 | Policy lifecycle | draft → simulate (small verified refund → `auto_execute`; over-threshold → `require_approval`; unverified identity → `block`) → approve → activate (active version switches) → retire |
| 5 | Illegal transition | approve before simulate → 409 |
| 6 | Immutability | `PUT /v1/policies/:tenant` → 409 `POLICY_IMMUTABLE` |
| 7 | Idempotent execution | create proposal → evaluate (`auto_execute`) → execute → execute again with the same key → `replayed: true`, no second side effect |
| 8 | RBAC | `x-osas-role: support_agent` creating a policy draft → 403 |
| 9 | Tenant isolation | reading another tenant's policy → 403 `TENANT_MISMATCH` |
| 10 | Audit chain | `GET /v1/audit/verify` → `intact: true`; `/v1/audit` contains `policy_draft_created`, `policy_activated`, `execution_succeeded` |
| 11 | Cleanup | final reset returns 200 |

Note the fixture dependency: checks 4 and 7 use the demo dataset from
CONTRACTS.md §11 (`tenant_demo`, `case_refund`, `cus_verified`,
`cus_unverified`, `ord_small`, `ev_ord_small`, demo policy with a $50 refund
auto-execute threshold). Your `reset` must seed an equivalent deterministic
dataset — see the next section.

### Runner options, report, exit codes

| Option / env | Meaning |
|---|---|
| `--target <url>` | Base URL of your implementation (required) |
| `--token <token>` | Bearer token for JWT-mode targets |
| `--tenant <id>` | Tenant id (default `tenant_demo`); also sent as `x-tenant-id` |
| `--role <role>` | Demo-auth role for privileged checks (default `policy_admin`) |
| `--conformance-key <key>` | Enables the stateful suite |
| `--timeout <ms>` | Per-request timeout (default 10000) |
| `--out <file>` | Also write the JSON report to a file |

Exit codes: **0** = all checks passed, **1** = one or more failed, **2** =
usage error.

The report is machine-readable JSON:

```jsonc
{
  "specVersion": "0.2",
  "generator": "@osas/compat-runner@0.2.0",
  "target": "http://localhost:8080",
  "runAt": "2026-09-07T…",
  "mode": { "stateful": true },
  "ok": true,                       // zero failed checks
  "totals": { "passed": 22, "failed": 0, "skipped": 0 },
  "suites": [ { "name": "…", "passed": 0, "failed": 0, "skipped": 0, "checks": [ { "name": "…", "status": "pass|fail|skip", "detail": "…" } ] } ]
}
```

`ok: true` means **zero failed checks** (skips do not fail the run, but a
claim based on a stateful-skipped run is weak evidence). This mirrors the
report format produced by the in-repo suite at
`tests/compat/report/latest.json` referenced by
[GOVERNANCE.md](../GOVERNANCE.md#declaring-compatibility): same `ok` /
`suites` / per-check semantics.

## Conformance Mode in your own implementation

To unlock the stateful suite, implement the Conformance Mode contract from
[docs/conformance.md](conformance.md). The runner only relies on the HTTP
behavior; aligning with the full contract is strongly recommended:

- **Test-only.** Conformance Mode must never be reachable in production.
- **Fail closed.** Enabling the mode together with a production environment
  aborts startup; enabling it without a key aborts startup. When the mode is
  off the endpoints are **not registered at all** (404).
- **Constant-time key check.** Every request requires
  `X-OSAS-Conformance-Key: <key>`, compared in constant time (the reference
  API uses `timingSafeEqual` over SHA-256 hashes); wrong/missing key → 403.
- **Deterministic reset.** `POST /v1/conformance/reset` wipes all mutable
  state and re-seeds the CONTRACTS.md §11 demo fixtures;
  `POST /v1/conformance/fixtures/load` supports `{ "name": "demo" | "empty" }`;
  `GET /v1/conformance/snapshot` returns per-tenant counts plus the
  audit-chain verification result.

| Endpoint | Behavior |
|---|---|
| `POST /v1/conformance/reset` | Wipe + re-seed demo fixtures; return a snapshot |
| `POST /v1/conformance/fixtures/load` | `{ "name": "demo" \| "empty" }` |
| `GET /v1/conformance/snapshot` | Per-tenant counts + `auditChain` verification |

## Declaring compatibility

Per [GOVERNANCE.md](../GOVERNANCE.md#declaring-compatibility):

- Declare **profile compatibility** (`core`, `ecommerce`, or `saas`) only when
  the current compatibility tooling passes against your implementation and the
  machine-readable report shows `ok: true`.
- **Name the spec version and profile** in the claim, e.g.
  `"OSAS 0.2 ecommerce-compatible"`. Your objects must carry
  `specVersion: "0.2"`; claims against a future spec line follow its version.
- **Retain the report.** Keep the runner output (`--out osas-compat-report.json`,
  from a full stateful run) alongside the claim so it can be re-verified.
- While v0.x, minor spec bumps may be breaking — re-run the suite when the
  `specVersion` line you target changes (see
  [GOVERNANCE.md §Versioning](../GOVERNANCE.md#versioning)).

## Participating in governance

- **v1.0 gate and seats.** v1.0 requires ≥3 independent implementations
  passing the compat suite for a profile; organizations with passing
  implementations hold seats in spec decisions alongside the founding
  maintainers once governance broadens (GOVERNANCE.md §Path to v1.0). Open an
  issue or discussion to get your implementation counted.
- **RFCs.** Breaking changes and new semantics require an RFC: copy
  [rfcs/0000-template.md](../rfcs/0000-template.md) to
  `rfcs/NNNN-short-name.md`, open a PR with Status `Draft`. As an implementer
  you are encouraged to file RFCs for semantics your stack surfaces.
- **Contributing.** [CONTRIBUTING.md](../CONTRIBUTING.md) covers the PR
  checklist and the release gate (schemas, EN+ZH docs, reference
  implementation, and compat tests land in the same PR).

## Using the reference implementation as a known-good target

Before testing your own service, run the runner against this repository's
reference implementation to see the expected behavior end to end:

```bash
pnpm install && pnpm build
pnpm dev:api                       # reference API on http://localhost:3001,
                                   # mock backend seeded by default (SEED_DEMO),
                                   # demo auth (x-osas-role headers)
pnpm osas:compat -- --target http://localhost:3001
```

To watch the **stateful** suite pass, restart the API with Conformance Mode
enabled and re-run with the key:

```bash
OSAS_CONFORMANCE_MODE=true OSAS_CONFORMANCE_KEY=test-key pnpm dev:api
pnpm osas:compat -- --target http://localhost:3001 \
  --conformance-key test-key --out reference-report.json
```

`docker compose up --build` gives the same API in a container. Inspect
`reference-report.json` check by check — it is the exact contract your own
implementation must satisfy.
