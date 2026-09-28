# Competitive Landscape: Where OSAS Sits

[中文版](competitive-landscape.zh-CN.md)

> Information in this document reflects a web research snapshot taken
> **2026-09**. The agent-governance space moves quickly; verify claims against
> the primary sources listed at the end before citing them externally.
>
> **This document is the positioning-level overview.** For the axis-by-axis
> comparison — with an audit of this repository, and facts graded by evidence
> strength — see the [competitive deep dive](competitive-deep-dive.md). Where the
> two disagree, the deep dive wins.

OSAS (Open Support Agent Spec) is a **governance-first open specification** for
customer-support agents: the model proposes, the deterministic policy engine
decides, the adapter executes, and the audit log explains. This document maps
the surrounding landscape — who builds what, where OSAS is differentiated, and
where the risks are.

## The three layers of the market

### 1. Protocol layer — how agents talk, not how they are governed

- **MCP (Model Context Protocol)** — donated to the Linux Foundation; the
  2026-07-28 revision introduces MRTR (Multi-Round-Trip Requests, replacing
  elicitation/sampling) and explicit server statelessness. MCP standardizes
  *capability discovery and tool invocation* between a model and tools. It
  deliberately does **not** define an execution-decision layer: nothing in MCP
  decides whether a refund may be auto-executed, requires approval, or must be
  blocked. OSAS is complementary — it can ride on top of MCP as a governance
  profile (see [RFC 0002](../rfcs/0002-osas-as-mcp-governance-profile.md)).
- **A2A (Agent2Agent) v1.0** — governs *agent ↔ agent* messaging and task
  delegation. Adjacent to OSAS: A2A agents that touch customer data still need
  a governance and audit layer underneath.
- **IBM ACP and Cisco AGNTCY** — these two have diverged, which is the point:
  **IBM ACP is archived** (`i-am-bee/acp`, last push 2025-08), while **AGNTCY is
  actively shipping**, focused on agent identity and verifiable credentials
  (`identity-spec`, still receiving commits in 2026-09). Protocol-layer
  competition consolidates fast, but the layer itself keeps fragmenting.

### 2. Product layer — capable but opaque

- **Sierra, Intercom Fin, Salesforce Agentforce, Zendesk AI** — production-grade
  support agents with approval flows and audit logs, but the governance model is
  a **black box**: policies are vendor-defined, decisions are not portable, and
  there is no conformance surface a customer can verify independently. Switching
  vendors means re-building the governance layer from scratch.

### 3. Tool/framework layer — governance primitives without a domain contract

- **LangGraph** — interrupt/approval primitives: an agent graph can pause for
  human approval. Powerful, but the *policy* (what may auto-execute) is
  application code, not a declarative, auditable, tenant-scoped contract.
- **OpenAI Agents SDK** — guardrails/hooks around agent runs; input/output
  validation, not a full decision-and-audit lifecycle.
- **Microsoft Agent Governance Toolkit (AGT)** — the closest conceptual
  neighbor, and as of September 2026 the most complete horizontal governance
  stack in the open: MIT-licensed, 5 language SDKs, 10 specs and 33 ADRs,
  ~605 conformance test functions (counted across six spec-conformance files;
  earlier totals under a different counting basis were reported as ~992), and a
  deterministic fail-closed policy runtime whose verdicts (`allow` / `deny` /
  `transform` / `escalate`) include a liftable deny carrying an approval. It
  ships an approval fail-safe (timeout + `on_timeout`), **action-bound approvals**
  (ADR-0030: SHA-256 digest over RFC 8785 JCS canonical input, an append-only
  approval chain, and seven re-validation checks at execution time),
  information-flow control (source labels → sink clearances), a Merkle-chained
  audit log, and a shadow mode. Horizontal (any domain), Microsoft-backed, and
  application-middleware by design. **Note that it has entered the support
  vertical: `policy-engine/examples/support_agent/` ships a support policy.**
  See the [deep dive](competitive-deep-dive.md).
- **Invariant Labs rule engine** — deterministic runtime checks over agent
  traces; guards behavior but does not define a customer-support domain model,
  permission ladder, or audit-hash semantics.

## Positioning table

| Capability | OSAS | Microsoft AGT | MCP | LangGraph | Support SaaS (Sierra/Fin/Agentforce/Zendesk) |
|---|---|---|---|---|---|
| Model can directly execute writes | **Never** — hard-capped at `request-approval` | No by default — the policy runtime gates every call | No decision layer | Yes, unless coded otherwise | Opaque, vendor-defined |
| Deterministic policy engine | **Yes** — declarative TenantPolicy, worst-of decision, default deny | Yes — deterministic fail-closed runtime (verdicts `allow`/`deny`/`transform`/`escalate`) | No | No (app code) | Black box |
| Audit semantics | **SHA-256 hash chain**, per-tenant, tamper-evident | Merkle-chained audit log + decision BOM | None | App-defined | Vendor logs, not verifiable |
| Shadow mode (simulate before enable) | **Yes** — default posture | Yes | No | Manual | No |
| Idempotency / reconciliation semantics | **Yes** — `(tenantId, idempotencyKey)` replay, uncertain → reconciliation, no blind retries | **No** | No | No | Vendor-defined |
| Vendor-neutral / portable | **Yes** — open spec + schemas | Framework-neutral but Microsoft-led | Yes (LF Projects, LLC) | Yes (OSS) | No |
| Conformance registry | **Yes** — `conformance/implementations.json`, black-box gate | ~605 self-run test functions; no third-party registry | Loose (SDK compat) | No | No |
| Customer-support domain model | **Yes** — helpdesk adapters, 20-tool domain, multi-tenant TenantPolicy | **Ships a `support_agent` example policy; no lifecycle model** | No | No | Yes (proprietary) |

## Deep dive: Microsoft AGT — the closest neighbor, measured

Verified 2026-09-14 against the public repository and documentation. AGT's
Agent Control Specification is a stateless, deterministic, fail-closed policy
decision runtime; a denied action is structurally impossible to execute inside
its runtime. It is the only project we know of that checks nearly every OSAS
governance box.

| Axis | AGT | OSAS |
|---|---|---|
| Decision vocabulary | `allow` / `deny` / `transform` / `escalate` (escalate = a liftable deny carrying an approval) | `auto_execute` / `require_approval` / `block` |
| Approval fail-safe | `timeout_seconds` + `on_timeout: deny \| allow \| suspend`; approvals are **action-bound** (`enforced_identity` = SHA-256 of the canonical action input, re-verified before execution) | `timeoutSeconds` + `onTimeout: "deny"` **only** (deny-only is deliberate); expiry closes the proposal so no stale-approval dead end; action-binding is a candidate hardening (see RFC 0006) |
| Information flow control | Source labels → sink clearances, no-write-down, Rego/Cedar implementations | Design note only (RFC 0005) |
| Audit | Merkle-chained log + Decision BOM | Per-tenant SHA-256 hash chain + `GET /v1/audit/verify` |
| Idempotency / reconciliation | **None — and formally disclaimed.** Its security model lists what ACS does not replace: "…**idempotency, or compensating transaction controls**." Its sagas are reverse-order compensation only, with no idempotency keys and no reconciliation | Core semantics: `(tenantId, idempotencyKey)` replay, `uncertain` → reconciliation task, never auto-retry |
| Support domain | **A `support_agent` example policy now ships** (`policy-engine/examples/support_agent/`): refund denied on fraud risk, escalated when high-value, external-email warning, PII denial. No ticket state machine, SLA, or refund-ledger reconciliation | Cases, orders, refunds, claims, exchanges, evidence, approvals, handoffs — plus reference helpdesk adapters |
| Conformance | ~605 self-run test functions | Third-party black-box runner + public registry — the examiner is not the vendor, **though today the registry holds 0 independent entries** |
| License / stewardship | MIT, Microsoft-led | Apache-2.0, founding maintainers; multi-party seats at v1.0 (RFC 0004) |

**Read:** AGT is a domain-general governance layer further along on
identity-bound approvals and IFC — and, as of this revision, one that has begun
to reach into the support vertical with an example policy. OSAS is a
domain-complete contract whose idempotency/reconciliation semantics **AGT has
formally disclaimed** ("ACS does not replace … idempotency, or compensating
transaction controls"). The two still compose rather than collide: RFC 0006
defines an external policy-decision-point seam under which an AGT (or OPA)
runtime can *tighten* — never loosen — an OSAS decision, and AGT's `transform`
verdict maps onto OSAS's param transforms. **The honest summary is that AGT is
ahead on breadth and momentum, OSAS is ahead on one semantic axis that matters
for money, and OSAS's other claimed advantages are currently assertions rather
than evidence** — see the [deep dive](competitive-deep-dive.md) for the audit
behind that sentence.

## OSAS differentiation

1. **Customer-support vertical.** Helpdesk adapters (Zendesk, Shopify,
   Chatwoot), a 20-tool domain model, and a multi-tenant `TenantPolicy` are part
   of the spec — not something every adopter re-derives.
2. **Hard permission guarantees.** The `read < draft < request-approval <
   execute` ladder is normative; model actors can never hold `execute`. In most
   frameworks this is a convention; in OSAS it is a conformance case.
3. **Tamper-evident audit.** A per-tenant SHA-256 hash chain with a verification
   endpoint, not an append-only log you must trust.
4. **Conformance as a gate.** Compatibility claims run through a black-box
   runner plus a stateful conformance suite and land in a public registry —
   closer to a W3C/TC39 process than to a framework README.

## Risks

- **Upstream absorption.** If MCP/AAIF grows an execution-decision layer, OSAS
  could be squeezed into a niche. Mitigation: position OSAS as the governance
  *profile* for agent protocols (RFC 0002) rather than a competing protocol.
- **Microsoft gravity.** AGT is real and maturing fast (created 2026-03; 6,350
  stars, 159 contributors and five SDKs about seven months later): it already
  ships approval fail-safe timeouts, **action-bound approvals**, IFC, and a
  Merkle audit chain — and it has now entered this vertical with a support
  example policy. OSAS cannot out-spend it; it must out-*lifecycle* it (ticket
  state, after-sales objects, refund-ledger reconciliation) and own the
  **write-safety semantics** AGT has formally disclaimed, stay genuinely
  vendor-neutral, and — per RFC 0006 — treat AGT as a pluggable policy decision
  point, so adopting AGT strengthens rather than replaces OSAS. **The risk is
  one of timing: if AGT or AWS closes the write idempotency/reconciliation gap
  first, OSAS's differentiating axis disappears.**
- **Ecosystem scale.** Two implementations (one reference, one in-repo
  candidate) versus hundreds of MCP servers. The v1.0 gate of ≥3 independent
  implementations is also the moat — see below.

## How to become an OSAS independent implementation

1. Read the [third-party implementer guide](implementing-osas.md) for the
   minimal surface per profile (core, ecommerce, saas, controlled execution).
2. Implement against the authoritative JSON Schemas under
   [`schemas/`](../schemas/) — the schema wins over prose.
3. Run the white-box compat suite (`pnpm test:compat`) and the black-box
   runner (`pnpm osas:compat -- --target <url>`), including the stateful
   conformance suite.
4. Open a **Compatibility claim / registry entry** issue per the
   [conformance registration flow](../conformance/README.md#registration-flow),
   with a live target or CI evidence and the runner report.
5. On verification, a maintainer PR adds your row to
   `conformance/implementations.json` and a badge under `conformance/badges/`.

Independent implementations count toward the **v1.0 gate of ≥3 independent
implementations** — and earn a governance seat at v1.0 (see
[GOVERNANCE.md](../GOVERNANCE.md)).

## Sources (accessed 2026-09)

- Microsoft Agent Governance Toolkit — <https://microsoft.github.io/agent-governance-toolkit/>
- MCP specification announcements, incl. the 2026-07-28 revision (tool
  annotations, MRTR) — <https://modelcontextprotocol.io/>
- A2A (Agent2Agent) — <https://a2a-protocol.org/>
- Intercom Fin — <https://fin.ai/learn>
- Agentic web landscape notes — <https://agenticweb.wiki/>
- OWASP Agentic AI threats — <https://genai.owasp.org/>
