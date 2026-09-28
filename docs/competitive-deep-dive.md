# Competitive Deep Dive: OSAS Measured Against the Field

[中文版](competitive-deep-dive.zh-CN.md)

> **Snapshot: 2026-09-28.** This is a research-and-audit document, not marketing.
> It supersedes the shallower [competitive landscape](competitive-landscape.md) on
> every point where the two disagree. Facts are labelled:
> **[V]** verified against a primary source during this pass,
> **[M]** vendor/self-reported marketing claim, **[U]** unverified or unreachable.
> Version, star counts and pricing move fast — re-verify before citing externally.
>
> **Status update (same day, post-audit):** the §6.2 spec-drift items shipped in
> the v0.2.1 maintenance release (tool table, capability counts, approval/timeout
> and transforms prose, `implementing-osas.md` counts, orphan-schema registration);
> the §6.3 gate/eval items are fixed (`gateOk` is now tooling-enforced and required
> by GOVERNANCE.md; the three vacuous v0.3 eval checks were replaced with
> behavioural assertions over the real execution path); the approval-binding gap
> is closed by RFC 0008 (`actionDigest`, threat T14). **Not** addressed by those
> changes: zero independent implementations, no live execution, no production
> deployments, the hand-maintained conformance matrix, and the missing v0.2 badge
> for the TypeScript reference.

## Why this document exists

The earlier landscape note asked "where does OSAS sit?" and answered with a
positioning table. That is the right question for a README and the wrong one for
a decision. Three things changed since, or were never checked:

1. **Microsoft AGT now ships a customer-support policy example.** The previous
   table's "support domain: None (horizontal)" row is no longer true. AGT is not
   merely an adjacent horizontal layer; it has landed inside OSAS's vertical.
2. **A hyperscaler productized OSAS's headline demo.** AWS AgentCore Policy's own
   published example is "issue refunds up to $100 but bring a human in the loop
   for anything larger" — that is the $25-refund / $120-credit demo, in a keynote.
3. **The claim "conformance is a gate, not a claim" does not currently survive an
   audit of this repository.** The gate machinery has holes this document names.

So this is a two-sided exercise: an outside-in map of the field, and an
inside-out audit of what OSAS's differentiation actually rests on today.

## 1. Baseline: what OSAS verifiably is

Stated plainly so every later comparison has a floor to stand on. All **[V]**
from this repository, 2026-09-28.

| Dimension | Verified state |
|---|---|
| Spec version | v0.2 Draft; v0.3 Draft for `ecommerce-controlled-execution` |
| Implementations in the registry | **2, both from the same repository URL, both `independent: false`** |
| Adopters | **0** — `ADOPTERS.md` says so deliberately |
| Production deployments | **0 known** |
| v1.0 gate (`>=3 independent implementations`) | **0 of 3** |
| Git tags / releases | **0 tags, 35 commits** |
| Live execution | **Refused at startup.** No OSAS implementation has ever written to a real commerce provider |
| Publishable packages | 3 of 15 (`@osas/core`, `@osas/schema-validator`, `@osas/policy-engine`); the other 12 are `private: true` |
| Reference posture | Demo-grade, self-disclosed: in-memory stores, header-based demo auth, no WORM sink |
| White-box compat suite | 345 cases, **TypeScript-only** (imports workspace packages) |
| Black-box runner | 22 checks (v0.2) + 7 (v0.3), HTTP-only — the only third-party-applicable gate |

That is an honest, early-stage open specification. Nothing below should be read
as a criticism of being early. It matters because **every competitive claim has to
be discounted by the evidence behind it**, and OSAS's evidence base is currently
one organization wide.

## 2. The map: seven layers, not three

The previous doc modelled three layers (protocol / product / framework). Seven is
more useful, because it exposes which layer each real threat arrives from.

**L1 — Transport protocol.** MCP, A2A, AGNTCY, IBM ACP.
*Status:* MCP was donated to the **Agentic AI Foundation**, a directed fund under
the Linux Foundation (co-founded by Anthropic, Block, OpenAI; supported by Google,
Microsoft, AWS, Cloudflare, Bloomberg), with goose and AGENTS.md as founding peers;
97M+ monthly SDK downloads, ~10,000 servers **[V]**. The 2026-07-28 revision made
the protocol **stateless** (no `initialize` handshake, no `Mcp-Session-Id`) and
replaced server-initiated sampling/elicitation with **MRTR**
(`resultType: "input_required"`, `inputRequests`/`inputResponses`) **[V]**. A2A
reached v1.0 (2026-03-12) under a TSC with Google, Microsoft, Cisco, AWS,
Salesforce, ServiceNow, SAP and IBM — and a grep for policy/approval/audit across
its spec and ADRs returns **zero matches** **[V]**. IBM ACP is **archived** **[V]**.
**Verdict: OSAS's RFC 0002 instinct is right — ride here, do not compete.**

**L2 — Action governance runtime.** Microsoft AGT, Cerbos, OPA/Rego, Cedar,
OpenFGA/Permify.
**This is where OSAS's real competition is**, and it is not empty.

**L3 — Human-in-the-loop / workflow.** LangGraph `interrupt()`, OpenAI Agents SDK
guardrails, Microsoft Agent Framework ADR-0006, Dify `human_input`, n8n
`requireApproval`, Mastra.
*Status:* universally **control-flow, not governance artifact** — no verdict
vocabulary, no approval object model, no audit chain, no idempotency contract
**[V]**. LangGraph's own docs delegate idempotency to the developer ("side effects
before `interrupt()` should (ideally) be idempotent") **[V]**.

**L4 — Agent identity & lifecycle.** Microsoft Entra Agent ID + **Agent 365**
("enterprise control plane for managing and governing AI agents at scale"), AWS
Bedrock AgentCore Identity, SPIFFE/SPIRE, AGNTCY identity-spec (Agent Badges as
verifiable credentials).
*Status:* complementary. Microsoft is making a serious land-grab here, including
governing third-party agents (Bedrock, n8n) **[V]**.

**L5 — Product: support agents.** Split into three camps by *how* they enforce
(see §4.5). Nobody here publishes tamper-evidence or an independent verification
path **[V]**.

**L6 — Commerce / commitment.** AP2 (donated to the **FIDO Alliance** at v0.2),
x402 (now a foundation), ACP (OpenAI + Stripe).
*Status:* AP2 has already modelled signed, typed, non-repudiable intent and
**chained mandates that form a verifiable audit trail** **[V]**. This is the
closest existing analogue to OSAS's `ActionProposal` + audit chain, and OSAS's own
commerce interop doc does not mention it.

**L7 — Scorecards and regulation.** OWASP Top 10 for Agentic Applications 2026
(ASI01–ASI10), AARM (Cloud Security Alliance: Core R1–R6 MUST, Extended R1–R9),
ISO/IEC 42001, AIUC-1, EU AI Act.
*Status:* **This is the layer OSAS's conformance registry ambitions actually
compete in, and where OSAS is least present.** AGT already advertises "AARM
Extended" conformance and self-scores against ASI01–ASI10 at 7 Full / 3 Partial
**[V]**. The EU AI Act's remaining provisions began applying **2026-08-02** **[V]**;
support agents are not Annex III high-risk by category, so the binding hooks for
this market are **Art. 12 record-keeping** and **Art. 14 human oversight**, plus
procurement pressure.

## 3. Head-to-head: the four that matter

### 3.1 Microsoft AGT — the direct competitor, not the neighbor

Verified this pass **[V]**: `microsoft/agent-governance-toolkit`, MIT, created
**2026-03-02**, **6,350 stars**, 159 contributors, 2,749 commits, 5 SDKs (Python,
TypeScript, .NET, Rust, Go), **10 specs** including the Agent Control Specification,
**33 ADRs**, and ~**605 conformance test functions**. Version 5.0.0; latest public
release v4.1.0 (2026-06-09) — a ~3-month release gap. Status: **Public Preview,
"may have breaking changes before GA."**

**Where AGT is ahead of OSAS.**

- **Action-bound approvals.** ADR-0030 is the most sophisticated approval protocol
  in the open: an `ActionBinding` over `{agent_id, subject_id, operation,
  target{tool_name, tool_schema_version, resource}, parameters}`; an
  `action_digest` = SHA-256 over **RFC 8785 JCS**; an append-only
  `ApprovalChainEntry` linked by `previous_entry_digest`; and **seven atomic
  re-validation checks at execution time**. Its own words: *"individual allow votes
  are not execution tokens."* Default on expiry or transport failure is deny. It
  explicitly **rejects LLM-as-approver**. **OSAS's RFC 0006 admits OSAS approvals
  are not action-bound.** This is the single clearest capability gap.
- **IFC** — caveated, see below — but at least specified; OSAS's RFC 0005 is a
  non-normative placeholder with no schema and no code.
- **Ecosystem.** Five language SDKs vs OSAS's one usable implementation language.
- **Conformance volume.** ~605 test functions vs OSAS's 345 + 22.

**Where OSAS is genuinely ahead — and this is the important part.**

AGT **writes down that it does not do the thing OSAS is built around.** In its own
security model: *"ACS does not replace backend authorization, tenant isolation,
identity verification, audit retention, payment controls, **idempotency, or
compensating transaction controls**."* **[V]** Its saga orchestrator is
reverse-order compensation only; there are **no idempotency keys and no
reconciliation** in it **[V]**.

That is not a small concession. It means the property OSAS treats as
non-negotiable — `(tenantId, idempotencyKey)` replay with no side effects, and
`uncertain` outcomes routed to reconciliation and **never blind-retried** — has
**no counterpart in the most complete open governance stack in existence**, and
that stack has formally disclaimed ownership of it. This is OSAS's strongest,
most defensible position, and it should be the lead claim in every external
conversation.

Two more AGT caveats worth knowing, because they soften its apparent lead:

- **Its IFC is weaker than its marketing implies.** AGT's own security model:
  *"ACS supports information flow control as stateless policy logic. The core
  performs no built in IFC check and stores no taint state."* And it concedes
  *"ACS cannot observe or block a path that the host does not mediate."*
- **Its audit chain has the same class of limit OSAS's does.** ADR-0017 admits no
  protection against a complete chain replacement; external anchoring is specified
  only as an *optional* Commitment Engine. Both projects offer tamper-evidence,
  not tamper-proofing. Parity, not deficit.

**And the one fact that changes OSAS's positioning most:**
`policy-engine/examples/support_agent/` **exists** **[V]** — a support policy with
refund denial on `refund_risk == fraudulent`, escalation on `high_value`,
warn-on-external-email, prompt-injection denial on input, and PII denial at
`post_tool_call`/`output`, with tools carrying `clearance` and `security_labels`.
**AGT has landed in the vertical.** OSAS can no longer claim the support domain is
untouched by horizontal governance stacks. What AGT still does *not* have is the
support **lifecycle**: cases and their state machine, evidence objects, approval
queues, handoffs, after-sales objects (shipment incidents, claims, exchanges),
tenant policy as a versioned immutable artifact, and the write-safety contract.
The defensible claim is **lifecycle + write safety**, not "no one else does support."

### 3.2 AWS AgentCore Policy — the pitch, shipped as a keynote

Announced at re:Invent (2025-12-02) **[V]**: **Policy in AgentCore** lets customers
define agent boundaries in natural language; those boundaries *"integrate with
AgentCore Gateway … to automatically check each agent's action and stop those that
violate written controls."* The AWS VP's own illustration: an agent *"can
automatically issue refunds up to $100 but must bring a human in the loop for
anything larger."* Alongside it: **AgentCore Evaluations** with 13 pre-built
evaluation systems.

Read that against OSAS's README demo table — a $25 refund auto-executes, a $120
credit stops for human approval. **A hyperscaler shipped OSAS's demo, in a keynote,
with a natural-language policy authoring surface and gateway-level interception.**

What AWS still does not publish: a verdict vocabulary, an action-proposal object,
an approval-resolution model, an audit chain, an idempotency/reconciliation
contract, or a support domain model. It is a boundary setter, not a write-safety
contract. But it sets buyer expectations for the *authoring experience*, and OSAS's
plain-JSON `TenantPolicy` is not obviously better than a sentence.

Also worth noting as market context: AWS's own site states **"88% of agent pilots
stall"** **[M]**. That is the demand signal for exactly what OSAS claims to provide.

### 3.3 Cerbos — the pure-decision competitor nobody in the repo is watching

Cerbos (open-core, v0.55.0, ~4,600 stars) has repositioned from application
authorization to *"authorizing every identity and governing every action across
applications, gateways, workloads, **and AI agents**"* **[V]**, with a content stack
for AI security, MCP server authorization, AI-gateway authorization, agentic
commerce, multi-hop delegation and policy-driven MCP tool gating. It claims
ALLOW/DENY before the action executes, logs every decision with the **policy
version**, and evaluates the agent *and the delegating human together*, making the
human's permissions the ceiling **[V]**.

**Cerbos owns the phrase "agent authorization" in the market, and it is not in
OSAS's competitive document at all.** What it lacks: any approval or suspension
semantics, an approval-object model, tamper-evidence, an idempotency contract, and
domain content. It is the strongest competitor for L2 mindshare with adopters who
already run OPA-style authorization.

Adjacent evidence that L2 is consolidating: **Oso is deprecated**, **Permify is now
part of FusionAuth**, **Invariant Labs was acquired by Snyk**, **Lakera is part of
Check Point**, **Prompt Security is part of SentinelOne** **[V]**. The independent
agent-governance vendor layer is being absorbed — which is simultaneously an
opportunity (the neutral spec position is vacated) and a warning (the acquirers
have distribution).

### 3.4 AP2 / FIDO — the spec that already solved signed intent

AP2 (Google-originated, 3,196 stars) reached **v0.2.0 on 2026-04-28 and was donated
to the FIDO Alliance** **[V]**. It defines **Verifiable Digital Credentials** and
**Checkout/Payment Mandates** with open (constraints) and closed (authorized)
stages, where **mandates are chained to provide a complete verifiable audit
trail** and give *"deterministic, non-repudiable proof of intent."*

This is structurally the nearest thing in any standard to OSAS's
`ActionProposal` — a typed, signed, chainable intent record — and it is now under
a real standards body with payment-network gravity. **OSAS's RFC 0006 and its
commerce interop doc both pass over AP2 entirely.** Whether OSAS borrows AP2's
mandate chaining and states the relationship, or gets read as having reinvented a
worse version of it, is a live choice.

### 3.5 The support-SaaS camp — reframed by enforcement mechanism

The previous doc treated "Sierra/Fin/Agentforce/Zendesk" as one opaque blob. The
useful cut is **how each enforces**, because that is the axis OSAS competes on.

**Camp 1 — prompt-based (the majority).** Instructions and blocklists inside the
agent prompt. Sierra ("Goals and guardrails" in Horizon), Decagon (AOPs as
natural-language SOPs with Git-based versioning), Fin ("Procedures"), Gorgias,
Freshworks. Parloa publicly dismantles this approach: prompts *"are just
requests"* and keyword blocklists *"miss anything phrased outside of the norm"*
**[M]**. **This camp is where OSAS's "the model is capped at `request-approval`"
argument lands hardest** — and it is a large camp.

**Camp 2 — infrastructure-enforced (Parloa, AWS).** Parloa's LLM Guardrails
(2026-07-28) run *"below the conversation, below the prompt, and independent of
agent prompt logic"* in three layers, including a **guard LLM that reads the full
conversation history on every turn** **[M]**. AWS enforces at the Gateway. **This
camp is the credible threat to OSAS's differentiator,** because it delivers
deterministic-ish enforcement inside a supported product, with reported numbers
(Parloa: 95.3% of safe callers passed without friction across 1,803 real
conversations **[M]**).

**Camp 3 — inherited-enterprise-permission (Salesforce, Microsoft, Zendesk).**
Agent actions execute under a real user identity and therefore inherit existing
RBAC, profiles, permission sets and sharing rules **[V]**. Weaker on agent-specific
decision semantics, materially stronger on *who did what* auditability — and it
requires no new policy artifact from the customer. This is the stiffest
competition for OSAS's audit story, because buyers already trust it.

**Three category facts that shape OSAS's window:**

- **Pricing has converged on outcomes**, which is exactly the pressure that makes
  weak governance expensive: Fin **from $0.99 per outcome** + $19/seat, Agentforce
  **$2 per conversation** (and ~$0.30 per service case at 60 credits), Gorgias
  **$1.50 per AI interaction** **[V]**. When an agent is paid per resolution, an
  unbounded agent is a liability with a meter on it.
- **Nobody offers tamper-evidence or independent verification** **[V]**. Decagon
  alone claims "tamper-protected" logs with no published mechanism **[M]**. And
  buyers are voting with money: **Coralogix raised $200M** and **InsightFinder $15M**
  to watch agents from outside **[V]**. Third-party verification of agent decisions
  is a funded, unmet demand — **this is the market gap OSAS's audit chain was built
  for, and OSAS has no product to sell into it.**
- **No public attributable incident of a wrong write-action by any of these vendors
  was found in this pass** **[V]**. Treat as a real finding, with the caveat that
  such incidents most likely settle privately. It means OSAS cannot yet sell fear;
  it has to sell procurement readiness.

**Consolidation is the strategic backdrop:** **Salesforce agreed to acquire Fin
(ex-Intercom) for ~$3.6B on 2026-06-15** (closing early 2027), and **Zendesk
acquired Forethought** (announced 2026-03-11) **[V]**. Two of the three most
credible independent agent vendors were absorbed within four months, while the
long tail re-valued upward (Parloa $3B, Decagon $4.5B, Sierra >$15B, Wonderful $5B)
**[V]**. **Standardizing on an independent vendor is now a demonstrably risky bet
— which is the argument for a neutral spec, if anyone is making it.**

## 4. Dimension matrix

### 4.1 The governance stack, axis by axis

| Axis | OSAS | Microsoft AGT | AWS AgentCore Policy | Cerbos | Support SaaS (best of) |
|---|---|---|---|---|---|
| Model can execute writes | **Never** — capped at `request-approval`; `executeAction` is not a tool | No by default | No — Gateway stops violating actions | No — ALLOW/DENY pre-execution | Yes (Fin refunds; Gorgias refunds/cancels/address edits) |
| Declarative policy artifact | **Yes** — versioned immutable `TenantPolicy`, JSON | Yes — Rego/OPA (+Cedar lib) | Natural language | Yes — Cerbos policies | No — prompt text / UI settings |
| Verdict vocabulary | `auto_execute` / `require_approval` / `block`, worst-of, default deny | `allow`/`warn`/`deny`/`escalate`/`transform` → canonical `allow`/`deny`/`require_approval` | Not published | ALLOW / DENY | Opaque |
| Fail-closed | Yes — `NO_RULE` → block; engine error → block | Yes — ADR-0013, `runtime_error:*` | Yes (stops violating actions) | Yes | Vendor-defined |
| Approval semantics | Suspend + **deny-only** expiry; **not action-bound** (self-admitted) | Suspend + expiry deny/allow/suspend; **action-bound via SHA-256/JCS digest + append-only chain + 7 execution re-checks** | Human-in-the-loop threshold | **None** | UI approvals (Zendesk Suite Enterprise) |
| Write idempotency / reconciliation | **Normative core**: `(tenantId, idempotencyKey)` replay, `uncertain` → reconciliation, never blind retry | **Explicitly disclaimed.** Sagas are rollback-only; no idempotency keys | Not published | None | Vendor-defined, unverifiable |
| Tamper-evident audit | Per-tenant SHA-256 chain + `/v1/audit/verify` | SHA-256 Merkle chain + `verify_chain()`, inclusion proofs; whole-chain replacement unprotected | Not published | Decision logs (not a chain) | Logs only; Decagon claims "tamper-protected" **[M]** |
| Tenant isolation | `ToolContext` tenant scoping, 403 `TENANT_MISMATCH` | Host-supplied; ACS disclaims tenant isolation | AWS IAM/regions | Yes | Yes |
| Support domain model | Cases, evidence, approvals, handoffs, orders, refunds, claims, exchanges, 20 tools | **A `support_agent` example policy now exists** — but no lifecycle | None | None | Yes, proprietary |
| Third-party conformance | Black-box HTTP runner + public registry — **but 0 independent entries, and the runner's author is the spec's author** | ~605 self-run test functions; no third-party registry | None | None | None |
| Standards alignment | MCP profile (RFC 0002); **silent on AP2, AARM, OWASP ASI, ISO 42001** | AARM Extended; maps OWASP ASI01–ASI10 | MCP/Bedrock ecosystem | MCP authorization content | Trust centers (ISO 42001, FedRAMP, CSA STAR AI L2) |
| Authoring tax | Plain JSON — lowest | Rego/OPA on PATH — highest | Natural language — lowest | Cerbos policy language | UI — lowest |

### 4.2 Evidence and ecosystem reality

| Axis | OSAS | Microsoft AGT | Cerbos | Support SaaS |
|---|---|---|---|---|
| Independent implementations | **0** | n/a (single vendor) | n/a | n/a |
| Named adopters | **0** | Unstated | Commercial customer base | Hundreds to thousands |
| Production deployments | **0 known** | Unknown (Public Preview) | Yes | Yes, at scale |
| Live write capability | **Refused by design** | Yes, in customer deployments | Yes (authorization only) | Yes |
| Backing | Founding maintainers | Microsoft | Cerbos (VC-backed) | $3B–$15B+ valuations |
| License / stewardship | Apache-2.0, one org | MIT, Microsoft-led | Apache-2.0 open-core | Proprietary |
| Published unit economics | n/a | n/a | n/a | $0.99–$2 per resolution **[V]** |

## 5. Where OSAS is genuinely differentiated — and how durable

**1. The write-safety contract. Durable, and the strongest asset.**
Idempotency keyed on `(tenantId, idempotencyKey)`, replay with no side effects,
`uncertain` → reconciliation task, and **no blind retries** — with the same
semantics specified for provider events (dedup on `(tenantId, provider,
providerEventId)`, resolution only on a matching idempotency key). AGT **disclaims
this in writing**. Cerbos has none. LangGraph delegates it to the developer. No
support SaaS exposes it verifiably.
*Durability:* high, because it is a semantic contract rather than a feature, and
because it is the one thing a governance layer must own to be safe with money.
*Risk:* AGT or AWS could ship it in a quarter. **Speed matters more here than
anywhere else.**

**2. Support lifecycle as a versioned, portable contract. Narrowing.**
Cases with a state machine, evidence objects, an approval queue, handoffs,
after-sales objects, a 20-tool surface, multi-tenant `TenantPolicy` with an
immutable lifecycle (`draft → simulated → approved → active → retired`).
*Durability:* medium and **declining** — AGT's `support_agent` example means the
"nobody else does support" claim is dead. What survives is *lifecycle*, which is a
real distinction but a less quotable one.

**3. Conformance where the examiner is not the vendor. Strongest idea, weakest
execution.** The structural insight — a black-box runner plus a public registry,
closer to W3C/TC39 than to a framework README — is the most interesting thing in
the repo. But it is currently one organization examining itself: 0 independent
entries, and the runner's author is the spec's author.
*Durability:* high **if** it gets a single genuinely independent implementation.
Otherwise it is unproven and easily dismissed.

**4. No DSL adoption tax.** Plain JSON policy vs Rego-on-PATH. Real, but small —
and it cuts against OSAS, because Rego is a hiring pool and OSAS's JSON is a
bespoke dialect that must be learned anyway.

**5. Careful, disciplined honesty in the normative text.** Marking RFCs as
non-normative drafts, disclosing the demo-grade posture, disclosing the same-org
independence failure, declining to claim UCP/ACP conformance, refusing to start in
live mode rather than pretending. This is genuinely better than most vendor
security documentation and it is an asset with exactly the audience OSAS wants
(platform and governance engineers). **It should be protected aggressively — which
is why §6 matters.**

## 6. Where OSAS is exposed

Grouped by the kind of damage each can do.

### 6.1 Evidence gap (existential for a standard)

- **0 of 3 on its own v1.0 gate.** Both registered implementations share one
  repository URL and are `independent: false`. The gate that
  [GOVERNANCE.md](../GOVERNANCE.md) defines is the moat; the moat is empty.
- **The independence gate is currently satisfiable only by luck.** The Python
  implementation lives in the reference repo, so by construction it can never
  count. Publishing it separately is a file move, not a project — but that move
  has not happened.
- **Live execution is refused, so no OSAS implementation has ever written to a
  real provider.** Every execution claim rests on the synthetic sandbox provider.
  A skeptic can dismiss the entire execution story as untested against reality.
- **No live third-party integration is exercised anywhere in CI.** Zendesk,
  Shopify and Chatwoot adapters are tested against mock HTTP only. Worse, the
  Zendesk adapter structurally cannot pass an identity-requiring auto-execute rule:
  it always sets `Customer.region` to the `"ZZ"` placeholder and identity to
  `unverified`.
- **Adapter idempotency is an in-process `Map`, lost on restart** (self-disclosed).
  So the reference adapters do not actually hold the property the spec makes
  normative, across a crash.
- **12 of 15 packages are `private: true`.** The reference stack is not consumable
  as a library surface by anyone but a repo checkout.

### 6.2 Specification-integrity defects (cheap to fix, expensive to leave)

These matter disproportionately, because **the entire pitch is rigor.** A spec
whose normative text miscounts its own surface is a spec a platform reviewer will
not trust with money.

- **`docs/spec-v0.2.md:387` says "20 MCP tools"; the §7 table beneath it lists 16.**
  The other 4 arrive 500 lines later in §15.6. The normative table is a v0.1
  leftover.
- **Capability counts disagree three ways:** §12.1 says "the 16 spec-defined
  capabilities", §15.6 says 20, and `CAPABILITIES` in code has 20.
- **`docs/implementing-osas.md` — the onboarding guide for the very independent
  implementers the v1.0 gate depends on — has wrong schema counts** (core "14
  entries" vs 15 actual; ecommerce "2" vs 6 actual). Someone scoping work from it
  will under-scope.
- **Two load-bearing mechanisms exist only in schema, never in prose:**
  `TenantPolicy.approval.timeoutSeconds` (the semantics behind threat **T13**, one
  of the 13 headline threats) and `PolicyRule.transforms` /
  `PolicyDecision.transforms`. "The schema wins" is a legitimate authority rule,
  but a spec whose approval-timeout semantics live only in a JSON file is a weak
  normative document.
- **`PolicyDecision` in §5 has no `transforms` field** although `evaluateProposal`
  returns one; and the `NEVER_AUTO_EXECUTE` reason code is absent from the
  reference implementation's `POLICY_REASON_CODES`.
- **Two schemas (`after-sales-case.json`, `after-sales-decision.json`) are in no
  manifest** — registered nowhere, reachable only by an inner manifest and the eval
  script.
- The roadmap already lists "v0.2.1 maintenance release with no
  documentation/schema/version drift" as **not done**. That is the accurate status.
  **Fixing this section is the highest return-on-effort work available to this
  project**, because it costs days and it is the difference between "draft with
  drift" and "draft you can implement from."

### 6.3 Gate and eval defects (damage the differentiator specifically)

The conformance and eval machinery is OSAS's stated moat. These are the holes.

- **The runner can report `ok: true` with the stateful suite skipped.**
  `packages/compat-runner/src/runner.ts:70` computes `ok: totals.failed === 0`, so
  skipped checks do not fail a run — while GOVERNANCE.md requires the stateful
  suite for a compatibility claim. **The gate is enforced by policy, not by
  tooling.** Fix: separate `ok` (ran clean) from `gateOk` (ran complete), and
  require the latter for registry entry.
- **The v0.3 controlled-execution eval has no behavioral tests at all.** Of its six
  checks in `evals/src/controlled-execution-eval.ts`, **three are non-tests**:
  `exchangeHumanOnly` is literally `check(true, …)` (:121); `providerEventsDeduplicated`
  tests whether a `Set` of two *identical* template strings has size 1 (:117–120) —
  a JavaScript tautology, not an implementation assertion; and
  `uncertainNeverAutoRetried` asserts properties of a **hardcoded literal object**
  (:116). Of the remaining three, two merely count dataset entries; only
  `executionSchemasValid` validates anything. **Zero of six exercise the v0.3
  runtime.** The real behavioral proof lives in the black-box runner's
  controlled-execution suite — the eval artifact is not that.
  Fix: delete these three and assert against actual runner output.
- **Eval "accuracy" cannot fail informatively.** The harness imports only
  `evaluateProposal` and `validate` — no model, no adapter, no network, `costUsd: 0`
  — and compares the dataset's expected decision to the same author's engine. It
  measures internal consistency, and it cannot detect a shared misreading of the
  spec. This is worth stating plainly in the README rather than letting 120/120
  read as validation.
- **After-sales coverage is 20% by the harness's own bookkeeping.** From the
  committed case data in `evals/cases/after-sales-top10.json`: **`supported` 20,
  `shadow_only` 45, `proposal_only` 20, `missing_adapter` 5,
  `missing_domain_object` 5, `unsupported` 5.** The README's flagship first
  scenario, the `$25 damaged-item refund`, is `shadow_only` **10 of 10** — its
  decision is auto-execute, but there is no execution path in the eval. To the
  harness's credit this is honest, machine-readable bookkeeping; to OSAS's cost it
  means "100 after-sales cases" is not 100 executable cases.
- **The 345-case white-box suite is TypeScript-only** and by its own documentation
  cannot validate any other implementation. So third-party verification rests on
  **22 HTTP checks**, in which the policy matrix is only three simulated outcomes
  (small verified refund → auto_execute, over-threshold → require_approval,
  unverified identity → block). **A 15-reason-code algorithm is defended by 11
  white-box cases and 3 black-box assertions.** The most important safety property,
  idempotency/reconciliation, has 4 white-box cases and 1 runner check.
- **`conformance/matrix.md` is hand-maintained with no renderer** and says so: "if
  the numbers disagree with a fresh run, the run wins."
- A minor but telling one: **the TypeScript reference has no v0.2 badge** in
  `conformance/badges/`, although `matrix.md` asserts it passes the v0.2 suites.

### 6.4 Positioning risks

- **AGT has entered the vertical** (see §3.1). Any material still asserting
  "AGT: support domain — None" is now wrong and should be corrected.
- **The MCP Interceptors Working Group is the standards body most likely to absorb
  this space.** It is chartered to define a first-class MCP primitive with two
  types — `validators` (inspect and return pass/fail) and `mutators` (transform
  payloads) — spanning tool calls, resource reads, prompt gets, sampling,
  elicitation *and* non-MCP operations, in-process/sidecar/remote, with
  priority-ordered chains and "audit mode semantics." Leads include Bloomberg,
  Saxo Bank and Nordstrom **[V]**. If MCP ships validator/mutator interception
  with pass/fail only, there is no verdict hierarchy, no escalation, no approval
  object and no chain — but it becomes the contract everyone implements. **OSAS
  should be in that room or explicitly mapped to it**; today it is neither.
  (Note also MCP's `idempotentHint` remains an advisory boolean with no key, no
  verification and no reconciliation — a citable vacuum OSAS can fill.)
- **The scorecard layer is being claimed by others.** AGT reports AARM Extended and
  OWASP ASI coverage; HubSpot and Zendesk publish EU AI Act, ISO 42001, CSA STAR AI
  Level 2. OSAS is silent on all of it. For buyers, "maps to AARM Core R1–R6 and
  ASI02/ASI03/ASI09" is cheap to write and disproportionately persuasive.
- **Category consolidation raises the attention bar.** Salesforce–Fin and
  Zendesk–Forethought mean fewer independent platforms, each with a governance story
  of its own, and a market trained to buy rather than standardize.
- **A cited-wholesale risk**: this document's predecessor compared OSAS to AGT in a
  table OSAS wrote, while conceding AGT's lead on action-bound approvals and IFC.
  That kind of table is read as advocacy. The corrected version — *AGT is ahead on
  X, we own Y, here is the primary source for both* — is far more persuasive to the
  audience that matters.

## 7. Recommendations, in order of return

1. **Do the v0.2.1 drift release now.** Fix the §7 tool table, the three capability
   counts, the schema counts in `implementing-osas.md`, promote `approval.timeoutSeconds`
   and `transforms` into normative prose, add the missing `transforms` field to
   `PolicyDecision`, register the two orphan schemas. Days of work; removes the
   cheapest available line of attack against the project's core claim.
2. **Make the runner enforce its own gate.** Split `ok` from `gateOk`; require the
   stateful suite for a registry entry. A gate that tooling does not enforce is a
   gate a third party will not believe.
3. **Delete the three vacuous v0.3 eval checks and replace them with runner-backed
   assertions.** A green CI badge that a reviewer can debunk in five minutes costs
   more than a missing badge.
4. **State the eval's limits in the README.** "Synthetic, offline, no model, no
   adapter, measures spec-vs-implementation agreement" is a credible sentence.
   120/120 accuracy invites the reader to over-read it.
5. **Ship action-bound approvals.** Adopt AGT's `enforced_identity` pattern — a
   digest over the canonical action input, re-verified at execution. OSAS's own RFC
   0006 flags the gap. It is the clearest single capability deficit, and it is
   directly borrowable.
6. **Get one independent implementation.** Everything hinges on this. The 22-check
   black-box contract is small enough to be someone's weekend, and the Python
   implementation is already written — publishing it as a separately maintained
   repo is the cheapest path to 1 of 3. Then target a Chatwoot/Captain or Zammad
   integration as the second. **Make "prove compatibility in an afternoon" the
   marketing message**, and recruit a non-founding-maintainer party to run the
   registry, since self-examination is the one weakness of the conformance idea.
7. **Adopt AGT's vocabulary instead of competing with it.** Publish the
   decision-vocabulary mapping (`auto_execute` ↔ `allow`; `require_approval` ↔
   `escalate`; `block` ↔ `deny`; `transform` ↔ param transforms) and make RFC 0006
   the interoperability story. Being the support profile that plugs into AGT/OPA is
   a defensible, achievable position; being a competing full-stack governance
   runtime against Microsoft is not.
8. **Map to the scorecards.** One page each: OWASP ASI01–ASI10 (claim ASI02, ASI03,
   ASI09 and show the tests), AARM Core R1–R6, EU AI Act Art. 12/14. Cheap
   legibility that compounds in procurement conversations.
9. **State the AP2 / FIDO relationship**, and borrow mandate chaining rather than
   reinventing typed intent. AP2 has the payment world's ear and FIDO has the
   standards process; OSAS's commerce interop doc currently ignores it.
10. **Write one real live write to a sandbox provider** — a Shopify dev store is
    sufficient — and publish the receipt plus the verified audit chain. The
    strongest possible answer to "has this ever actually executed anything?" is an
    artifact, not an argument.
11. **Narrow the external claim.** "Governed support agents — the model proposes,
    policy decides, adapters perform, the audit trail explains" is credible today.
    "Conformance registry, W3C-like process, industry standard" is not, at 0
    independent implementations. Lead with the write-safety contract, because it is
    the one property the most complete open governance stack in the world has
    formally disclaimed.

## 8. Verdict

**What OSAS is:** the most complete *written* contract for support-agent write
safety that exists, with one genuinely differentiated semantic axis — an
idempotency and reconciliation contract for financial writes that **Microsoft AGT
explicitly disclaims and no support SaaS exposes** — plus a support lifecycle model
and a conformance architecture whose central idea (the examiner is not the vendor)
is better than anything in the vertical.

**What OSAS is not:** an industry standard, an adopted specification, or a product.
It is 0 for 3 on its own independence gate, has never executed a real write, and
its normative text currently miscounts its own surface.

**The window is real but closing.** AGT is roughly seven months old, has 159
contributors, five SDKs, ~605 conformance tests, has entered the support vertical
with a reference policy — and has left exactly one door open: write idempotency and
reconciliation. If AGT or AWS closes that door before OSAS has an independent
implementation, OSAS's differentiated axis disappears and it becomes a
support-shaped wrapper around a problem someone else solved.

**The most probable good outcome** is not "industry standard." It is **the support
profile that governance runtimes consume**: OSAS owning the domain model, the
permission ladder and the write-safety contract, with AGT/OPA/AWS-style PDPs
supplying the horizontal policy runtime underneath — which is precisely what RFC
0006 already sketches. That position is real, defensible, and reachable. It is also
much smaller than the current framing, and pretending otherwise is the main
strategic risk the project runs.

## Sources

Verified during this pass (2026-09-28) unless noted. Prefer these primary sources
over this summary.

- Microsoft Agent Governance Toolkit — <https://github.com/microsoft/agent-governance-toolkit> (incl. `policy-engine/examples/support_agent/`, ADR-0013/0017/0030)
- AWS re:Invent AgentCore announcement — <https://techcrunch.com/2025/12/02/aws-announces-new-capabilities-for-its-ai-agent-builder/>
- Salesforce acquires Fin — <https://techcrunch.com/2026/06/15/salesforce-acquires-ai-customer-service-platform-fin-for-3-6b/>
- Zendesk acquires Forethought — <https://techcrunch.com/2026/03/11/zendesk-acquires-agentic-customer-service-startup-forethought/>
- Parloa $3B Series D — <https://techcrunch.com/2026/01/15/parloa-triples-its-valuation-in-8-months-to-3b-with-350m-raise/>
- Sierra $950M raise — <https://techcrunch.com/2026/05/04/sierra-raises-950m-as-the-race-to-own-enterprise-ai-gets-serious/>
- Decagon $4.5B tender — <https://techcrunch.com/2026/03/04/decagon-completes-first-tender-offer-at-4-5b-valuation/>
- Coralogix $200M (agent observability) — <https://techcrunch.com/2026/06/03/coralogix-raises-200m-in-race-to-build-the-monitoring-layer-for-ai-agents/>
- MCP specification and governance — <https://modelcontextprotocol.io/>, <https://github.com/modelcontextprotocol/modelcontextprotocol>
- A2A — <https://a2a-protocol.org/>, <https://github.com/a2aproject/A2A>
- AP2 (FIDO Alliance) — <https://github.com/google-agentic-commerce/AP2>
- x402 — <https://github.com/x402-foundation/x402>
- Cerbos AI agent authorization — <https://cerbos.dev/>
- OWASP Agentic Security Initiative — <https://genai.owasp.org/initiatives/agentic-security-initiative/>
- AARM (Cloud Security Alliance) — <https://aarm.dev/>
- EU AI Act implementation timeline — <https://artificialintelligenceact.eu/implementation-timeline/>
- Fin / Zendesk / Gorgias / Salesforce pricing — the vendors' own pricing pages
- Vendor trust centers: Zendesk, Maven AGI, HubSpot, Pylon, Observe.AI