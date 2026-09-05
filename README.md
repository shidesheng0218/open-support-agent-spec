# Open Support Agent Spec (OSAS)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Spec: v0.1 Draft](https://img.shields.io/badge/spec-v0.1%20Draft-orange.svg)](docs/spec-v0.1.md)
[![CI](https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml/badge.svg)](https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml)

[中文文档](README.zh-CN.md)

OSAS is an **open interoperability specification for customer-support AI agents**: a shared
contract for how an agent reads business data, proposes actions, passes policy checks, executes
or escalates, and leaves a complete audit trail — independent of any specific model, helpdesk,
or commerce platform.

> **Status: v0.1 Draft.** OSAS is a **draft open specification under active development**.
> It is **not** a claimed industry standard, and no stability guarantees are made yet.
> Interfaces, schemas, and behaviors may change before v1.0. See
> [Status & roadmap](#status--roadmap).

## What it delivers

- **The specification** — normative text in [`docs/spec-v0.1.md`](docs/spec-v0.1.md)
  ([中文](docs/spec-v0.1.zh-CN.md)), with machine-checkable JSON Schemas (draft 2020-12) under
  [`schemas/`](schemas/) as the authoritative form.
- **A TypeScript reference agent** — a runnable monorepo implementing the full pipeline:
  model gateway, policy engine, MCP tool server, HTTP API, and web console.
- **Three profiles** — `core` (cases, customers, evidence, notes, escalations) plus two
  extension profiles: `ecommerce` (orders, shipments, refunds, reshipments) and `saas`
  (subscriptions, invoices, credit balances, credits, plan changes).
- **Schema & compatibility suite** — `@osas/compat-suite` validates schemas, state machines,
  the policy matrix, tool mappings, idempotency, and reconciliation, and emits a
  machine-readable report. Passing it is the requirement for declaring OSAS profile
  compatibility (see [GOVERNANCE.md](GOVERNANCE.md)).

## Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │                Model gateway                  │
                       │   tier routing · output caps · budget ·       │
                       │   injection detection · telemetry             │
                       └───────────────┬──────────────────────────────┘
                                       │
   LLM (any provider / mock) ──────────┘
        │
        ▼  tool calls (MCP, 16 tools)        ┌───────────────────┐
   ┌─────────┐   reads (cases, orders, ...)  │   Policy engine    │
   │  Agent  │──────────────────────────────▶│  deterministic     │
   └────┬────┘                                │  evaluation (§4)   │
        │  writes = structured ActionProposal └─────────┬─────────┘
        ▼                                               │
   ┌───────────┐   auto_execute            ┌────────────▼────────────┐
   │ Proposal  │──────────────────────────▶│  Execute via adapter     │
   │  store    │   require_approval        │  (idempotency-keyed)     │
   └───────────┘──────────────┐            └────────────┬────────────┘
        │                     ▼                         │
        │              ┌─────────────┐                  ▼
        │              │ Human       │           ┌────────────┐    ┌──────────────┐
        │              │ approval /  │           │  Adapter   │───▶│ Backend      │
        │              │ handoff     │           │ (BYO/mock) │    │ (helpdesk /  │
        │              └─────────────┘           └─────┬──────┘    │  shop / SaaS)│
        ▼                                              │           └──────────────┘
   ┌──────────────────────────────────────────────────▼─────┐
   │  Audit trail: every proposal, decision, execution,      │
   │  handoff, model call → AuditEvent (queryable via API)   │
   └─────────────────────────────────────────────────────────┘
```

Models never hold backend credentials. All reads and writes flow through the
`SupportAdapter` interface with a `Principal` carrying an explicit permission; all writes
are structured `ActionProposal` objects that must pass deterministic policy evaluation
before anything executes.

## Quickstart

Requirements: Node >= 20 (Node 22 recommended), pnpm 11, Docker (optional).

### Local (pnpm)

```bash
pnpm install && pnpm build
pnpm dev:api        # API on http://localhost:3001 (SEED_DEMO demo data)
pnpm dev:web        # Console on http://localhost:5173 (proxies /v1 + /health to :3001)
```

Useful checks:

```bash
curl http://localhost:3001/health
pnpm typecheck      # strict TS across the workspace
pnpm test           # build + all unit tests
pnpm test:compat    # schema/compat suite → tests/compat/report/latest.json
```

### Docker

```bash
docker compose up --build    # or: pnpm docker:up
```

- Console: http://localhost:8080
- API: http://localhost:3001 (`GET /health` → `{ status: "ok", ... }`)

The Docker build context is the **repository root** (both Dockerfiles copy the pnpm
workspace); there is intentionally no `.dockerignore` so the workspace layout is preserved.

### Runtime configuration (Milestone 2)

All knobs are env vars — see [.env.example](.env.example) for the annotated template.

- **Auth** (`OSAS_AUTH_MODE`): `demo` (default; `x-osas-role` / `x-osas-actor-id` /
  `x-tenant-id` headers) or `jwt` (OIDC Bearer tokens verified via `OSAS_JWKS_URL` /
  `OSAS_JWT_ISSUER` / `OSAS_JWT_AUDIENCE`; tenant and roles come from verified claims,
  `x-tenant-id` is ignored). Demo mode **fails closed** under `NODE_ENV=production`.
  External principals can never hold `execute`; `system_executor` is internal-only.
- **Storage** (`OSAS_STORAGE`): `memory` (default) or `postgres` (requires
  `DATABASE_URL`; fails closed when unreachable). PostgreSQL flow:

  ```bash
  docker compose --profile postgres up -d db migrate   # start db + apply migrations
  pnpm db:migrate && pnpm db:seed                       # or run from the host
  OSAS_STORAGE=postgres DATABASE_URL=postgres://osas:osas@localhost:5432/osas pnpm dev:api
  # or everything in compose:
  OSAS_STORAGE=postgres docker compose --profile postgres up --build
  ```

  `pnpm db:reset` re-creates the schema (development only; refuses `NODE_ENV=production`).
- **LLM** (`OSAS_LLM_PROVIDER`): `mock` (default, deterministic, network-free) or
  `openai-compatible` (`OSAS_LLM_BASE_URL` / `OSAS_LLM_API_KEY` / `OSAS_LLM_MODEL_FAST` /
  `OSAS_LLM_MODEL_STANDARD`). classify/extract route to the fast model, reply/propose to
  the standard model. Without `OSAS_LLM_INPUT_USD_PER_MTOKEN` +
  `OSAS_LLM_OUTPUT_USD_PER_MTOKEN` costs are recorded as *unknown* (never fabricated).
  `OSAS_LLM_DAILY_BUDGET_USD` / `OSAS_LLM_CASE_BUDGET_USD`: 80% writes a
  `budget_warning` audit event; at the cap, model calls are blocked before the provider
  is touched. Usage is queryable via `GET /v1/usage` (policy_admin/auditor only).

### Runtime configuration (Milestone 3)

- **Execution mode** (`OSAS_EXECUTION_MODE`): `shadow` (default) is the only
  supported mode — proposals are simulated, ShadowRuns record what would have
  been auto-executed, and humans write final outcomes. `live` **refuses to
  start** (`LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1`); live execution requires a
  future RFC.
- **Reference adapters** (fail closed when unconfigured; never required by the
  demo): Zendesk (`ZENDESK_BASE_URL`/`ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`,
  `ZENDESK_API_TOKEN`, `ZENDESK_ESCALATION_GROUP_ID`) and read-only Shopify
  (`SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, optional
  `SHOPIFY_API_VERSION`). See
  [docs/zendesk-shopify-shadow.md](docs/zendesk-shopify-shadow.md).

## The three demo paths

Open the console (http://localhost:5173 or http://localhost:8080) and pick a persona:

1. **Developer** (`/developer`) — browse the 16 MCP tool definitions (`/v1/meta/tools`),
   explore JSON Schemas (`/v1/schemas`), and validate arbitrary payloads against any schema
   in the playground (`POST /v1/validate`).
2. **Support agent** (`/agent`) — work the approval queue (`/v1/approvals?status=pending`,
   approve/reject with comment) and claim/resolve human handoffs (`/v1/handoffs`).
3. **Platform operator** (`/platform`) — inspect the audit trail (`/v1/audit`, filter by
   case/proposal) and view the machine-readable compat report (`/v1/compat/report`).

The `/demo` page runs three one-click scripted scenarios end-to-end via `/v1/chat`:

1. **Ecommerce refund (auto)** — verified customer, $25 refund under the $50 auto threshold,
   fresh evidence → `auto_execute` → executed, with a full audit trail.
2. **SaaS credit (approval)** — `credit_apply` over the auto threshold → `pending_approval`
   → appears in the `/agent` queue → once approved, executes automatically.
3. **Handoff (blocked)** — unverified identity or an injected message ("ignore all previous
   instructions…") → proposal blocked + `HumanHandoff` visible in `/agent`.

## Unified execution flow

Every agent action follows the same pipeline:

```
Read trusted business data ─▶ Generate structured proposal ─▶ Policy evaluation
      (via adapter tools)         (ActionProposal + evidence)      (deterministic)
                                                                       │
                          ┌──────────────────────┬─────────────────────┘
                          ▼                      ▼
                    Auto-execute          Human approval ─▶ then execute
                          │                      │
                          └──────────┬───────────┘
                                     ▼
                       Write back result (idempotent)
                                     ▼
               Audit trail / exception reconciliation
        (every step emits AuditEvents; uncertain outcomes →
         reconciliation_required, never blind retries)
```

## Permission ladder

| Permission | Meaning | Who may hold it |
|---|---|---|
| `read` | Read cases, customers, orders, knowledge, etc. | model, human, system |
| `draft` | Create notes, escalations, and proposals | model, human, system |
| `request-approval` | Submit proposals that require approval before execution | model (cap), human, system |
| `execute` | Execute an approved/auto-approved proposal against the backend | policy engine / API backend only |

Model principals are **capped at `request-approval`**. A model proposal requesting
`execute` is a policy violation (`PERMISSION_OVERREACH`): it is `policy_rejected`, a
handoff is opened, and a `permission_overreach_blocked` audit event is emitted. Only the
policy engine / API backend may move a proposal to `executing`.

## Repository layout

```
schemas/                 Authoritative JSON Schemas (draft 2020-12) + manifest.json
packages/
  core/                  @osas/core             types, enums, state machines, detectInjection
  schema-validator/      @osas/schema-validator Ajv loader/validator over schemas/
  policy-engine/         @osas/policy-engine    TenantPolicy evaluation, permission ladder, execution
  model-gateway/         @osas/model-gateway    provider interface, MockModelProvider, routing, budgets
  adapter/               @osas/adapter          SupportAdapter interface + BYO adapter template
  zendesk-adapter/       @osas/zendesk-adapter  Zendesk ticketing reference adapter (Milestone 3)
  shopify-adapter/       @osas/shopify-adapter  read-only Shopify reference adapter (Milestone 3)
  ecommerce-shadow/      @osas/ecommerce-shadow Shadow Mode: ShadowRun, stores, execution mode
  mock-backend/          @osas/mock-backend     synthetic fixtures + MockSupportAdapter
  store-postgres/        @osas/store-postgres   PostgreSQL stores + SQL migrations (Milestone 2)
  mcp-server/            @osas/mcp-server       16 tool definitions + stdio MCP server
apps/
  api/                   @osas/api              Fastify 5 HTTP API (port 3001)
  web/                   @osas/web              React 18 + Vite console (port 5173)
tests/
  compat/                @osas/compat-suite     schema/compat suite + JSON report
  e2e/                   @osas/e2e              Playwright smoke (E2E=1)
docs/  rfcs/  .github/workflows/  docker-compose.yml
```

## Using the MCP server

`@osas/mcp-server` exposes all agent capabilities as 16 MCP tools over stdio. Example client
configuration (after `pnpm build`):

```json
{
  "mcpServers": {
    "osas": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"]
    }
  }
}
```

Tools:

| Profile | Tools |
|---|---|
| core | `osas_core_get_case`, `osas_core_search_cases`, `osas_core_get_customer`, `osas_core_search_knowledge`, `osas_core_create_case_note`, `osas_core_create_escalation`, `osas_core_create_action_proposal` |
| ecommerce | `osas_ecom_get_order`, `osas_ecom_list_orders`, `osas_ecom_get_shipment` |
| saas | `osas_saas_get_subscription`, `osas_saas_list_invoices`, `osas_saas_get_credit_balance`, `osas_saas_create_credit_request`, `osas_saas_create_cancellation_request`, `osas_saas_create_plan_change_request` |

Mutation tools only create `ActionProposal` objects (status `proposed`, permission
`request-approval`); they never execute. `executeAction` is **never** registered as a tool.

## Bring your own adapter

The reference backend is an in-memory mock. To connect real systems (helpdesk, commerce,
billing), implement the `SupportAdapter` interface from `@osas/adapter` — start from
`packages/adapter/templates/byo-adapter.template.ts`, which has TODOs for every method.
Adapters throw `AdapterNotFoundError` (→ API 404) / `AdapterPermissionError` (→ 403) and
receive a `ToolContext` with the tenant and calling principal on every call. See the
[adapter development guide](docs/adapter-guide.md); `@osas/zendesk-adapter` and
`@osas/shopify-adapter` are complete reference implementations.

## Documentation

- Specification: [docs/spec-v0.1.md](docs/spec-v0.1.md) · [中文规范](docs/spec-v0.1.zh-CN.md)
- Adapter development guide: [docs/adapter-guide.md](docs/adapter-guide.md) · [中文](docs/adapter-guide.zh-CN.md)
- Zendesk + Shopify Shadow Mode: [docs/zendesk-shopify-shadow.md](docs/zendesk-shopify-shadow.md) · [中文](docs/zendesk-shopify-shadow.zh-CN.md)
- Engineering contracts: [CONTRACTS.md](CONTRACTS.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh-CN.md)
- Governance: [GOVERNANCE.md](GOVERNANCE.md)
- Security policy: [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- RFCs: [rfcs/](rfcs/) (start with [0001-v0.1-core](rfcs/0001-v0.1-core.md))
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## Status & roadmap

OSAS v0.1 is a **Draft**. The path to v1.0:

- [ ] At least **3 independent implementations** (beyond this reference) pass the
      compat suite for a given profile.
- [ ] All normative documents available in English and Chinese, kept in lockstep.
- [ ] No unresolved RFCs blocking core semantics; governance broadened to multi-party
      (see [GOVERNANCE.md](GOVERNANCE.md)).

Until then, expect breaking changes between minor versions; see
[CHANGELOG.md](CHANGELOG.md) and [semver policy](GOVERNANCE.md#versioning).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
