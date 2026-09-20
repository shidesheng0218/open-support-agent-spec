<div align="center">
  <img src="docs/assets/osas-hero.svg" alt="OSAS: governed AI agents for customer support" width="100%" />

  <h1>AI agents for customer support that know their limits.</h1>

  <p><strong>OSAS</strong> is an open contract for governed support agents:
  the model proposes, the policy engine decides, the adapters perform,
  and the audit trail explains.</p>

  <p>
    <a href="README.zh-CN.md">中文文档</a> ·
    <a href="#sixty-seconds">Try it locally</a> ·
    <a href="docs/spec-v0.2.md">Read the spec</a> ·
    <a href="CONTRIBUTING.md">Contribute</a>
  </p>

  <p>
    <a href="https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml"><img src="https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2563EB?style=flat-square" alt="Apache 2.0 license" /></a>
    <a href="docs/spec-v0.2.md"><img src="https://img.shields.io/badge/spec-v0.2%20Draft-F59E0B?style=flat-square" alt="v0.2 Draft" /></a>
    <img src="https://img.shields.io/badge/Node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20 or newer" />
  </p>
</div>

<br />

| 20 MCP tools | 3 profiles | 220 synthetic eval cases | 345 compat + 51 black-box checks |
|---|---|---|---|
| Core, ecommerce, SaaS | Schema-driven contracts | Offline, CI-gated | HTTP black-box conformance |

> **Status: v0.2 Draft.** An open specification under active development, not a
> claimed industry standard. Interfaces may change before v1.0 — see
> [Roadmap](#roadmap).

## The one idea

A capable model is not a safe operator. OSAS separates reasoning from
authority: model output becomes a typed `ActionProposal`, every proposal
passes a deterministic policy gate, and only the server side can execute.

| The hard problem | The OSAS answer |
|---|---|
| A model can suggest an unsafe write | Models are capped at `request-approval`. They never receive `execute`. |
| Every helpdesk has a different API | One stable, tenant-aware `SupportAdapter` interface. |
| "It probably worked" is not an audit trail | Every proposal, decision, model call, and write becomes a hash-chained `AuditEvent`. |
| Live rollout is risky | Shadow mode is the default. Nothing executes until a human writes the outcome. |

## Sixty seconds

```bash
git clone https://github.com/shidesheng0218/open-support-agent-spec.git
cd open-support-agent-spec
docker compose up --build
```

Then open the console at [localhost:8080](http://localhost:8080) and run the
three guided scenarios on `/demo`:

| Scenario | Policy result | What it proves |
|---|---|---|
| $25 damaged-item refund | `auto_execute` | A bounded action with fresh evidence just executes. |
| $120 service credit | `pending_approval` | Higher-risk actions stop at a human gate. |
| Injected instruction | blocked + handoff | The unsafe path is refused, visibly. |

No Docker? `pnpm install && pnpm build && pnpm dev:api && pnpm dev:web`, then
open [localhost:5173](http://localhost:5173).

## How it works

Every agent action follows the same pipeline:

```mermaid
flowchart LR
    A[Read trusted data<br/>via adapter tools] --> B[ActionProposal<br/>with evidence]
    B --> C{Deterministic<br/>policy evaluation}
    C -->|auto_execute| D[Execution boundary]
    C -->|pending_approval| H[Human approval]
    C -->|blocked| X[Human handoff]
    H --> D
    D --> W[Idempotent write-back]
    W --> E[AuditEvent trail]
    X --> E
```

The boundary is the design: **the model proposes, policy decides, adapters
perform, and the audit trail explains.** Models never hold backend
credentials; every adapter call carries a tenant and a principal; uncertain
outcomes enter reconciliation and are never blindly retried.

### The permission ladder

| Permission | Meaning | Who may hold it |
|---|---|---|
| `read` | Read cases, customers, orders, knowledge | model, human, system |
| `draft` | Create notes, escalations, proposals | model, human, system |
| `request-approval` | Submit proposals for review before execution | model (the cap), human, system |
| `execute` | Execute an approved proposal against the backend | policy engine / API backend only |

A model proposal requesting `execute` is a policy violation
(`PERMISSION_OVERREACH`): rejected, handed off, audited.

### Trust is engineered, not promised

- **Conformance is a gate, not a claim** — a black-box runner
  (`pnpm osas:compat -- --target <url>`) scores any implementation over HTTP;
  results land in a public [registry](conformance/implementations.json).
- **Evaluations are offline and CI-hard-gated** — 220 synthetic cases with
  hard gates: 100% schema validity, 100% policy consistency, zero overreach,
  zero duplicate executions, zero security-boundary bypass.
- **Every threat has a test** — the [threat model](docs/threat-model.md) maps
  thirteen attack classes to the exact test that proves the defense.

## Deep dive

<details>
<summary><strong>Runtime configuration</strong> — auth, storage, LLM, execution mode, conformance mode</summary>

<br />
All knobs are env vars — see [.env.example](.env.example) for the annotated
template. Everything fails closed.

- **Auth** (`OSAS_AUTH_MODE`): `demo` (default; `x-osas-role` /
  `x-osas-actor-id` / `x-tenant-id` headers) or `jwt` (OIDC Bearer via
  `OSAS_JWKS_URL` / `OSAS_JWT_ISSUER` / `OSAS_JWT_AUDIENCE`). Demo mode refuses
  to start under `NODE_ENV=production`. External principals can never hold
  `execute`.
- **Storage** (`OSAS_STORAGE`): `memory` (default) or `postgres`:

  ```bash
  docker compose --profile postgres up -d db migrate
  OSAS_STORAGE=postgres DATABASE_URL=postgres://osas:osas@localhost:5432/osas pnpm dev:api
  ```

- **LLM** (`OSAS_LLM_PROVIDER`): `mock` (default; deterministic, network-free)
  or `openai-compatible` (`OSAS_LLM_BASE_URL` / `OSAS_LLM_API_KEY` /
  `OSAS_LLM_MODEL_FAST` / `OSAS_LLM_MODEL_STANDARD`). Budget caps
  (`OSAS_LLM_DAILY_BUDGET_USD`, `OSAS_LLM_CASE_BUDGET_USD`) block provider calls
  before the network is touched; unpriced usage is recorded as *unknown*, never
  fabricated.
- **Execution mode** (`OSAS_EXECUTION_MODE`): `shadow` (default) simulates;
  `proposal_only` only drafts; `sandbox` runs the deterministic execution and
  reconciliation path against the synthetic provider. `live` refuses to start
  (see [Controlled Execution](docs/controlled-execution.md)).
- **Conformance mode** (`OSAS_CONFORMANCE_MODE` + `OSAS_CONFORMANCE_KEY`):
  test-only endpoints for the stateful suite. Never in production — startup
  fails closed. See [docs/conformance.md](docs/conformance.md).
- **Reference adapters** (fail closed when unconfigured; never required by the
  demo): Zendesk, read-only Shopify, Chatwoot — see
  [docs/zendesk-shopify-shadow.md](docs/zendesk-shopify-shadow.md) and
  [docs/chatwoot-adapter.md](docs/chatwoot-adapter.md).

</details>

<details>
<summary><strong>The console</strong> — six personas, one overview</summary>

<br />

| Page | Persona | What it shows |
|---|---|---|
| `/demo` | Anyone | One-click scripted scenarios plus a free-form message driver over `/v1/chat` |
| `/developer` | Builder | The 20 MCP tools, JSON Schemas, and a live validator playground |
| `/agent` | Support agent | The approval queue and human handoffs |
| `/after-sales` | Operator | The Top-10 after-sales scenarios: intake, evidence, approvals, sandbox receipts, reconciliation |
| `/shadow` | Reviewer | Shadow-run review plus aggregated shadow metrics |
| `/platform` | Governance | The tamper-evident audit trail and the compat report |

</details>

<details>
<summary><strong>Repository layout</strong></summary>

<br />

```
schemas/                 Authoritative JSON Schemas (draft 2020-12) + manifests
  execution-v0.3/        Controlled Execution Draft schemas
packages/
  core/                  @osas/core             types, enums, state machines, detectInjection
  schema-validator/      @osas/schema-validator Ajv loader/validator over schemas/
  policy-engine/         @osas/policy-engine    evaluation, permission ladder, execution, audit chain
  model-gateway/         @osas/model-gateway    provider interface, routing, budgets, telemetry
  adapter/               @osas/adapter          SupportAdapter interface + BYO template
  zendesk-adapter/       @osas/zendesk-adapter  Zendesk ticketing reference adapter
  shopify-adapter/       @osas/shopify-adapter  read-only Shopify reference adapter
  chatwoot-adapter/      @osas/chatwoot-adapter Chatwoot reference adapter
  ecommerce-shadow/      @osas/ecommerce-shadow Shadow/Sandbox execution, receipts, reconciliation
  mock-backend/          @osas/mock-backend     synthetic fixtures + MockSupportAdapter
  store-postgres/        @osas/store-postgres   PostgreSQL stores + migrations
  mcp-server/            @osas/mcp-server       20 tool definitions + stdio MCP server
  compat-runner/         @osas/compat-runner    black-box HTTP conformance runner
apps/
  api/                   @osas/api              Fastify 5 HTTP API (port 3001)
  web/                   @osas/web              React 18 + Vite console (port 5173)
tests/
  compat/                @osas/compat-suite     white-box compat suite + JSON report
  e2e/                   @osas/e2e              Playwright smoke (E2E=1)
evals/                   @osas/evals            220 synthetic policy/after-sales cases
implementations/
  python-reference/      second implementation (passes the black-box suites)
conformance/             public implementation registry, badges, fixture authority
examples/                embed-policy-engine    minimal embedding of @osas/policy-engine
docs/  rfcs/  .github/workflows/  docker-compose.yml
```

</details>

<details>
<summary><strong>The MCP tool surface</strong> — 20 tools, and why execute is never one of them</summary>

<br />

`@osas/mcp-server` exposes all agent capabilities as 20 MCP tools over stdio:

| Profile | Tools |
|---|---|
| core | `osas_core_get_case`, `osas_core_search_cases`, `osas_core_get_customer`, `osas_core_search_knowledge`, `osas_core_create_case_note`, `osas_core_create_escalation`, `osas_core_create_action_proposal` |
| ecommerce | `osas_ecom_get_order`, `osas_ecom_list_orders`, `osas_ecom_get_shipment`, `osas_ecom_get_shipment_incident`, `osas_ecom_get_refund_status`, `osas_ecom_create_item_claim_request`, `osas_ecom_create_exchange_request` |
| saas | `osas_saas_get_subscription`, `osas_saas_list_invoices`, `osas_saas_get_credit_balance`, `osas_saas_create_credit_request`, `osas_saas_create_cancellation_request`, `osas_saas_create_plan_change_request` |

Mutation tools only create `ActionProposal` objects (status `proposed`,
permission `request-approval`). `executeAction` is **never** registered as a
tool — execution belongs to the policy engine and the API backend.

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

</details>

<details>
<summary><strong>Bring your own adapter</strong></summary>

<br />
The reference backend is an in-memory mock. To connect real systems, implement
the `SupportAdapter` interface from `@osas/adapter` — start from
`packages/adapter/templates/byo-adapter.template.ts`. Adapters receive a
`ToolContext` with the tenant and calling principal on every call and fail
closed. See the [adapter guide](docs/adapter-guide.md); the Zendesk, Shopify,
and Chatwoot adapters are complete references.

Only `@osas/core`, `@osas/schema-validator`, and `@osas/policy-engine` are
published to npm; the other packages are private reference implementations —
build them from a repo checkout. To adopt only the governance layer inside an
existing system, embed `@osas/policy-engine` directly — see the runnable
[examples/embed-policy-engine](examples/embed-policy-engine).

</details>

<details>
<summary><strong>Verification commands</strong></summary>

<br />

```bash
pnpm typecheck      # strict TS across the workspace
pnpm test           # build + all unit tests (incl. the 345-case compat suite)
pnpm test:compat    # white-box compat suite → tests/compat/report/latest.json
pnpm osas:compat -- --target http://localhost:3001   # black-box runner
pnpm eval:policy    # offline policy evaluation with hard gates
pnpm verify         # the full release gate (typecheck + tests + evals + docker + e2e)
```

</details>

## Roadmap

OSAS v0.2 remains a **Draft**, kept backward-compatible while v0.3 Controlled
Execution develops as a separate Draft profile. The path to v1.0:

- [x] v0.3 Controlled Execution Draft passes the Sandbox conformance suite.
- [x] A second implementation passes the black-box runner (v0.2 + v0.3) — the
      in-repo [Python reference](implementations/python-reference/), gated by CI
      (`python-compat`). It is same-organization, so it does not count toward
      the independence gate.
- [ ] v0.2.1 maintenance release with no documentation/schema/version drift.
- [ ] At least **3 independent implementations** pass the compat suite for a
      profile — [registration criteria](conformance/README.md).
- [ ] All normative documents in English and Chinese, kept in lockstep.
- [ ] No unresolved RFCs blocking core semantics; governance broadened to
      multi-party ([GOVERNANCE.md](GOVERNANCE.md), [RFC 0004](rfcs/0004-multi-party-governance.md)).

Ecosystem and hardening items on the same path:

- [ ] [RFC 0006](rfcs/0006-external-policy-decision-point.md) (external policy
      decision point, tightening-only) accepted, with an AGT/OPA-backed example.
- [ ] [RFC 0005](rfcs/0005-information-flow-control.md) (information flow
      control) promoted from design note, with a first implementation.
- [ ] AG-UI approval-UX integration validated against a live frontend
      ([guide](docs/ag-ui-integration.md)).
- [ ] Threat model maintained alongside the security requirements
      ([docs/threat-model.md](docs/threat-model.md)).
- [ ] RFC 0007 (live execution) drafted — blocked on provider authentication,
      explicit tenant opt-in, rollback/compensation, operational monitoring,
      and an independent Live Conformance Suite
      ([RFC 0003](rfcs/0003-controlled-execution-profile.md)).

Until v1.0, expect breaking changes between minor versions — see
[CHANGELOG.md](CHANGELOG.md) and the [versioning policy](GOVERNANCE.md#versioning).

## Documentation

- Specification: [docs/spec-v0.2.md](docs/spec-v0.2.md) · [中文规范](docs/spec-v0.2.zh-CN.md)
- Adapter guide: [docs/adapter-guide.md](docs/adapter-guide.md) · [中文](docs/adapter-guide.zh-CN.md)
- Zendesk + Shopify Shadow Mode: [docs/zendesk-shopify-shadow.md](docs/zendesk-shopify-shadow.md) · [中文](docs/zendesk-shopify-shadow.zh-CN.md)
- Chatwoot adapter: [docs/chatwoot-adapter.md](docs/chatwoot-adapter.md) · [中文](docs/chatwoot-adapter.zh-CN.md)
- Implementing OSAS (third-party guide): [docs/implementing-osas.md](docs/implementing-osas.md) · [中文](docs/implementing-osas.zh-CN.md)
- Conformance Mode: [docs/conformance.md](docs/conformance.md) · [中文](docs/conformance.zh-CN.md)
- Controlled Execution (v0.3 Draft): [docs/controlled-execution.md](docs/controlled-execution.md) · [中文](docs/controlled-execution.zh-CN.md)
- Commerce protocol post-purchase interop: [docs/commerce-protocol-interop.md](docs/commerce-protocol-interop.md) · [中文](docs/commerce-protocol-interop.zh-CN.md)
- v0.3 Conformance Profiles: [docs/conformance-v0.3.md](docs/conformance-v0.3.md) · [中文](docs/conformance-v0.3.zh-CN.md)
- Threat model: [docs/threat-model.md](docs/threat-model.md) · [中文](docs/threat-model.zh-CN.md)
- Competitive landscape: [docs/competitive-landscape.md](docs/competitive-landscape.md) · [中文](docs/competitive-landscape.zh-CN.md)
- Engineering contracts: [CONTRACTS.md](CONTRACTS.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh-CN.md)
- Governance: [GOVERNANCE.md](GOVERNANCE.md) · Security: [SECURITY.md](SECURITY.md) · Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- RFCs: [rfcs/](rfcs/) · Changelog: [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
