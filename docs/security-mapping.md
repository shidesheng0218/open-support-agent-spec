# Standards Mapping: OWASP Agentic ASI, AARM, EU AI Act

[中文版](security-mapping.zh-CN.md)

> Snapshot: 2026-09-28. This document maps OSAS's mechanisms onto external
> security taxonomies so platform and procurement reviewers can read OSAS in a
> vocabulary they already use. **It is not a conformity assessment, a
> certification, or a legal claim.** Where coverage is partial or absent, the
> table says so — a mapping that only lists strengths is advocacy, not a map.

## OWASP Top 10 for Agentic Applications (2026) ↔ OSAS threat model

The OSAS [threat model](threat-model.md) predates this mapping; the table reads
left-to-right from the OWASP Agentic Security Initiative's 2026 list to the OSAS
defense and the test that proves it.

| OWASP ASI | OSAS coverage | Mechanism and proof |
|---|---|---|
| ASI01 Agent Goal Hijack | **Covered** | T1: `detectInjection()` (EN+ZH patterns) → `PROMPT_INJECTION_SUSPECTED` block + handoff. Tests: `packages/core/src/injection.test.ts`, 20 eval security cases |
| ASI02 Tool Misuse and Exploitation | **Covered** | T2: permission ladder caps models at `request-approval`; `executeAction` is never an MCP tool; every mutation is a policy-gated `ActionProposal`. Tests: `evaluate.test.ts`, mcp-server tests, evals overreach gate |
| ASI03 Identity and Privilege Abuse | **Covered** | T5/T6: `ToolContext` tenant scoping (403 `TENANT_MISMATCH`), RBAC on the policy lifecycle, `system_executor` is server-internal only. Tests: `auth.test.ts`, runner stateful suite |
| ASI04 Agentic Supply Chain | **Partial** | T12: `additionalProperties: false` everywhere, validate-before-act, pinned tool surface. **Not covered:** SBOM/dependency provenance for the agent stack itself |
| ASI05 Unexpected Code Execution | **Covered (by absence)** | OSAS defines no code-execution tool surface; the model layer holds no credentials and never receives `execute`. Note: this says nothing about a host application's own tools outside OSAS |
| ASI06 Memory and Context Poisoning | **Partial** | Evidence freshness (`EVIDENCE_STALE`), injection screening of untrusted text, immutable policy versions (T7). **Not covered:** long-term memory stores — the reference has none |
| ASI07 Insecure Inter-Agent Communication | **Partial** | Provider events: adapters MUST verify upstream provenance and bind events to one tenant before ingestion (commerce interop doc); cross-tenant provider events cannot resolve another tenant's reconciliation. A2A-level signing is out of scope today |
| ASI08 Cascading Agent Failures | **Covered** | T3/T4/T10: idempotency on `(tenantId, idempotencyKey)`, no blind retries, `uncertain` → human reconciliation, pre-call budget caps |
| ASI09 Human-Agent Trust Exploitation | **Covered** | T13/T14: approval fail-safe expiry (deny-only), action-bound approvals (RFC 0008 — the approval authorizes an exact action input, re-verified at execution), human-only fulfillment for `exchange_request` |
| ASI10 Rogue Agents | **Covered** | T8: per-tenant SHA-256 audit chain + `GET /v1/audit/verify`; every model call is recorded with telemetry; budget caps bound runaway loops |

## AARM (Cloud Security Alliance) ↔ OSAS mechanisms

AARM Core (R1–R6, MUST-level) describes pre-execution interception through
identity binding; the Extended tier adds drift tracking, telemetry export, and
least-privilege enforcement. OSAS's corresponding mechanisms:

| AARM theme | OSAS mechanism |
|---|---|
| Pre-execution interception | Every mutation is an `ActionProposal` evaluated by the deterministic policy engine; `executeAction` is never exposed to the model |
| Deterministic decision before execution | Worst-of evaluation with default-deny; pure engine, fully auditable |
| Human oversight | `pending_approval` with deny-only expiry (T13); handoffs for every blocked class |
| Identity binding | `ToolContext = { tenantId, principal }` on every adapter call; RFC 0008 binds approvals to the canonical action input |
| Audit trail | Per-tenant SHA-256 hash chain with a public verify endpoint |

Exact per-requirement (R1…R6) citations are pending a careful read of the AARM
text; this table maps themes, not clause numbers, and will be tightened when
AARM publishes stable requirement text.

## EU AI Act — Articles 12 and 14

Customer-support agents are generally **not** Annex III high-risk systems, so
the AI Act does not impose a deadline on this domain by category. The two
articles that procurement teams ask about anyway, and what OSAS provides:

| Article | Obligation (paraphrase) | OSAS mechanism |
|---|---|---|
| Art. 12 (record-keeping) | Automatic recording of events over the system's lifecycle | Per-tenant append-only audit hash chain + `GET /v1/audit/verify`. Caveat: tamper-**evidence**, not tamper-proofing — production deployments must pair it with WORM storage (see the threat model's residual risks) |
| Art. 14 (human oversight) | The system can be overseen, interrupted, and overridden by humans | Permission ladder caps the model below `execute`; approval gates with fail-safe deny-only expiry; human handoffs for every blocked decision; shadow mode as the default rollout posture |

**Not a conformity claim.** Nothing here establishes conformity with the AI
Act or any other regulation; it is a reading aid for reviewers evaluating an
OSAS-based deployment.

## Sources

- OWASP Agentic Security Initiative — <https://genai.owasp.org/initiatives/agentic-security-initiative/>
- AARM (Cloud Security Alliance) — <https://aarm.dev/>
- EU AI Act implementation timeline — <https://artificialintelligenceact.eu/implementation-timeline/>
