# Open Support Agent Spec (OSAS) v0.1 — Draft

[中文版](spec-v0.1.zh-CN.md)

**Status:** Draft
**Spec version:** `0.1` (`SPEC_VERSION = "0.1"`)
**License:** Apache-2.0

This document is the normative text of OSAS v0.1, an open interoperability specification
for customer-support AI agents.

> **Authority statement.** The JSON Schemas under [`schemas/`](../schemas/) (JSON Schema
> draft 2020-12, listed in `schemas/manifest.json`) are the machine-checkable authority
> for all data shapes defined here. **Where prose and schema disagree, the schema wins.**
> `additionalProperties: false` applies to every object unless explicitly noted.

> **Draft notice.** This is a draft open specification, not a claimed industry standard.
> It may change incompatibly before v1.0 (see [GOVERNANCE.md](../GOVERNANCE.md)).

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be
interpreted as described in RFC 2119 / RFC 8174.

---

## 1. Scope and conventions

OSAS defines: (a) a core domain model for support work; (b) profile-scoped extension
objects; (c) a permission ladder and a deterministic policy evaluation algorithm that gate
every mutation; (d) execution, idempotency, and reconciliation rules; (e) a tool surface
(MCP) and a model gateway contract; and (f) security requirements for implementations.

Global conventions:

- **Money** is `{ currency: string, minorUnits: integer }` where `currency` is an ISO 4217
  three-letter upper-case code. Floating-point money values MUST NOT be used.
- **Timestamps** are ISO 8601 strings (`format: "date-time"`).
- **IDs** are opaque strings. Implementations MUST NOT assign semantics to ID structure.
- All persisted objects have `id: string`, `specVersion: "0.1"` (schema `const`), and
  `createdAt: date-time`; most also have `updatedAt`.
- Profiles: `Profile = "core" | "ecommerce" | "saas"`.

## 2. Core domain model

### 2.1 Case

A unit of support work.

| Field | Type | Required | Description |
|---|---|---|---|
| `tenantId` | string | yes | Owning tenant |
| `customerId` | string | yes | Customer reference |
| `profile` | Profile | yes | Governing profile |
| `channel` | enum | yes | `email` \| `chat` \| `phone` \| `social` \| `api` |
| `subject` | string | yes | Short subject line |
| `status` | CaseStatus | yes | See §3.1 |
| `priority` | enum | yes | `low` \| `normal` \| `high` \| `urgent` |
| `assigneeType` | enum | yes | `agent` \| `human` \| `none` |
| `tags` | string[] | yes | Free-form tags |
| `evidenceIds` | string[] | yes | Attached evidence |
| `closedAt` | date-time | no | Set when closed |

### 2.2 Customer

| Field | Type | Required | Description |
|---|---|---|---|
| `tenantId` | string | yes | Owning tenant |
| `displayName` | string | yes | Display name |
| `email` | string | no | Contact email (redacted in logs, §9) |
| `phone` | string | no | Contact phone (redacted in logs, §9) |
| `locale` | string | no | Preferred locale |
| `region` | string | yes | ISO 3166-1 alpha-2 region code |
| `identityVerification` | object | yes | `{ status: "verified"\|"unverified"\|"expired", method?, verifiedAt?, expiresAt? }` |
| `tags` | string[] | yes | Free-form tags |

### 2.3 Evidence

Evidence anchors proposals in trusted business data.

| Field | Type | Required | Description |
|---|---|---|---|
| `tenantId` | string | yes | Owning tenant |
| `caseId` | string | no | Related case |
| `kind` | enum | yes | `order` \| `shipment` \| `subscription` \| `invoice` \| `knowledge` \| `conversation` \| `policy` \| `identity` \| `other` |
| `source` | object | yes | `{ system, recordType, recordId, url? }` |
| `summary` | string | yes | Human-readable summary |
| `data` | object | yes | Structured payload |
| `retrievedAt` | date-time | yes | When the evidence was fetched |
| `expiresAt` | date-time | no | Hard expiry |

Every proposal conclusion for a **financial** action (§2.4) MUST reference at least one
evidence item. Freshness is evaluated against `expiresAt` and the policy's
`maxEvidenceAgeSeconds` (measured from `retrievedAt`); see §5 step 10.

### 2.4 ActionProposal

The **only** way an agent mutates business state. A proposal is a structured, auditable
request that must pass policy evaluation (§5) before execution.

| Field | Type | Required | Description |
|---|---|---|---|
| `tenantId` | string | yes | Owning tenant |
| `caseId` | string | yes | Related case |
| `profile` | Profile | yes | MUST match the profile of `actionType` (§2.5) |
| `actionType` | ActionType | yes | What to do |
| `reasonCode` | string | yes | Why (matched against policy rule `reasonCodes`) |
| `params` | object | yes | Action-specific parameters |
| `requestedPermission` | Permission | yes | Permission requested (§4) |
| `requestedBy` | object | yes | `{ actorType: "model"\|"human"\|"system", actorId, model?: { provider, model } }` |
| `amount` | Money | no | Required for financial actionTypes |
| `evidenceIds` | string[] | yes | Supporting evidence (≥1 for financial actions) |
| `idempotencyKey` | string | yes | Dedup key for execution (§6) |
| `status` | ProposalStatus | yes | See §3.2 |
| `policyDecision` | PolicyDecision | no | Last evaluation result (§5) |

### 2.5 Action types and profiles

| Profile | ActionType values |
|---|---|
| core | `create_note`, `create_escalation` |
| ecommerce | `refund`, `return_request`, `reshipment`, `cancel_order` |
| saas | `credit_apply`, `subscription_cancel`, `plan_change` |

`profile` MUST match the actionType's owning profile (the reference implementation encodes
this as the `ACTION_TYPE_PROFILE` map). A mismatch is a `PROFILE_MISMATCH` violation
(§5 step 3) and is also rejected at the schema level.

**Financial actionTypes**: `refund`, `reshipment`, `credit_apply`. These require `amount`
and at least one evidence reference.

### 2.6 Approval

| Field | Type | Required | Description |
|---|---|---|---|
| `tenantId` | string | yes | Owning tenant |
| `proposalId` | string | yes | Proposal under approval |
| `status` | enum | yes | `pending` \| `approved` \| `rejected` |
| `approverId` | string | no | Deciding human |
| `comment` | string | no | Decision comment |
| `policyVersion` | string | yes | Policy version under which approval was requested |
| `requestedAt` | date-time | yes | Request time |
| `decidedAt` | date-time | no | Decision time |

### 2.7 TenantPolicy and PolicyRule

The deterministic rulebook evaluated per tenant.

| Field | Type | Required | Description |
|---|---|---|---|
| `tenantId` | string | yes | Owning tenant |
| `version` | string | yes | Semver string; bumped on every update |
| `effectiveFrom` | date-time | yes | Effective time |
| `duplicateWindowSeconds` | integer | yes | Window for duplicate detection (§5 step 6) |
| `maxEvidenceAgeSeconds` | integer | yes | Max evidence age from `retrievedAt` (§5 step 10) |
| `budget` | object | no | `{ dailyUsdCap?: number }` model budget hint |
| `rules` | PolicyRule[] | yes | Evaluated rules |
| `defaultDecision` | const | yes | Always `"block"` — unmatched actions are blocked |

`PolicyRule`:

| Field | Type | Required | Description |
|---|---|---|---|
| `actionType` | ActionType | yes | Action this rule governs |
| `reasonCodes` | string[] | no | Allow-list for `reasonCode`; absent = any |
| `decision` | enum | yes | `auto_execute` \| `require_approval` \| `block` |
| `maxAmount` | Money | no | Auto-execute amount ceiling (§5 step 7) |
| `requireVerifiedIdentity` | boolean | no | Require verified customer identity |
| `identityMaxAgeSeconds` | integer | no | Max identity verification age |
| `allowedRegions` | string[] | no | Region allow-list (absent = all allowed) |
| `blockedRegions` | string[] | no | Region deny-list |

### 2.8 AuditEvent

Every meaningful step emits an append-only audit event.

| Field | Type | Required | Description |
|---|---|---|---|
| `tenantId` | string | yes | Owning tenant |
| `caseId` / `proposalId` / `approvalId` | string | no | Correlation references |
| `eventType` | AuditEventType | yes | See below |
| `actorType` | enum | yes | `model` \| `policy_engine` \| `human` \| `system` \| `adapter` |
| `actorId` | string | yes | Acting principal |
| `policyVersion` | string | no | Policy version in force |
| `modelInfo` | object | no | `{ provider, model, tier, inputTokens, outputTokens, latencyMs, costUsd }` |
| `detail` | object | yes | Event-specific payload |

`AuditEventType` values: `proposal_created`, `proposal_validated`,
`proposal_validation_failed`, `policy_evaluated`, `approval_requested`,
`approval_decided`, `execution_started`, `execution_succeeded`, `execution_failed`,
`execution_uncertain`, `reconciliation_opened`, `reconciliation_resolved`,
`handoff_created`, `handoff_resolved`, `prompt_injection_blocked`,
`permission_overreach_blocked`, `budget_exceeded`, `model_call_recorded`.

### 2.9 HumanHandoff

| Field | Type | Required | Description |
|---|---|---|---|
| `tenantId` | string | yes | Owning tenant |
| `caseId` | string | yes | Related case |
| `proposalId` | string | no | Related proposal |
| `reason` | HandoffReason | yes | See below |
| `status` | enum | yes | `open` \| `claimed` \| `resolved` |
| `assignedTo` | string | no | Claiming human |
| `notes` | string | no | Resolution notes |
| `resolvedAt` | date-time | no | Resolution time |

`HandoffReason` values: `identity_unverified`, `insufficient_evidence`,
`duplicate_request`, `over_threshold`, `region_blocked`, `policy_conflict`,
`external_uncertain`, `prompt_injection_suspected`, `customer_requested`, `other`.

### 2.10 Profile extension objects

Schemas live under `schemas/profiles/`.

**Order** (ecommerce): `tenantId`, `customerId`,
`status: "pending"|"paid"|"fulfilled"|"shipped"|"delivered"|"refunded"|"cancelled"`,
`items: [{ sku, name, qty: integer, unitPrice: Money }]`, `total: Money`, `region`,
`createdAt`.

**Shipment** (ecommerce): `tenantId`, `orderId`, `carrier`, `trackingNumber?`,
`status: "label_created"|"in_transit"|"out_for_delivery"|"delivered"|"exception"`, `eta?`.

**Subscription** (saas): `tenantId`, `customerId`, `plan`,
`status: "trialing"|"active"|"past_due"|"cancelled"`, `mrr: Money`, `renewsAt`.

**Invoice** (saas): `tenantId`, `customerId`, `subscriptionId?`, `amount: Money`,
`status: "open"|"paid"|"void"`, `issuedAt`, `dueAt?`.

**CreditBalance** (saas): `tenantId`, `customerId`, `balance: Money`.

**KnowledgeArticle** (core): `tenantId`, `title`, `body`, `tags: string[]`.

**CaseNote / Escalation** (core): simple records
`{ id, specVersion, tenantId, caseId, body|reason, createdAt }`.

## 3. State machines

### 3.1 CaseStatus

Values: `open`, `pending_agent`, `pending_customer`, `resolved`, `closed`.

| From ↓ / To → | open | pending_agent | pending_customer | resolved | closed |
|---|---|---|---|---|---|
| open | — | ✓ | ✓ | — | ✓ |
| pending_agent | — | — | ✓ | ✓ | ✓ |
| pending_customer | — | ✓ | — | ✓ | ✓ |
| resolved | — | ✓ | — | — | ✓ |
| closed | — | — | — | — | — |

`closed` is terminal. Implementations MUST reject any transition not marked ✓
(reference: `canTransitionCase` / `transitionCase`, which throws on illegal transitions).

### 3.2 ProposalStatus

Values: `proposed`, `policy_rejected`, `pending_approval`, `approved`, `rejected`,
`executing`, `executed`, `failed`, `reconciliation_required`.

| From ↓ / To → | policy_rejected | pending_approval | approved | rejected | executing | executed | failed | reconciliation_required |
|---|---|---|---|---|---|---|---|---|
| proposed | ✓ | ✓ | ✓ | — | — | — | — | — |
| pending_approval | — | — | ✓ | ✓ | — | — | — | — |
| approved | — | — | — | — | ✓ | — | — | — |
| executing | — | — | — | — | — | ✓ | ✓ | ✓ |
| reconciliation_required | — | — | — | — | — | ✓ | ✓ | — |
| policy_rejected / rejected / executed / failed | — | — | — | — | — | — | — | — |

`policy_rejected`, `rejected`, `executed`, and `failed` are terminal. A rejected or failed
proposal MUST NOT be retried in place — **no blind retries**: a new attempt is a **new
proposal with a new `idempotencyKey`** (reference: `canTransitionProposal` /
`transitionProposal`).

## 4. Permission ladder

`read < draft < request-approval < execute` (ordered array `PERMISSIONS`;
`permissionAtLeast(a, b)` compares).

| Permission | Grants |
|---|---|
| `read` | Read access to cases, customers, profile objects, knowledge |
| `draft` | Create case notes, escalations, and action proposals |
| `request-approval` | Submit proposals that must be approved before execution |
| `execute` | Execute proposals against the backend |

Normative rules:

1. **Model principals are capped at `request-approval`.** A proposal with
   `requestedPermission: "execute"` and `requestedBy.actorType === "model"` is a policy
   violation: decision `block` with reason `PERMISSION_OVERREACH`, proposal status
   `policy_rejected`, a `HumanHandoff` with reason `policy_conflict`, and an
   `AuditEvent` of type `permission_overreach_blocked`.
2. **Only the policy engine / API backend** may move a proposal to `executing`, and only
   after an `auto_execute` decision or a human approval.
3. **Models never hold backend credentials.** All reads and writes flow through the
   adapter with a `Principal`:
   `Permission = "read"|"draft"|"request-approval"|"execute"`;
   `Principal = { actorType: "model"|"human"|"system", actorId: string, permission: Permission }`;
   every adapter call carries a `ToolContext = { tenantId, principal }`.

## 5. Policy evaluation algorithm (deterministic)

```
evaluateProposal(proposal, ctx: {
  customer: Customer,
  evidence: Evidence[],
  policy: TenantPolicy,
  recentProposals: ActionProposal[],
  injectionSuspected: boolean
}) → PolicyDecision

PolicyDecision = {
  decision: "auto_execute" | "require_approval" | "block",
  reasons: [{ code: string, message: string }],
  policyVersion: string,
  evaluatedAt: date-time
}
```

The algorithm collects **all** applicable reasons; the final decision is the worst of
`block` > `require_approval` > `auto_execute`. Steps, in order:

1. **`PERMISSION_OVERREACH`** — model principal requesting `execute` (§4) → block.
2. **`PROMPT_INJECTION_SUSPECTED`** — `ctx.injectionSuspected` is true → block, plus a
   handoff (`prompt_injection_suspected`) and a `prompt_injection_blocked` event.
3. **`PROFILE_MISMATCH`** — actionType does not belong to `proposal.profile` → block
   (also enforced at schema level).
4. **`NO_RULE`** — no policy rule matches `actionType` → block (default decision is
   `block`).
5. **`REASON_CODE_NOT_ALLOWED`** — matched rule has a `reasonCodes` list and the
   proposal's `reasonCode` is not in it → block.
6. **`DUPLICATE_REQUEST`** — another proposal exists with the same
   `tenantId` + `caseId` + `actionType` and deep-equal `params`, created within
   `duplicateWindowSeconds`, in status `executing` / `executed` / `pending_approval` /
   `approved` → block + handoff (`duplicate_request`).
7. **`OVER_THRESHOLD`** — `amount` present, rule has `maxAmount`, and amount exceeds it
   (same currency) → escalate to `require_approval`. A **currency mismatch** between
   amount and maxAmount escalates to `require_approval` with reason `CURRENCY_MISMATCH`.
8. **`IDENTITY_REQUIRED` / `IDENTITY_UNVERIFIED`** — rule has `requireVerifiedIdentity`
   and the customer's identity is not `verified`, or the verification is older than
   `identityMaxAgeSeconds` → block + handoff (`identity_unverified`).
9. **`REGION_BLOCKED`** — `customer.region` ∈ rule `blockedRegions` → block + handoff
   (`region_blocked`). **`REGION_UNLISTED`** — rule has `allowedRegions` and region ∉
   list → `require_approval`.
10. **`INSUFFICIENT_EVIDENCE`** — financial actionType with no `evidenceIds` → block +
    handoff (`insufficient_evidence`). **`EVIDENCE_STALE`** — any referenced evidence is
    expired (`expiresAt` < now) or older than `maxEvidenceAgeSeconds` (from
    `retrievedAt`) → `require_approval`.
11. Otherwise the matched rule's `decision` applies (`auto_execute` or
    `require_approval`).

Side effects (engine or API layer):

- `block` → proposal becomes `policy_rejected`, plus a handoff where listed above.
- `require_approval` → proposal becomes `pending_approval`; an `Approval`
  (`status: "pending"`, `policyVersion`) is created; an `approval_requested` event is
  emitted.
- `auto_execute` → proposal becomes `approved` and is eligible for execution (§6).

Every evaluation MUST emit a `policy_evaluated` audit event carrying `policyVersion`.

## 6. Execution, idempotency, and reconciliation

`ExecutionResult = { status: "succeeded"|"failed"|"uncertain", externalRef?: string, detail?: string }`.

Rules:

1. Executions are keyed by `(tenantId, idempotencyKey)` in an **ExecutionStore**. A
   replay with the same key MUST return the stored result with `replayed: true` and MUST
   produce **no side effects** (no double refund, no double close).
2. `executeProposal(proposal, adapter, store)` requires status `approved`. It moves the
   proposal to `executing` (emitting `execution_started`), then calls
   `adapter.executeAction`:
   - `succeeded` → `executed` + `execution_succeeded`; store the result.
   - `failed` → `failed` + `execution_failed`; store the result.
   - `uncertain` (e.g. a timeout where the backend outcome is unknown) →
     `reconciliation_required` + `execution_uncertain` + `reconciliation_opened` +
     `HumanHandoff(external_uncertain)`. **Never auto-retry.**
3. `reconcile(proposalId, outcome)` is only valid from `reconciliation_required` and
   moves the proposal to `executed` or `failed`, emitting `reconciliation_resolved`.
   Reconciliation is a human-driven recovery path, not an automatic retry.

## 7. Tool profiles (MCP)

Agents interact with backends exclusively through 16 MCP tools. Each tool's input schema
lives at `schemas/tools/<tool_name>.json`; tool metadata is the pure-data export
`TOOL_DEFINITIONS: ToolDefinition[]` where
`ToolDefinition = { name, profile, description, inputSchema, adapterMethod, permissionRequired }`.

| # | Tool | Profile | Adapter method |
|---|---|---|---|
| 1 | `osas_core_get_case` | core | `getCase` |
| 2 | `osas_core_search_cases` | core | `searchCases` |
| 3 | `osas_core_get_customer` | core | `getCustomer` |
| 4 | `osas_core_search_knowledge` | core | `searchKnowledge` |
| 5 | `osas_core_create_case_note` | core | `createCaseNote` |
| 6 | `osas_core_create_escalation` | core | `createEscalation` |
| 7 | `osas_core_create_action_proposal` | core | `createActionProposal` |
| 8 | `osas_ecom_get_order` | ecommerce | `getOrder` |
| 9 | `osas_ecom_list_orders` | ecommerce | `listOrders` |
| 10 | `osas_ecom_get_shipment` | ecommerce | `getShipment` |
| 11 | `osas_saas_get_subscription` | saas | `getSubscription` |
| 12 | `osas_saas_list_invoices` | saas | `listInvoices` |
| 13 | `osas_saas_get_credit_balance` | saas | `getCreditBalance` |
| 14 | `osas_saas_create_credit_request` | saas | `createActionProposal` |
| 15 | `osas_saas_create_cancellation_request` | saas | `createActionProposal` |
| 16 | `osas_saas_create_plan_change_request` | saas | `createActionProposal` |

Normative rules:

- The three `*_request` SaaS tools (and e-commerce refund/return shortcuts built on the
  same path) construct an `ActionProposal` with status `proposed` and
  `requestedPermission: "request-approval"` via `createActionProposal`; they **never
  execute**.
- `executeAction` is **never** registered as an MCP tool. Execution happens only through
  the policy engine / API after evaluation (§5, §6).
- The 1:1 mapping between `TOOL_DEFINITIONS`, adapter methods, and
  `schemas/tools/*.json` is enforced by the compat suite.
- Tool output is `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }`.
- Adapter errors map to callers as `AdapterNotFoundError` (→ API 404) and
  `AdapterPermissionError` (→ API 403).

## 8. Model gateway

The gateway isolates the agent from provider specifics and enforces cost/output limits.

```ts
type ModelTier = "classify" | "standard" | "reasoning";
type ModelTask = "classify" | "extract" | "reply" | "propose";

interface ModelRequest {
  tier: ModelTier; task: ModelTask;
  messages: { role: "system"|"user"|"assistant"; content: string }[];
  outputSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}
interface ModelTelemetry {
  provider: string; model: string; tier: ModelTier; task: ModelTask;
  inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number;
  truncated: boolean;
}
interface ModelResponse { text: string; parsed?: unknown; telemetry: ModelTelemetry }
interface ModelProvider {
  name: string;
  supports(tier: ModelTier): boolean;
  complete(req: ModelRequest): Promise<ModelResponse>;
}
```

Normative requirements:

1. **Output caps per task** (gateway-enforced; sets `truncated` when hit):
   `classify` 256, `extract` 512, `reply` 1024, `propose` 1024 tokens.
2. **Routing**: each tier routes to a configured provider; on unknown or failed
   provider, the gateway degrades to the next provider supporting that tier.
3. **Budgets**: cumulative `costUsd` is tracked; exceeding the configured cap throws
   `BudgetExceededError` and emits a `budget_exceeded` audit event (via the telemetry
   hook).
4. **Telemetry**: every model call is recorded (`model_call_recorded`) with the full
   `ModelTelemetry` shape; telemetry is also embedded in audit events as `modelInfo`.
5. **Injection screening**: gateway input is screened with the shared
   `detectInjection(text)` function (§9); suspected input is flagged on telemetry as
   `rejectedInjection` and passed to policy evaluation as `injectionSuspected`
   (§5 step 2).

The reference `MockModelProvider` (`name = "mock-local"`) is deterministic (same input →
same output; pseudo-tokens/latency derived from a string hash), uses no network, and has
approximately zero cost. It is the default (`MODEL_PROVIDER=mock`).

## 9. Security requirements

Implementations conforming to this specification MUST:

1. **Hold no credentials in the model layer.** Models never receive backend credentials;
   all backend access flows through the adapter with an explicit `Principal` (§4).
2. **Defend against prompt injection.** All untrusted text (customer messages, knowledge
   articles, tool outputs) is screened with shared injection detection — at minimum
   case-insensitive patterns such as "ignore (all|previous|above) instructions",
   "system prompt", "you are now", "do anything now", "无视(之前|以上|所有)指令",
   "立即执行退款". Suspected input blocks proposals via §5 step 2 and emits
   `prompt_injection_blocked`.
3. **Redact PII in logs.** Log pipelines MUST redact at least
   `req.headers.authorization`, `*.email`, `*.phone`, and free-text bodies. Customer data
   MUST NOT leave the process except through the configured adapter.
4. **No blind retries.** Terminal proposal states are never re-executed; a new attempt
   requires a new proposal with a new `idempotencyKey` (§3.2, §6). `uncertain` outcomes
   go to reconciliation, never automatic retry.
5. **Validate before acting.** Proposals failing schema validation MUST be rejected
   (API: `422 SCHEMA_INVALID`) and MUST NOT be executed.
6. **Default deny.** The policy default decision is `block`; anything not explicitly
   allowed by a matching rule is blocked (§5 step 4).

## 10. Versioning

- `specVersion: "0.1"` is a schema-level constant on every persisted object.
- OSAS follows semantic versioning for the specification, schemas, and reference
  packages in lockstep (see [GOVERNANCE.md](../GOVERNANCE.md)).
- While v0.x, any change may be breaking; breaking and new-semantics changes always
  require an RFC (see [rfcs/](../rfcs/)).

## 11. Conformance

An implementation declares **profile compatibility** for a profile (`core`, `ecommerce`,
`saas`) only by passing the corresponding compat suite (`@osas/compat-suite`), which
checks: schema valid/invalid fixture validation, cross-profile actionType rules, the
tool-definition ↔ adapter-method ↔ input-schema 1:1 mapping, state-machine legality
tables, the policy evaluation matrix, and idempotency/reconciliation behavior. The suite
emits a machine-readable report
(`{ specVersion, runAt, suites: [{ name, passed, failed, cases: [...] }], ok: boolean }`).
