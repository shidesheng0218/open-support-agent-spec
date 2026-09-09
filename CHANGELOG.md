# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Controlled Execution Profile (v0.3 Draft)**: deterministic `sandbox` mode,
  execution attempts and receipts, provider-event deduplication, reconciliation
  tasks, execution capability contracts, and PostgreSQL persistence for the new
  records. `live` remains fail-closed and no real provider write path was added.
- New `GET /v1/executions/:id`, `GET /v1/reconciliation`, and
  `POST /v1/provider-events` routes. Provider events require the internal
  `OSAS_PROVIDER_EVENT_KEY` / `x-osas-provider-key` boundary and are schema
  validated and audit recorded.
- RFC 0003 and bilingual controlled-execution documentation.
- The synthetic after-sales evaluation set now contains 100 cases (10 per Top-10
  scenario), while the existing 120-case policy evaluation remains unchanged.

### Changed

- Capability manifests can publish per-action `executionContracts`; the mock
  sandbox declares synthetic support without advertising `live`.
- PostgreSQL migrations persist execution attempts, receipts, reconciliation
  tasks, and provider events with tenant-scoped uniqueness constraints.

## [0.2.0] - 2026-09-07

This release covers Milestones 1–4 (capability declaration, policy version
lifecycle and audit integrity; runtime substrate; Shadow Mode with the Zendesk
and Shopify reference adapters; the black-box compat runner, Conformance Mode
and evaluation suite), the new Chatwoot reference adapter, the third-party
implementer guide, standalone policy-engine embedding, and RFC 0002. It opens
the 0.2 spec line: `specVersion` is bumped from `"0.1"` to `"0.2"`, and the
normative spec text moves to `docs/spec-v0.2.md` (+ zh-CN).

### Added

- **`@osas/chatwoot-adapter`** reference adapter for Chatwoot (open-source
  helpdesk): conversations ↔ Case (`cw_conv_{id}`), contacts ↔ Customer
  (`cw_contact_{id}`), private notes, escalation via team assignment +
  `[OSAS escalation]` private note, conversation/contact evidence capture with
  console URLs as sources, idempotency-key replay + `X-Idempotency-Key`
  header, env config (`CHATWOOT_BASE_URL`, `CHATWOOT_ACCOUNT_ID`,
  `CHATWOOT_API_TOKEN`, optional `CHATWOOT_ESCALATION_TEAM_ID`), fail closed
  (`CHATWOOT_NOT_CONFIGURED`) without credentials. Capability manifest
  declares only the supported core-profile capabilities (`case.read`,
  `customer.read`, `evidence.read`, `note.write`, `escalation.write`); all
  unsupported methods throw `AdapterCapabilityError` (`CAPABILITY_UNSUPPORTED`)
  without any HTTP call. Tests run against mock HTTP only — no external
  credentials needed. Docs: [docs/chatwoot-adapter.md](docs/chatwoot-adapter.md)
  (+ zh-CN).
- **Third-party implementer guide**: [docs/implementing-osas.md](docs/implementing-osas.md)
  (+ zh-CN) — the minimal implementation surface per profile, black-box
  verification with `@osas/compat-runner` (read-only and stateful suites),
  Conformance Mode expectations, how to declare compatibility
  ("OSAS 0.2 <profile>-compatible"), and the path to a governance seat.
- **Standalone policy-engine embedding**: `packages/policy-engine/README.md`
  (+ zh-CN) documents using `@osas/policy-engine` without the OSAS API/MCP
  server; new runnable minimal example `examples/embed-policy-engine/`
  (auto-execute small refund, over-threshold approval, `PERMISSION_OVERREACH`
  block — all asserted). `@osas/core`, `@osas/schema-validator`, and
  `@osas/policy-engine` are now npm-publish-ready (`publishConfig.access:
  public`, license, repository metadata; lockstep versioning unchanged) and
  carry their own READMEs (EN + zh-CN).
- **RFC 0002** ([rfcs/0002-osas-as-mcp-governance-profile.md](rfcs/0002-osas-as-mcp-governance-profile.md)):
  positions OSAS as the vertical governance profile for customer-support
  agents on top of the MCP/A2A/AG-UI ecosystem — MCP stays the tool
  transport, governance semantics remain the spec's ownable surface, and
  embedding is a first-class adoption path.

- **Black-box compat runner (Milestone 4)**: new package `@osas/compat-runner`
  (`pnpm osas:compat -- --target http://localhost:3001 [--token <t>]`) — an
  HTTP-only conformance runner that verifies discovery (`/.well-known/osas`,
  specVersion, Capability Manifest), tool/schema endpoints, `POST /v1/validate`,
  the active-policy surface, and policy-simulation behavior. With a conformance
  key (`OSAS_CONFORMANCE_MODE=true` + `OSAS_CONFORMANCE_KEY` or
  `--conformance-key`) it additionally runs the stateful suite: policy
  lifecycle state machine (draft → simulate → approve → activate → retire,
  illegal transitions rejected, active policy immutable), simulation result
  correctness (auto_execute / require_approval / block), idempotent execution
  replay, RBAC and tenant isolation, and audit-chain integrity. Emits a
  machine-readable JSON report and exits non-zero on any failure.
- **Conformance Mode (test-only, fail closed)**: `OSAS_CONFORMANCE_MODE=true` +
  `OSAS_CONFORMANCE_KEY` registers `POST /v1/conformance/reset`,
  `POST /v1/conformance/fixtures/load` (`demo`/`empty`), and
  `GET /v1/conformance/snapshot`, each gated by the constant-time-compared
  `X-OSAS-Conformance-Key` header. Startup refuses the mode with
  `NODE_ENV=production` or without a key; endpoints are not registered at all
  otherwise. CI enables it only for the disposable Docker environment.
  Docs: [docs/conformance.md](docs/conformance.md) (+ zh-CN).
- **Evaluation suite** (`evals/`, `@osas/evals`): 120 synthetic, PII-free cases
  (30 refunds, 20 returns, 15 reshipments, 15 cancellations, 20 general
  inquiries, 20 security boundaries) with expected action, policy result,
  reason codes, handoff reason, and evidence requirements per case.
  `pnpm eval:policy` runs fully offline and is a hard CI gate (100% schema
  validity, 100% policy consistency, 0 overreach, 0 duplicate executions,
  0 security-boundary bypass; exits non-zero otherwise). `pnpm eval:model`
  runs only with an explicitly configured real provider (never in CI) and
  reports model semantic accuracy independently of the safety gates.
- Test-only `reset()` on the in-memory stores (`InMemoryPolicyStore`,
  `InMemoryExecutionStore`, `InMemoryUsageStore`, `InMemoryShadowRunStore`)
  and `MockSupportAdapter.reset(fixtures)` to back the conformance endpoints.

- **Shadow Mode (Milestone 3)**: `OSAS_EXECUTION_MODE=shadow | live` (default
  `shadow`; `live` refuses startup with `LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1`).
  New `ShadowRun` core object + `schemas/core/shadow-run.json`
  (`proposalId`, `policyDecision`, `wouldAutoExecute`, `suggestedAction`,
  `humanOutcome` accepted/rejected/modified/pending, `humanComment`,
  `externalReference`, `createdAt`/`reviewedAt`), new package
  `@osas/ecommerce-shadow` (planning/review logic, `ShadowRunStore` seam,
  in-memory store, execution-mode loader), `PostgresShadowRunStore` +
  migration `0002_shadow_runs_milestone3.sql`, and API endpoints
  `POST /v1/proposals/:id/shadow-run`, `POST /v1/shadow-runs/:id/review`,
  `GET /v1/shadow-runs[/:id]`. Creation and human accept/reject/modify write
  hash-chained `shadow_run_created` / `shadow_run_reviewed` audit events;
  reviewed ShadowRuns are final (409 on re-review); proposals under shadow
  review can never be executed (409) and are never marked `executed`.
- **Console Shadow page** (`/shadow`): pending human reviews, the agent's
  suggested action, policy reasons, original evidence links and audit-chain
  verification status — deliberately no live-execute UI.
- **`@osas/zendesk-adapter`** reference adapter: tickets ↔ Case, requesters ↔
  Customer, internal notes, escalations to a configured default group,
  evidence capture with Zendesk ids + agent URLs as sources, idempotency-key
  replay + `X-Idempotency-Key` header, env config (`ZENDESK_BASE_URL` /
  `ZENDESK_SUBDOMAIN` / `ZENDESK_EMAIL` / `ZENDESK_API_TOKEN` /
  `ZENDESK_ESCALATION_GROUP_ID`), fail closed (`ZENDESK_NOT_CONFIGURED`)
  without credentials.
- **`@osas/shopify-adapter`** read-only reference adapter: orders,
  per-customer orders and fulfillments → OSAS Order/Shipment/Evidence;
  `buildRefundProposalDraft()` prices refund Proposals (refundable amount,
  currency, order status, evidence) from live data. No refund write path:
  `executeAction` always throws `CAPABILITY_UNSUPPORTED` without any HTTP
  call; real refund execution requires a future RFC. Fail closed
  (`SHOPIFY_NOT_CONFIGURED`) without credentials.
- Docs: [docs/adapter-guide.md](docs/adapter-guide.md) (+ zh-CN) and
  [docs/zendesk-shopify-shadow.md](docs/zendesk-shopify-shadow.md) (+ zh-CN);
  spec §14; both adapters test against mock HTTP only — no external
  credentials needed anywhere, and the demo Docker environment keeps the
  Mock Adapter.
- Root `pnpm verify` script (`scripts/verify.sh`): one-command release gate running
  typecheck, unit/contract tests, the compat suite, `docker compose` build + boot,
  API/web health checks, and Playwright E2E against the Docker stack
  (`E2E_BASE_URL=http://localhost:8080`), always tearing Docker down afterwards.
- Static web health endpoint `GET /healthz` in `apps/web/nginx.conf` (nginx-level,
  independent of the API); `GET /health` keeps proxying to the API.
- New API and E2E tests for compat-report availability in Docker environments.

### Fixed

- `GET /v1/policies/:tenantId` now returns a pure `TenantPolicy` (lifecycle
  metadata stripped) so the response validates against
  `schemas/core/tenant-policy.json` (`additionalProperties: false`) — caught by
  the black-box runner; version records with lifecycle fields remain available
  via `GET /v1/policies/:tenantId/versions`.


### Changed

- The API Docker image now runs the compat suite during the image build, so
  `GET /v1/compat/report` always serves a report generated by that build (the
  report directory remains git-ignored); a failing compat suite fails the build.
- `GET /v1/compat/report` returns a structured `COMPAT_REPORT_NOT_GENERATED`
  error (404) instead of a bare `NOT_FOUND` when no report exists; the web
  console recognizes the code and shows an actionable hint (`pnpm test:compat`)
  rather than a system error.
- CI `docker` job additionally asserts the compat report endpoint and the static
  web `/healthz`.


## [0.1.1] — Milestone 2: authentication, PostgreSQL persistence, LLM providers and cost control

### Added

- **Authentication & tenant isolation** (`OSAS_AUTH_MODE`): `demo` (header-driven
  principals, default; fails closed under `NODE_ENV=production`) and `jwt`
  (OIDC Bearer tokens verified against `OSAS_JWKS_URL` / `OSAS_JWT_ISSUER` /
  `OSAS_JWT_AUDIENCE` via `jose`; `sub` / `tenant_id` / `roles` from verified
  claims, `x-tenant-id` ignored). Roles `support_agent` / `policy_admin` /
  `auditor` / `system_executor`; external requests can never obtain `execute`,
  and tokens/headers claiming `system_executor` are rejected. Route-layer tenant
  matching (403 `TENANT_MISMATCH`). `/health` stays anonymous for probes.
- **PostgreSQL storage** (`OSAS_STORAGE=postgres`, `@osas/store-postgres`):
  SQL migrations + `pnpm db:migrate` / `db:seed` / `db:reset` (reset is
  development-only), tenant-scoped tables for tenants, policy versions,
  proposals, approvals, evidence, audit events, execution records, shadow runs
  and model usage; `(tenant_id, idempotency_key)` enforces execution
  idempotency; execution state + audit mirror commit in one transaction;
  startup fails closed when the database is unreachable. `docker compose`
  gains opt-in `db` + one-shot `migrate` services under the `postgres` profile.
- **LLM provider & cost control** (`OSAS_LLM_PROVIDER`): `OpenAICompatibleProvider`
  (plain HTTP, no vendor SDK; key from env only, never logged/audited; fixed
  task→tier routing: classify/extract→fast, reply/propose→standard; native
  JSON-Schema structured output with at most one fallback retry, validated via
  the OSAS Schema Validator). Costs are recorded as unknown unless both price
  settings are present (never fabricated). Daily/per-case budgets block calls
  pre-flight at the cap and write `budget_warning` audit events at 80%.
  Provider/structured-output/budget failures degrade to a safe template or
  human handoff — never execution. Model telemetry persists through the new
  `UsageStore` (in-memory + Postgres) and is queryable via operator-only
  `GET /v1/usage` (filters: tenant, date, model, task).
- New audit event type `budget_warning`; `AuditModelInfo.costUsd` is now
  optional (absent = unknown cost) in types and `schemas/core/audit-event.json`.
- `.env.example` template documenting every `OSAS_*` variable (no secrets).

### Changed

- `ExecutionStore` and `PolicyStore` interfaces are now async (Promise-based)
  to support real storage backends; all callers and tests updated.
- The Milestone 1 `x-osas-role` seam (`policyAdminActor`) now reads the
  authenticated principal; demo mode keeps the header experience.
- The API Docker image runs `NODE_ENV=demo` + `OSAS_AUTH_MODE=demo` by default
  (production deployments must configure jwt auth).

## [0.1.1] — Milestone 1: capability declaration, policy versioning, audit integrity

### Added

- **Capability manifest**: `schemas/core/capability-manifest.json`,
  `CapabilityManifest`/`Capability` types and enums in `@osas/core`, the optional
  `SupportAdapter.getCapabilities` provider, `requireAdapterCapability`
  enforcement in `@osas/adapter`, `AdapterCapabilityError`
  (`CAPABILITY_UNSUPPORTED`), per-tool `capabilityRequired` in the MCP catalog
  with server-side enforcement, and the discovery endpoints
  `GET /.well-known/osas` + `GET /v1/capabilities`. The mock adapter declares
  all 16 spec capabilities; adapters without a provider stay permissive.
- **Policy version lifecycle**: immutable policy versions
  `draft → simulated → approved → active → retired`
  (`POLICY_VERSION_TRANSITIONS` in `@osas/core`, `PolicyStore` /
  `InMemoryPolicyStore` in `@osas/policy-engine`), pure policy simulation
  (no Approval/Execution/Handoff/business writes), activation provenance
  (actor/time/previous/new version), demo-mode `policy_admin` role via the
  `x-osas-role` header, audit events for every policy change, and the APIs
  `GET /v1/policies/:tenantId/versions`, `POST .../drafts`, `POST .../simulate`,
  `POST .../versions/:version/approve|activate|retire`.
- **Audit integrity**: optional `sequence`/`previousHash`/`eventHash` hash-chain
  fields on AuditEvent (per-tenant append-only SHA-256 chain over stable JSON),
  `hashAuditEvent`/`verifyAuditChain` in `@osas/policy-engine`, hash-chained
  appends in the mock adapter, and `GET /v1/audit/verify` returning
  `{ tenantId, chainLength, intact, firstError? }`. Tamper-evidence only; does
  not replace WORM storage.
- Compat suite: new `capabilities-policy-audit` suite plus automatic
  capability-manifest schema checks.

### Changed

- `PUT /v1/policies/:tenantId` no longer overwrites the active policy; it
  returns 409 `POLICY_IMMUTABLE`. Runtime policy evaluation resolves the active
  version from the policy store (legacy adapter policies are lazily imported as
  the initial active version). `defaultDecision: "block"` is unchanged.

## [0.1.0] - 2026-09-05

First public draft of the Open Support Agent Spec (OSAS). **Draft status — not a
stable release; interfaces may change before v1.0.**

### Added

- Normative specification v0.1 in English and Chinese (`docs/spec-v0.1.md`,
  `docs/spec-v0.1.zh-CN.md`): core domain model, state machines, permission ladder,
  deterministic policy evaluation algorithm, execution/idempotency/reconciliation
  rules, MCP tool profiles, model gateway contract, and security requirements.
- Authoritative JSON Schemas (draft 2020-12) under `schemas/` with
  `schemas/manifest.json`: 8 core objects plus `common.json`, `ecommerce` and `saas`
  profile objects, and one input schema per MCP tool (16 tools).
- TypeScript reference implementation (pnpm monorepo, ESM, strict TS):
  - `@osas/core` — types, enums, state machines, `detectInjection`, id helpers.
  - `@osas/schema-validator` — Ajv v8 + ajv-formats loader/validator over `schemas/`.
  - `@osas/policy-engine` — TenantPolicy evaluation, permission ladder enforcement,
    execution orchestration with idempotency and reconciliation.
  - `@osas/model-gateway` — provider interface, deterministic `MockModelProvider`,
    tier routing, output caps, budgets, telemetry.
  - `@osas/adapter` — `SupportAdapter` interface, errors, and a BYO adapter template.
  - `@osas/mock-backend` — synthetic fixtures and `MockSupportAdapter`.
  - `@osas/mcp-server` — `TOOL_DEFINITIONS` (16 tools) and stdio MCP server.
  - `@osas/api` — Fastify 5 HTTP API on port 3001 with seeded demo tenant.
  - `@osas/web` — React 18 + Vite console on port 5173 with developer / agent /
    platform paths and three one-click `/demo` scenarios.
- Compatibility suite `@osas/compat-suite` covering schema validation, cross-profile
  action-type rules, tool/adapter/schema 1:1 mapping, state-machine legality, the
  policy evaluation matrix, and idempotency/reconciliation, emitting a
  machine-readable report to `tests/compat/report/latest.json`.
- Playwright smoke suite `@osas/e2e` (opt-in via `E2E=1`).
- Governance and project documents: README (EN/ZH), CONTRIBUTING (EN/ZH),
  CODE_OF_CONDUCT (Contributor Covenant 2.1), SECURITY, GOVERNANCE,
  RFC template and RFC 0001 (`rfcs/0000-template.md`, `rfcs/0001-v0.1-core.md`).
- CI workflow (`.github/workflows/ci.yml`): `build-test`, `compat` (with report
  artifact), `docker`, and `e2e` jobs on push/PR to `main`.
- Docker support: `docker-compose.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`,
  `apps/web/nginx.conf` — console on http://localhost:8080, API on :3001.
