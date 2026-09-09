# Open Support Agent Spec (OSAS)

<div align="center">
  <img src="docs/assets/osas-hero.svg" alt="OSAS: governed AI agents for customer support" width="100%" />

  <p><strong>Governed, interoperable AI agents for customer-support operations.</strong><br />
  A schema-first contract for reading trusted data, proposing actions, enforcing policy,
  running safely in shadow mode, and explaining every outcome.</p>

  <p>
    <a href="README.zh-CN.md">中文文档</a> ·
    <a href="#quickstart">Try it locally</a> ·
    <a href="docs/spec-v0.2.md">Read the spec</a> ·
    <a href="CONTRIBUTING.md">Contribute</a>
  </p>
</div>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2563EB?style=flat-square" alt="Apache 2.0 license" /></a>
  <a href="docs/spec-v0.2.md"><img src="https://img.shields.io/badge/spec-v0.2%20Draft-F59E0B?style=flat-square" alt="v0.2 Draft" /></a>
  <a href="https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml"><img src="https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20 or newer" />
  <img src="https://img.shields.io/badge/pnpm-11-F69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm 11" />
</p>

> **Status: v0.2 Draft.** OSAS is an open specification under active development, not a claimed
> industry standard. Interfaces, schemas, and behaviors may change before v1.0; see
> [Status & roadmap](#status--roadmap).

## Why OSAS?

Production support agents need more than a capable model. They need a contract that separates
reasoning from authority, turns model output into typed proposals, and makes the safe path the
default path.

| The hard problem | The OSAS answer |
|---|---|
| A model can suggest an unsafe write | Models are capped at `request-approval`; they never receive `execute`. |
| Every helpdesk has a different API | `SupportAdapter` gives tools a stable, tenant-aware interface. |
| “It probably worked” is not an audit trail | Every proposal, decision, model call, handoff, and write becomes an `AuditEvent`. |
| Live rollout is risky and hard to reproduce | `shadow` mode is the default; conformance and policy gates are deterministic and offline-friendly. |

## At a glance

| 20 MCP tools | 3 profiles | 120 policy + 100 after-sales cases | 307 compatibility checks |
|---|---|---|---|
| Core, ecommerce, SaaS | Schema-driven contracts | Offline safety evals | HTTP black-box conformance |

The repository ships the normative spec, machine-checkable JSON Schemas, a TypeScript reference
implementation, a web console, reference adapters, a compatibility suite, and reproducible
policy evaluations.

## Architecture

```mermaid
flowchart LR
    M[LLM or Mock Provider] --> G[Model Gateway<br/>routing · budgets · injection detection]
    G --> T[MCP Tool Surface<br/>20 typed tools]
    T --> A[Support Adapter<br/>BYO · Mock · Zendesk · Shopify]
    A --> B[(Helpdesk / Commerce / SaaS)]
    G --> P[Deterministic Policy Engine]
    P -->|auto_execute| X[Shadow Run / Execution Boundary]
    P -->|pending_approval| H[Human Approval or Handoff]
    H --> X
    X --> A
    G -. every call .-> E[(AuditEvent Trail)]
    P -. every decision .-> E
    X -. every outcome .-> E

    classDef model fill:#312E81,stroke:#A78BFA,color:#fff
    classDef gate fill:#164E63,stroke:#67E8F9,color:#fff
    classDef adapter fill:#065F46,stroke:#6EE7B7,color:#fff
    classDef audit fill:#78350F,stroke:#FCD34D,color:#fff
    class M,G,T model
    class P,H,X gate
    class A,B adapter
    class E audit
```

Models never hold backend credentials. All reads and writes flow through the
`SupportAdapter` interface with a `Principal` carrying an explicit permission; all writes
are structured `ActionProposal` objects that must pass deterministic policy evaluation
before anything executes.

The important boundary is intentional: **the model proposes, policy decides, adapters perform,
and the audit trail explains**.

## Quickstart

Get from clone to a visible, policy-gated demo in about a minute. Requirements: Node >= 20
(Node 22 recommended), pnpm 11, and Docker for the one-command experience.

### Fastest path: Docker

```bash
git clone https://github.com/shidesheng0218/open-support-agent-spec.git
cd open-support-agent-spec
docker compose up --build
```

Then open:

| Surface | URL | What to look at |
|---|---|---|
| Web console | [`localhost:8080`](http://localhost:8080) | `/demo`, `/developer`, `/agent`, `/platform` |
| API health | [`localhost:3001/health`](http://localhost:3001/health) | service and spec status |
| Tool catalog | [`localhost:3001/v1/meta/tools`](http://localhost:3001/v1/meta/tools) | the 20 typed MCP tools |

<details>
<summary><strong>What the demo proves</strong></summary>

| Scenario | Policy result | Why it matters |
|---|---|---|
| $25 ecommerce refund | `auto_execute` | Fresh evidence and a tenant policy can permit a bounded action. |
| SaaS credit over threshold | `pending_approval` | Higher-risk actions stop at a human gate. |
| Unverified identity or prompt injection | `policy_rejected` + handoff | The unsafe path is blocked and made visible. |

</details>

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

### Runtime configuration (Controlled Execution, v0.3 Draft)

- **Execution mode** (`OSAS_EXECUTION_MODE`): `shadow` (default) simulates
  proposals without changing provider state; `proposal_only` only drafts;
  `sandbox` runs the complete deterministic execution, idempotency, audit, and
  reconciliation path against the synthetic Sandbox Adapter. `live` still
  **refuses to start** (`LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1`) and is not
  a production capability in this release.
- The model never receives `execute`. Only the system executor may trigger an
  execution attempt, and uncertain outcomes enter reconciliation instead of
  being retried automatically. See
  [Controlled Execution](docs/controlled-execution.md) and
  [RFC 0003](rfcs/0003-controlled-execution-profile.md).
- **Reference adapters** (fail closed when unconfigured; never required by the
  demo): Zendesk (`ZENDESK_BASE_URL`/`ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`,
  `ZENDESK_API_TOKEN`, `ZENDESK_ESCALATION_GROUP_ID`), read-only Shopify
  (`SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, optional
  `SHOPIFY_API_VERSION`), and Chatwoot (`CHATWOOT_BASE_URL`,
  `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_API_TOKEN`, optional
  `CHATWOOT_ESCALATION_TEAM_ID`). See
  [docs/zendesk-shopify-shadow.md](docs/zendesk-shopify-shadow.md) and
  [docs/chatwoot-adapter.md](docs/chatwoot-adapter.md).

### Runtime configuration (Milestone 4)

- **Conformance mode** (`OSAS_CONFORMANCE_MODE=true` + `OSAS_CONFORMANCE_KEY`):
  enables the test-only endpoints `POST /v1/conformance/reset`,
  `POST /v1/conformance/fixtures/load`, `GET /v1/conformance/snapshot` (each
  requires the `X-OSAS-Conformance-Key` header). **NEVER enable in
  production** — startup fails closed when `NODE_ENV=production`, and when the
  key is missing. CI enables it only for the throwaway Docker environment.
  See [docs/conformance.md](docs/conformance.md).

## Black-box compatibility & evaluation (Milestone 4)

OSAS treats safety as a release property, not a README promise:

```mermaid
flowchart TB
    C[Clean checkout] --> I[pnpm install --frozen-lockfile]
    I --> B[pnpm build]
    B --> T[pnpm test]
    T --> TC[pnpm typecheck]
    TC --> E[pnpm eval:policy]
    E --> K{All gates green?}
    K -->|yes| D[Docker conformance + Playwright E2E]
    K -->|no| S[Stop before integration]
    D --> R[Publish machine-readable reports]

    classDef good fill:#065F46,stroke:#6EE7B7,color:#fff
    classDef stop fill:#7F1D1D,stroke:#FCA5A5,color:#fff
    class B,T,TC,E,D,R good
    class S stop
```

- **`pnpm osas:compat -- --target http://localhost:3001`** — `@osas/compat-runner`,
  a black-box conformance runner that speaks only HTTP to the target: discovery
  (`/.well-known/osas`, specVersion, Capability Manifest), tool/schema
  validation, policy-simulation results, and — when a conformance key is
  configured (`OSAS_CONFORMANCE_MODE=true` + `OSAS_CONFORMANCE_KEY`, or
  `--conformance-key`) — the stateful suite (policy lifecycle state machine,
  idempotent execution, permission/tenant isolation, audit-chain integrity).
  Prints a machine-readable JSON report; exit code is non-zero on any failure.
- **`pnpm eval:policy`** — fully offline evaluation of the policy engine over
  the 120 synthetic cases in `evals/cases/` (30 refunds, 20 returns,
  15 reshipments, 15 cancellations, 20 general inquiries, 20 security
  boundaries). Hard gates (CI): 100% schema validity, 100% policy consistency,
  0 overreach, 0 duplicate executions, 0 security-boundary bypass.
- **`pnpm eval:model`** — end-to-end eval against a real provider; runs only
  when `OSAS_LLM_PROVIDER=openai-compatible` + base URL/models are explicitly
  set (never in CI, never with the default mock). The model's semantic accuracy
  is reported independently — automation gates are never based on whether the
  model "sounds human".
- **`pnpm eval:after-sales`** — evaluates 100 synthetic after-sales cases
  (10 variants for each Top-10 scenario), with coverage, handoff, security,
  duplicate, and fake-success gates.
- **`pnpm eval:controlled`** — validates the v0.3 Draft execution fixtures,
  uncertain-result non-retry behavior, Provider Event deduplication, and the
  separate `ecommerce-controlled-execution` report.

## The three demo paths

Open the console (http://localhost:5173 or http://localhost:8080) and pick a persona:

1. **Developer** (`/developer`) — browse the 20 MCP tool definitions (`/v1/meta/tools`),
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

```mermaid
flowchart LR
    A[Read trusted data<br/>via adapter tools] --> B[Generate ActionProposal<br/>with evidence]
    B --> C{Deterministic policy evaluation}
    C -->|auto_execute| D[Shadow Run / execute boundary]
    C -->|pending_approval| H[Human approval]
    C -->|blocked| X[Human handoff]
    H --> D
    D --> W[Idempotent write-back]
    W --> E[AuditEvent + reconciliation]
    X --> E

    classDef input fill:#312E81,stroke:#A78BFA,color:#fff
    classDef gate fill:#164E63,stroke:#67E8F9,color:#fff
    classDef outcome fill:#065F46,stroke:#6EE7B7,color:#fff
    classDef blocked fill:#7F1D1D,stroke:#FCA5A5,color:#fff
    class A,B input
    class C,H gate
    class D,W,E outcome
    class X blocked
```

Uncertain outcomes become `reconciliation_required`; the reference implementation never
blindly retries a write whose outcome is unknown.

## Safety boundaries at a glance

| Boundary | Default behavior |
|---|---|
| Model authority | `read` → `draft` → `request-approval`; never `execute` |
| Execution | v0.2 keeps `shadow`; v0.3 Draft adds `proposal_only` and deterministic `sandbox`; `live` refuses to start |
| Credentials | Backend secrets stay behind adapters, outside model context |
| Prompt injection | Detected, blocked, handed off, and audited |
| Cost controls | Daily and per-case budgets block provider calls at the cap |
| Conformance endpoints | Test-only, key-protected, and refused in production |

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
schemas/                 Authoritative JSON Schemas (draft 2020-12) + manifests
  execution-v0.3/        Controlled Execution Draft schemas
packages/
  core/                  @osas/core             types, enums, state machines, detectInjection
  schema-validator/      @osas/schema-validator Ajv loader/validator over schemas/
  policy-engine/         @osas/policy-engine    TenantPolicy evaluation, permission ladder, execution
  model-gateway/         @osas/model-gateway    provider interface, MockModelProvider, routing, budgets
  adapter/               @osas/adapter          SupportAdapter interface + BYO adapter template
  zendesk-adapter/       @osas/zendesk-adapter  Zendesk ticketing reference adapter (Milestone 3)
  shopify-adapter/       @osas/shopify-adapter  read-only Shopify reference adapter (Milestone 3)
  chatwoot-adapter/      @osas/chatwoot-adapter Chatwoot (open-source helpdesk) reference adapter
  ecommerce-shadow/      @osas/ecommerce-shadow Shadow/Sandbox execution, receipts, reconciliation
  mock-backend/          @osas/mock-backend     synthetic fixtures + MockSupportAdapter
  store-postgres/        @osas/store-postgres   PostgreSQL stores + SQL migrations (Milestone 2)
  mcp-server/            @osas/mcp-server       20 tool definitions + stdio MCP server
  compat-runner/         @osas/compat-runner    black-box HTTP conformance runner (v0.2 + v0.3 profiles)
apps/
  api/                   @osas/api              Fastify 5 HTTP API (port 3001)
  web/                   @osas/web              React 18 + Vite console (port 5173)
tests/
  compat/                @osas/compat-suite     schema/compat suite + JSON report
  e2e/                   @osas/e2e              Playwright smoke (E2E=1)
evals/                   @osas/evals            120 policy + 100 after-sales synthetic cases
implementations/
  python-reference/      HTTP reference candidate (Core + Ecommerce + Sandbox)
conformance/             public implementation registry and badges
examples/                embed-policy-engine    minimal standalone embedding of @osas/policy-engine
docs/  rfcs/  .github/workflows/  docker-compose.yml
```

## Using the MCP server

`@osas/mcp-server` exposes all agent capabilities as 20 MCP tools over stdio. Example client
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
[adapter development guide](docs/adapter-guide.md); `@osas/zendesk-adapter`,
`@osas/shopify-adapter`, and `@osas/chatwoot-adapter` are complete reference
implementations. Note on packaging: only `@osas/core`, `@osas/schema-validator`,
and `@osas/policy-engine` are published to npm; the adapters and all other
workspace packages are private reference implementations — they are not
npm-installable (e.g. `npm install @osas/chatwoot-adapter` does not work), so
build them from a repo checkout or copy them as a starting point. To adopt only
the governance layer inside an existing system,
embed `@osas/policy-engine` directly — see its
[package README](packages/policy-engine/README.md) and the runnable
[examples/embed-policy-engine](examples/embed-policy-engine).

## Documentation

- Specification: [docs/spec-v0.2.md](docs/spec-v0.2.md) · [中文规范](docs/spec-v0.2.zh-CN.md)
- Adapter development guide: [docs/adapter-guide.md](docs/adapter-guide.md) · [中文](docs/adapter-guide.zh-CN.md)
- Zendesk + Shopify Shadow Mode: [docs/zendesk-shopify-shadow.md](docs/zendesk-shopify-shadow.md) · [中文](docs/zendesk-shopify-shadow.zh-CN.md)
- Chatwoot adapter: [docs/chatwoot-adapter.md](docs/chatwoot-adapter.md) · [中文](docs/chatwoot-adapter.zh-CN.md)
- Implementing OSAS (third-party guide): [docs/implementing-osas.md](docs/implementing-osas.md) · [中文](docs/implementing-osas.zh-CN.md)
- Conformance Mode (test-only): [docs/conformance.md](docs/conformance.md) · [中文](docs/conformance.zh-CN.md)
- Controlled Execution (v0.3 Draft): [docs/controlled-execution.md](docs/controlled-execution.md) · [中文](docs/controlled-execution.zh-CN.md)
- v0.3 Conformance Profiles: [docs/conformance-v0.3.md](docs/conformance-v0.3.md) · [中文](docs/conformance-v0.3.zh-CN.md)
- Engineering contracts: [CONTRACTS.md](CONTRACTS.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh-CN.md)
- Governance: [GOVERNANCE.md](GOVERNANCE.md)
- Security policy: [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- RFCs: [rfcs/](rfcs/) (start with [0001-v0.1-core](rfcs/0001-v0.1-core.md); positioning: [0002-osas-as-mcp-governance-profile](rfcs/0002-osas-as-mcp-governance-profile.md); controlled execution: [0003-controlled-execution-profile](rfcs/0003-controlled-execution-profile.md))
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## Status & roadmap

OSAS v0.2 remains a **Draft** and is kept backward-compatible while v0.3
Controlled Execution is developed as a separate Draft profile. The path to v1.0:

- [ ] v0.2.1 maintenance release has no documentation/schema/version drift.
- [ ] v0.3 Controlled Execution Draft passes the Sandbox conformance suite.
- [ ] A Python implementation passes Core + Ecommerce conformance; at least
      three independent implementations pass before v1.0.
- [ ] At least **3 independent implementations** (beyond this reference) pass the
      compat suite for a given profile.
- [ ] All normative documents available in English and Chinese, kept in lockstep.
- [ ] No unresolved RFCs blocking core semantics; governance broadened to multi-party
      (see [GOVERNANCE.md](GOVERNANCE.md)).

Until then, expect breaking changes between minor versions; see
[CHANGELOG.md](CHANGELOG.md) and [semver policy](GOVERNANCE.md#versioning).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
