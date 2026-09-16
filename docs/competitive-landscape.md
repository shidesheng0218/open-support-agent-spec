# Competitive Landscape: Where OSAS Sits

[中文版](competitive-landscape.zh-CN.md)

> Information in this document reflects a web research snapshot taken
> **2026-09**. The agent-governance space moves quickly; verify claims against
> the primary sources listed at the end before citing them externally.

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
- **IBM ACP and Cisco AGNTCY** — both initiatives have stalled or been archived
  and absorbed into the A2A effort, a reminder that protocol-layer competition
  consolidates fast.

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
- **Microsoft Agent Governance Toolkit + Agent Hooks (2026)** — the closest
  conceptual neighbor: a framework-neutral governance contract, approval
  timeouts that fail safe, transform hooks that can rewrite a verdict, and
  OWASP-agentic-threat alignment. Horizontal (any domain), and Microsoft-backed.
- **Invariant Labs rule engine** — deterministic runtime checks over agent
  traces; guards behavior but does not define a customer-support domain model,
  permission ladder, or audit-hash semantics.

## Positioning table

| Capability | OSAS | Microsoft AGT | MCP | LangGraph | Support SaaS (Sierra/Fin/Agentforce/Zendesk) |
|---|---|---|---|---|---|
| Model can directly execute writes | **Never** — hard-capped at `request-approval` | Configurable; hooks enforce | No decision layer | Yes, unless coded otherwise | Opaque, vendor-defined |
| Deterministic policy engine | **Yes** — declarative TenantPolicy, worst-of decision, default deny | Yes — rules + transforms | No | No (app code) | Black box |
| Audit semantics | **SHA-256 hash chain**, per-tenant, tamper-evident | Logs/traces | None | App-defined | Vendor logs, not verifiable |
| Shadow mode (simulate before enable) | **Yes** — default posture | Partial (observability) | No | Manual | No |
| Vendor-neutral / portable | **Yes** — open spec + schemas | Framework-neutral but Microsoft-led | Yes (LF AAIF) | Yes (OSS) | No |
| Conformance registry | **Yes** — `conformance/implementations.json`, black-box gate | No | Loose (SDK compat) | No | No |
| Customer-support domain model | **Yes** — helpdesk adapters, 20-tool domain, multi-tenant TenantPolicy | No | No | No | Yes (proprietary) |

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
- **Microsoft gravity.** AGT ships with Azure/GitHub distribution and OWASP
  alignment. OSAS cannot out-spend it; it must out-spec it in the support
  domain and stay genuinely vendor-neutral.
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
