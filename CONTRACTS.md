# OSAS v0.1 — Engineering Contracts

This file is the **single shared contract** for every contributor/agent building this monorepo.
It fixes paths, package names, types, algorithms, tool names, and API endpoints so that
independently-built parts integrate without drift. The JSON Schemas under `schemas/` are the
machine-checkable authority; this file must agree with them. `SPEC_VERSION = "0.1"`.

## 0. Fixed decisions

- pnpm workspace, Node >= 20, TypeScript strict, **ESM** (`"type": "module"`, NodeNext → relative imports in TS **must use `.js` suffix**), Vitest for all tests.
- npm scope `@osas/*`, every package `"version": "0.1.1"` (specVersion stays `"0.1"`), `"private": true`.
- Runtime validation: **Ajv v8 + ajv-formats only** (no zod). Schemas: JSON Schema draft 2020-12, `additionalProperties: false` on every object unless noted.
- Money is `{ currency: string (ISO 4217, 3 upper-case letters), minorUnits: integer }`. Never floats.
- Timestamps: ISO 8601 strings (`format: "date-time"`). IDs: opaque strings.
- **Do NOT edit root files** (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`) or other packages' directories. Do NOT run `pnpm install` (done centrally) or `git` commands.
- Per-package scripts: `build` = `tsc -p tsconfig.json`, `typecheck` = `tsc --noEmit -p tsconfig.json`, `test` = `vitest run`. tsconfig per package extends `../../tsconfig.base.json` with `rootDir: src`, `outDir: dist`, and `"types": ["node"]` where needed. Packages export from `src/index.ts` → `dist/index.js` (`"main"`, `"types"`, `"exports"`).

## 1. Repo layout (fixed)

```
schemas/                     # authoritative JSON Schemas (draft 2020-12)
  manifest.json              # { specVersion, schemas: [{name, profile, path}] }
  core/*.json                # 8 core objects + common.json
  profiles/ecommerce/*.json  # order.json, shipment.json
  profiles/saas/*.json       # subscription.json, invoice.json, credit-balance.json
  tools/*.json               # one input schema per MCP tool (16 tools, §7)
packages/
  core/            @osas/core             types, enums, state machines, detectInjection, id helpers
  schema-validator/@osas/schema-validator Ajv loader/validator over schemas/
  policy-engine/   @osas/policy-engine    TenantPolicy evaluation, permission ladder, execution orchestration
  model-gateway/   @osas/model-gateway    provider interface, MockModelProvider, routing, budgets, telemetry
  adapter/         @osas/adapter          SupportAdapter interface + BYO adapter template
  mock-backend/    @osas/mock-backend     synthetic fixtures + MockSupportAdapter implementing SupportAdapter
  mcp-server/      @osas/mcp-server       TOOL_DEFINITIONS + buildMcpServer + stdio main
apps/
  api/             @osas/api              Fastify 5 HTTP API (§9)
  web/             @osas/web              React 18 + Vite console (§10)
tests/
  compat/          @osas/compat-suite     schema/compat test suite + JSON report emitter (§12)
  e2e/             @osas/e2e              Playwright smoke (optional locally)
rfcs/  docs/  .github/workflows/  docker-compose.yml
```

## 2. Core domain model

All persisted objects have `id: string`, `specVersion: "0.1"` (schema: `const`), `createdAt: date-time`; most also `updatedAt`.

### Profile = "core" | "ecommerce" | "saas"

### Case
`tenantId, customerId, profile, channel: "email"|"chat"|"phone"|"social"|"api", subject, status: CaseStatus, priority: "low"|"normal"|"high"|"urgent", assigneeType: "agent"|"human"|"none", tags: string[], evidenceIds: string[], closedAt?`
CaseStatus = `open | pending_agent | pending_customer | resolved | closed`.
Transitions: `open→{pending_agent,pending_customer,closed}`; `pending_agent→{pending_customer,resolved,closed}`; `pending_customer→{pending_agent,resolved,closed}`; `resolved→{pending_agent,closed}`; `closed→{}` (terminal). `canTransitionCase(from,to)` + `transitionCase(case,to)` (throws on illegal) in `@osas/core`.

### Customer
`tenantId, displayName, email?, phone?, locale?, region: string (ISO 3166-1 alpha-2), identityVerification: { status: "verified"|"unverified"|"expired", method?, verifiedAt?, expiresAt? }, tags: string[]`

### Evidence
`tenantId, caseId?, kind: "order"|"shipment"|"subscription"|"invoice"|"knowledge"|"conversation"|"policy"|"identity"|"other", source: { system, recordType, recordId, url? }, summary, data: object, retrievedAt: date-time, expiresAt?: date-time`
Every proposal conclusion MUST reference ≥1 evidence for financial actions; freshness checked against `expiresAt` and policy `maxEvidenceAgeSeconds` (from `retrievedAt`).

### ActionProposal
`tenantId, caseId, profile, actionType: ActionType, reasonCode: string, params: object, requestedPermission: Permission, requestedBy: { actorType: "model"|"human"|"system", actorId, model?: { provider, model } }, amount?: Money, evidenceIds: string[], idempotencyKey: string, status: ProposalStatus, policyDecision?: PolicyDecision`
ActionType — core: `create_note`, `create_escalation`; ecommerce: `refund`, `return_request`, `reshipment`, `cancel_order`; saas: `credit_apply`, `subscription_cancel`, `plan_change`. `profile` must match the actionType's profile (`ACTION_TYPE_PROFILE` map in core).
Financial actionTypes (need amount + ≥1 evidence): `refund`, `reshipment`, `credit_apply`.
ProposalStatus = `proposed | policy_rejected | pending_approval | approved | rejected | executing | executed | failed | reconciliation_required`.
Transitions: `proposed→{policy_rejected,pending_approval,approved}`; `pending_approval→{approved,rejected}`; `approved→{executing}`; `executing→{executed,failed,reconciliation_required}`; `reconciliation_required→{executed,failed}`; `policy_rejected|rejected|executed|failed→{}` (terminal; no blind retry — a new attempt = new proposal with new idempotencyKey). `canTransitionProposal/transitionProposal` in core.

### Approval
`tenantId, proposalId, status: "pending"|"approved"|"rejected", approverId?, comment?, policyVersion: string, requestedAt: date-time, decidedAt?`

### TenantPolicy
`tenantId, version: string (semver), effectiveFrom: date-time, duplicateWindowSeconds: integer, maxEvidenceAgeSeconds: integer, budget?: { dailyUsdCap?: number }, rules: PolicyRule[], defaultDecision: "block" (const)`
PolicyRule = `{ actionType: ActionType, reasonCodes?: string[], decision: "auto_execute"|"require_approval"|"block", maxAmount?: Money, requireVerifiedIdentity?: boolean, identityMaxAgeSeconds?: integer, allowedRegions?: string[], blockedRegions?: string[] }`

### AuditEvent
`tenantId, caseId?, proposalId?, approvalId?, eventType: AuditEventType, actorType: "model"|"policy_engine"|"human"|"system"|"adapter", actorId, policyVersion?, modelInfo?: { provider, model, tier, inputTokens, outputTokens, latencyMs, costUsd }, detail: object`
AuditEventType = `proposal_created | proposal_validated | proposal_validation_failed | policy_evaluated | approval_requested | approval_decided | execution_started | execution_succeeded | execution_failed | execution_uncertain | reconciliation_opened | reconciliation_resolved | handoff_created | handoff_resolved | prompt_injection_blocked | permission_overreach_blocked | budget_exceeded | model_call_recorded`.

### HumanHandoff
`tenantId, caseId, proposalId?, reason: HandoffReason, status: "open"|"claimed"|"resolved", assignedTo?, notes?, resolvedAt?`
HandoffReason = `identity_unverified | insufficient_evidence | duplicate_request | over_threshold | region_blocked | policy_conflict | external_uncertain | prompt_injection_suspected | customer_requested | other`.

### Extension objects (schemas in profiles/*)
- Order: `tenantId, customerId, status: "pending"|"paid"|"fulfilled"|"shipped"|"delivered"|"refunded"|"cancelled", items: [{ sku, name, qty: integer, unitPrice: Money }], total: Money, region, createdAt`
- Shipment: `tenantId, orderId, carrier, trackingNumber?, status: "label_created"|"in_transit"|"out_for_delivery"|"delivered"|"exception", eta?`
- Subscription: `tenantId, customerId, plan, status: "trialing"|"active"|"past_due"|"cancelled", mrr: Money, renewsAt`
- Invoice: `tenantId, customerId, subscriptionId?, amount: Money, status: "open"|"paid"|"void", issuedAt, dueAt?`
- CreditBalance: `tenantId, customerId, balance: Money`
- KnowledgeArticle (core, schema in core/knowledge-article.json OK to add to manifest): `tenantId, title, body, tags: string[]`
- CaseNote / Escalation: simple `{ id, specVersion, tenantId, caseId, body|reason, createdAt }`.

## 3. Permission ladder

`read < draft < request-approval < execute` (`PERMISSIONS` ordered array in core; `permissionAtLeast(a,b)`).
- Model principals are capped at `request-approval`: a proposal with `requestedPermission: "execute"` **and** `requestedBy.actorType === "model"` → policy violation `PERMISSION_OVERREACH` → `policy_rejected` + handoff (`policy_conflict`) + AuditEvent `permission_overreach_blocked`.
- Only the policy engine / API backend may move a proposal to `executing` (after `auto_execute` decision or human approval).
- Models never hold backend credentials; all reads/writes flow through the adapter with a `Principal`.

## 4. Policy evaluation algorithm (deterministic, in @osas/policy-engine)

`evaluateProposal(proposal, ctx: { customer, evidence: Evidence[], policy: TenantPolicy, recentProposals: ActionProposal[], injectionSuspected: boolean }) → PolicyDecision`
`PolicyDecision = { decision: "auto_execute"|"require_approval"|"block", reasons: [{ code: string, message: string }], policyVersion: string, evaluatedAt }`
Order (collect ALL applicable reasons; final decision = worst of block > require_approval > auto_execute):
1. `PERMISSION_OVERREACH` (§3) → block.
2. `PROMPT_INJECTION_SUSPECTED` if ctx.injectionSuspected → block + handoff(prompt_injection_suspected) + event.
3. `PROFILE_MISMATCH` actionType not in proposal.profile → block (schema-level too).
4. `NO_RULE` no rule matches actionType → block (default block).
5. Rule matched: `REASON_CODE_NOT_ALLOWED` (reasonCodes list present and reasonCode not in it) → block.
6. `DUPLICATE_REQUEST`: another proposal with same tenantId+caseId+actionType and deep-equal params, created within `duplicateWindowSeconds`, in status executing/executed/pending_approval/approved → block + handoff(duplicate_request).
7. `OVER_THRESHOLD`: amount present and rule.maxAmount and amount > maxAmount (same currency; mismatched currency → require_approval `CURRENCY_MISMATCH`) → escalate to require_approval.
8. `IDENTITY_REQUIRED`/`IDENTITY_UNVERIFIED`: rule.requireVerifiedIdentity and customer.identityVerification.status !== "verified" or older than identityMaxAgeSeconds → block + handoff(identity_unverified).
9. `REGION_BLOCKED`: customer.region ∈ rule.blockedRegions → block + handoff(region_blocked). `REGION_UNLISTED`: allowedRegions present and region ∉ → require_approval.
10. `INSUFFICIENT_EVIDENCE`: financial actionType with no evidenceIds → block + handoff(insufficient_evidence). `EVIDENCE_STALE`: any referenced evidence expired (expiresAt < now) or retrievedAt older than policy.maxEvidenceAgeSeconds → require_approval.
11. Else rule.decision (auto_execute | require_approval).

Side effects (engine or API layer): block → proposal `policy_rejected` (+handoff where listed); require_approval → `pending_approval` + Approval(status pending, policyVersion) + `approval_requested` event; auto_execute → `approved` then eligible for execute. Every evaluation emits `policy_evaluated` with policyVersion.

## 5. Execution, idempotency, reconciliation (@osas/policy-engine + api)

- `ExecutionResult = { status: "succeeded"|"failed"|"uncertain", externalRef?: string, detail?: string }`.
- Executions keyed by `(tenantId, idempotencyKey)` in an ExecutionStore. Replay with the same key → return stored result with `replayed: true`, **no side effects** (no double refund/close).
- `executeProposal(proposal, adapter, store)`: status must be `approved` → `executing` (`execution_started`) → adapter.executeAction:
  - succeeded → `executed` + `execution_succeeded`, store result.
  - failed → `failed` + `execution_failed`, store result.
  - uncertain (e.g. timeout) → `reconciliation_required` + `execution_uncertain` + `reconciliation_opened` + HumanHandoff(external_uncertain). **Never auto-retry.**
- `reconcile(proposalId, outcome)`: only from `reconciliation_required` → `executed|failed` + `reconciliation_resolved`.

## 6. SupportAdapter interface (@osas/adapter)

```ts
export type Permission = "read"|"draft"|"request-approval"|"execute";
export interface Principal { actorType: "model"|"human"|"system"; actorId: string; permission: Permission; }
export interface ToolContext { tenantId: string; principal: Principal; }
export interface SupportAdapter {
  getCase(ctx, id): Promise<Case>;
  searchCases(ctx, q: { customerId?: string; status?: CaseStatus; q?: string }): Promise<Case[]>;
  getCustomer(ctx, id): Promise<Customer>;
  searchKnowledge(ctx, q: { q: string; limit?: number }): Promise<KnowledgeArticle[]>;
  createCaseNote(ctx, input: { caseId: string; body: string; evidenceIds?: string[]; idempotencyKey: string }): Promise<CaseNote>;
  createEscalation(ctx, input: { caseId: string; reason: string; idempotencyKey: string }): Promise<Escalation>;
  createActionProposal(ctx, input: Omit<ActionProposal, "id"|"specVersion"|"status"|"createdAt"|"updatedAt">): Promise<ActionProposal>;
  getOrder(ctx, id): Promise<Order>;
  listOrders(ctx, customerId: string): Promise<Order[]>;
  getShipment(ctx, id): Promise<Shipment>;
  getSubscription(ctx, id): Promise<Subscription>;
  listInvoices(ctx, customerId: string): Promise<Invoice[]>;
  getCreditBalance(ctx, customerId: string): Promise<CreditBalance>;
  executeAction(ctx, proposal: ActionProposal): Promise<ExecutionResult>; // execute-permission only; NOT an MCP tool
  captureEvidence(ctx, input: Omit<Evidence, "id"|"specVersion"|"createdAt">): Promise<Evidence>;
  getEvidence(ctx, id): Promise<Evidence>;
  listEvidence(ctx, q: { caseId?: string }): Promise<Evidence[]>;
  // proposal persistence used by the API/engine (mock keeps in memory; BYO maps to real store)
  getProposal(ctx, id): Promise<ActionProposal>;
  listProposals(ctx, q: { caseId?: string; status?: ProposalStatus }): Promise<ActionProposal[]>;
  updateProposalStatus(ctx, id: string, status: ProposalStatus, patch?: Partial<ActionProposal>): Promise<ActionProposal>;
  appendAuditEvent(ctx, e: Omit<AuditEvent, "id"|"specVersion"|"createdAt">): Promise<AuditEvent>;
  listAuditEvents(ctx, q: { caseId?: string; proposalId?: string }): Promise<AuditEvent[]>;
  createApproval(ctx, a: Omit<Approval, "id"|"specVersion"|"createdAt">): Promise<Approval>;
  getApproval(ctx, id): Promise<Approval>;
  listApprovals(ctx, q: { status?: Approval["status"] }): Promise<Approval[]>;
  decideApproval(ctx, id: string, decision: "approved"|"rejected", approverId: string, comment?: string): Promise<Approval>;
  createHandoff(ctx, h: Omit<HumanHandoff, "id"|"specVersion"|"status"|"createdAt"|"updatedAt">): Promise<HumanHandoff>;
  listHandoffs(ctx, q: { status?: HumanHandoff["status"] }): Promise<HumanHandoff[]>;
  updateHandoff(ctx, id: string, patch: Partial<Pick<HumanHandoff,"status"|"assignedTo"|"notes"|"resolvedAt">>): Promise<HumanHandoff>;
  getPolicy(ctx, tenantId: string): Promise<TenantPolicy>;
  putPolicy(ctx, policy: TenantPolicy): Promise<TenantPolicy>;
  // v0.1.1: optional capability provider; once declared it is enforced
  // (undeclared capability -> AdapterCapabilityError CAPABILITY_UNSUPPORTED).
  getCapabilities?(ctx): Promise<CapabilityManifest>;
}
```
Package also ships `templates/byo-adapter.template.ts` — a copy-paste starting point with TODOs for real systems (Zendesk/Shopify/Stripe-agnostic). Adapter methods must throw `AdapterNotFoundError` (→ API 404) / `AdapterPermissionError` (→ 403) from @osas/adapter errors.ts.

## 7. MCP mapping (@osas/mcp-server)

- Export pure data `TOOL_DEFINITIONS: ToolDefinition[]` (`{ name, profile, description, inputSchema, adapterMethod, permissionRequired, capabilityRequired }`) — used by compat tests and the API `/v1/meta/tools`. `capabilityRequired` (v0.1.1) maps each tool to its spec capability; undeclared capabilities fail with `CAPABILITY_UNSUPPORTED` before the adapter is touched.
- Tool names (16): `osas_core_get_case, osas_core_search_cases, osas_core_get_customer, osas_core_search_knowledge, osas_core_create_case_note, osas_core_create_escalation, osas_core_create_action_proposal, osas_ecom_get_order, osas_ecom_list_orders, osas_ecom_get_shipment, osas_saas_get_subscription, osas_saas_list_invoices, osas_saas_get_credit_balance, osas_saas_create_credit_request, osas_saas_create_cancellation_request, osas_saas_create_plan_change_request`.
- The three `*_request` saas tools + ecom return/refund shortcut tools build an ActionProposal (status `proposed`, requestedPermission `request-approval`) via `createActionProposal`; they never execute.
- Each tool's inputSchema lives at `schemas/tools/<tool_name>.json`.
- `buildMcpServer(adapter, principal)` from `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`), tool handlers call adapter with ctx; output `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }`. `executeAction` is NEVER registered as a tool. `src/index.ts` = stdio main.

## 8. Model gateway (@osas/model-gateway)

```ts
export type ModelTier = "classify" | "standard" | "reasoning";
export type ModelTask = "classify" | "extract" | "reply" | "propose";
export interface ModelRequest { tier: ModelTier; task: ModelTask; messages: { role: "system"|"user"|"assistant"; content: string }[]; outputSchema?: Record<string, unknown>; maxOutputTokens?: number; }
export interface ModelTelemetry { provider, model, tier, task, inputTokens, outputTokens, latencyMs, costUsd /* number; absent = unknown (never fabricated) */, truncated: boolean }
export interface ModelResponse { text: string; parsed?: unknown; telemetry: ModelTelemetry }
export interface ModelProvider { name: string; supports(tier: ModelTier): boolean; complete(req: ModelRequest): Promise<ModelResponse>; }
export class MockModelProvider implements ModelProvider { name = "mock-local"; /* deterministic, no network, ~0 cost */ }
export class ModelGateway { constructor(providers: ModelProvider[], opts?: { routing?: Partial<Record<ModelTier, string>>; budgetUsdCap?: number; dailyBudgetUsd?: number; caseBudgetUsd?: number; onBudgetWarning?: (w: BudgetWarning) => void; onTelemetry?: (t: ModelTelemetry & { rejectedInjection?: boolean }) => void }); complete(req): Promise<ModelResponse>; primeBudgets(...) }
export class OpenAICompatibleProvider implements ModelProvider { name = "openai-compatible"; /* plain fetch, no vendor SDK */ }
export interface UsageStore { record(entry): Promise<void>; query(q): Promise<UsageRecord[]>; sumKnownCostUsd(q): Promise<number> } // InMemoryUsageStore + PostgresUsageStore
```
- Output caps per task (enforced by gateway, sets `truncated`): classify 256, extract 512, reply 1024, propose 1024 tokens (1 token ≈ 4 chars in mock).
- Routing: tier → provider name (default all → mock-local). Unknown/failed provider → degrade to next supporting provider.
- Budget: cumulative costUsd; exceeding `budgetUsdCap` → throw `BudgetExceededError` (+ onTelemetry flag).
- MockModelProvider is **deterministic** (same input → same output; derive pseudo-tokens/latency from a simple string hash) and scenario-aware: messages containing "refund"/"退款" → propose refund proposal JSON; "credit"/"额度" → credit_apply; "cancel" → subscription_cancel; otherwise reply text. It must emit proposals parseable against the ActionProposal schema given case context passed in the system message (keep it simple: parse IDs via regex `ord_[\\w]+`, `case_[\\w]+`, `sub_[\\w]+`).
- `detectInjection(text): boolean` lives in **@osas/core** (shared): case-insensitive patterns — "ignore (all|previous|above) instructions", "system prompt", "you are now", "do anything now", "无视(之前|以上|所有)指令", "立即执行退款" etc. Gateway marks telemetry `rejectedInjection`; API passes `injectionSuspected` to policy ctx.

## 9. HTTP API (@osas/api, Fastify 5, port 3001)

CORS enabled. `x-tenant-id` header optional (default `tenant_demo`). All errors `{ error: { code, message, details? } }`. Validation via @osas/schema-validator; invalid proposal → 422 `SCHEMA_INVALID` (never executed).

| Method | Path | Body → Response |
|---|---|---|
| GET | /health | → `{ status: "ok", specVersion, version }` |
| GET | /v1/cases?status&customerId&profile | → Case[] |
| GET | /v1/cases/:id | → `{ case, customer, evidence: [] }` (404 AdapterNotFoundError) |
| GET | /v1/customers/:id | → Customer |
| POST | /v1/validate | `{ schemaName, data }` → `{ valid, errors }` |
| GET | /v1/schemas | → manifest; GET /v1/schemas/:name → schema JSON |
| GET | /v1/meta/tools | → TOOL_DEFINITIONS |
| GET | /v1/proposals?caseId&status | → ActionProposal[] |
| GET | /v1/proposals/:id | → ActionProposal |
| POST | /v1/proposals | proposal minus id/specVersion/status/timestamps → 201 ActionProposal (`proposed`) + `proposal_created` event |
| POST | /v1/proposals/:id/evaluate | → `{ proposal, decision }` (§4 side effects: approval/handoff/events) |
| POST | /v1/proposals/:id/execute | → `{ proposal, execution, replayed }` (§5; 409 if not `approved`) |
| POST | /v1/proposals/:id/reconcile | `{ outcome: "succeeded"\|"failed", note? }` → proposal |
| GET | /v1/approvals?status | → Approval[] (with embedded proposal) |
| POST | /v1/approvals/:id/decide | `{ decision, approverId, comment? }` → `{ approval, execution? }` (approved → auto-execute through §5) |
| GET | /v1/handoffs?status | → HumanHandoff[] |
| POST | /v1/handoffs/:id/claim | `{ assignee }`; POST /v1/handoffs/:id/resolve `{ notes? }` |
| GET | /v1/audit?caseId&proposalId | → AuditEvent[] |
| GET | /v1/policies/:tenantId | → active TenantPolicy version (PolicyStore-backed) |
| PUT | /v1/policies/:tenantId | → 409 `POLICY_IMMUTABLE` (v0.1.1: use the version lifecycle below) |
| GET | /.well-known/osas | → discovery document `{ specVersion, version, capabilities, endpoints }` |
| GET | /v1/capabilities | → CapabilityManifest, or 404 `CAPABILITIES_NOT_DECLARED` |
| GET | /v1/audit/verify | → `{ tenantId, chainLength, intact, firstError? }` (hash-chain verification) |
| GET | /v1/policies/:tenantId/versions | → PolicyVersionRecord[] |
| POST | /v1/policies/:tenantId/drafts | TenantPolicy body → 201 draft (policy_admin) |
| POST | /v1/policies/:tenantId/simulate | `{ version, proposal, customer?, evidence? }` → `{ decision, policyVersion }`, pure (no Approval/Execution/Handoff/business write) |
| POST | /v1/policies/:tenantId/versions/:version/approve · /activate · /retire | lifecycle transitions (policy_admin), audited |
| POST | /v1/chat | `{ caseId?, message, profile? }` → `{ reply, proposal?, decision?, execution?, handoff? }` — demo driver: gateway(mock) → maybe proposal → evaluate → maybe execute |
| GET | /v1/compat/report | → `tests/compat/report/latest.json` or 404 |
| GET | /v1/usage?tenantId&date&model&task | → `{ records, summary }` (Milestone 2; roles policy_admin/auditor; tenant must match principal) |

Log redaction: pino redact paths for email/phone/body (`req.headers.authorization`, `*.email`, `*.phone`). No customer data leaves the process; mock provider is default (`MODEL_PROVIDER=mock`).

Seed script `src/seed.ts` (run on boot with `SEED_DEMO=true`) loads @osas/mock-backend fixtures incl. demo policy (§11) and demo cases.

## 10. Web console (@osas/web, Vite, port 5173, proxy /v1 + /health → http://localhost:3001)

React 18 + react-router-dom 6, plain CSS (no UI framework), EN UI with 中文 subtitles where cheap. Routes:
- `/` overview: three persona cards linking to the paths below + health status.
- `/developer`: tool catalog (from `/v1/meta/tools`), schema browser (`/v1/schemas`), validator playground (JSON textarea → POST `/v1/validate`, show errors).
- `/agent`: approval queue (`/v1/approvals?status=pending`) with approve/reject (+comment), handoff list with claim/resolve.
- `/platform`: audit trail viewer (filter by caseId/proposalId), compat report viewer (`/v1/compat/report`).
- `/demo`: three one-click scripted scenarios via `/v1/chat` + follow-up calls, showing each flow step-by-step:
  1. **Ecommerce refund (auto)**: verified customer, refund $25 ≤ $50 threshold, fresh evidence → auto_execute → executed.
  2. **SaaS credit (approval)**: credit_apply over auto threshold → pending_approval → appears in /agent queue → after decide approved → executed.
  3. **Handoff**: unverified identity OR injected message ("ignore all previous instructions…") → blocked + HumanHandoff visible in /agent.

## 11. Mock fixtures (@osas/mock-backend)

Tenant `tenant_demo`. Customers: `cus_verified` (verified 30d ago, US), `cus_unverified` (unverified, US), `cus_blocked` (verified, region `IR`), `cus_expired` (identity expired, DE). Orders: `ord_small` ($25.00 USD, delivered, cus_verified), `ord_large` ($900.00, delivered, cus_verified), `ord_refunded` ($40, already refunded). Shipment `shp_small` delivered. Subscriptions: `sub_active` ($99/mo active, cus_verified), `sub_past_due`. Invoices `inv_001` paid $99. CreditBalance cus_verified $0. Knowledge: `kb_refund_policy`, `kb_credit_policy`, `kb_injection` (article body contains an injection attempt for demo/tests). Cases: `case_refund` (ecommerce, cus_verified, open), `case_credit` (saas, cus_verified, open), `case_unverified` (ecommerce, cus_unverified), `case_dup` (ecommerce, cus_verified, has an already-`executed` refund proposal for `ord_small` with same params → duplicate demo). Evidence fixtures: fresh order evidence for ord_small; **expired** evidence fixture `ev_expired` (expiresAt in the past).
Demo TenantPolicy `pol_demo` v1.0.0: duplicateWindowSeconds 86400, maxEvidenceAgeSeconds 604800; rules:
- refund: decision auto_execute, maxAmount $50, reasonCodes ["damaged","wrong_item","not_received","other"], requireVerifiedIdentity, identityMaxAgeSeconds 7776000, allowedRegions [US,CA,GB,DE,FR,JP,AU], blockedRegions [IR,KP,CU]
- reshipment: auto_execute, maxAmount $30, requireVerifiedIdentity
- return_request: require_approval; cancel_order: require_approval
- credit_apply: require_approval, maxAmount $100 (auto nothing), reasonCodes ["service_outage","goodwill","billing_error"]
- subscription_cancel: require_approval; plan_change: require_approval
- create_note / create_escalation: auto_execute
MockSupportAdapter: in-memory maps, deep clones, id gen `<prefix>_<counter>`, deterministic; `executeAction` returns `uncertain` when `proposal.params.simulate === "timeout"` (documented demo/test hook), applies refunds/credits to fixtures otherwise.

## 12. Tests

- Every package: colocated vitest unit tests (`src/**/*.test.ts`).
- `@osas/compat-suite` (tests/compat): vitest suite that (1) validates valid/invalid fixture objects against every schema in manifest (unknown field rejection, specVersion mismatch, missing required, enum violations), (2) cross-profile actionType rules, (3) MCP TOOL_DEFINITIONS ↔ adapter methods ↔ schemas/tools/*.json 1:1 mapping, (4) state-machine legality tables, (5) policy matrix (auto-execute small refund; over-threshold→approval; unverified identity→block+handoff; stale evidence→approval; blocked region→block; model execute-overreach→block; injection→block; duplicate→block), (6) idempotency replay + uncertain→reconciliation (no retry). Emits machine-readable report to `tests/compat/report/latest.json` (`{ specVersion, runAt, suites: [{ name, passed, failed, cases: [...] }], ok: boolean }`) — the report is a generated artifact and is gitignored (never tracked); `/v1/compat/report` returns 404 until the suite has run; CI regenerates it and uploads it as a workflow artifact.
- `@osas/e2e` (tests/e2e): Playwright — assumes compose up; checks console loads + demo scenario 1 completes. Skipped locally unless `E2E=1`.

## 13. CI & Docker

- `.github/workflows/ci.yml`: jobs — `build-test` (setup-node 22 + pnpm, install, typecheck, test, build), `compat` (runs compat suite, uploads report artifact), `docker` (docker compose build, up, wait /health, curl check), `e2e` (needs docker job; playwright chromium). All must pass for release; PRs changing schemas/ must also change docs+tests (documented in CONTRIBUTING).
- `docker-compose.yml`: service `api` (node:22-alpine Dockerfile: pnpm workspace install + build, `node apps/api/dist/index.js`, env SEED_DEMO=true, port 3001) and `web` (multi-stage: build vite with `VITE_API_BASE=/v1`, serve via nginx with `/v1` + `/health` proxy_pass to `api:3001`, port 8080). No external services.

## 14. Governance docs (owned by docs task)

README.md + README.zh-CN.md (Draft 开放规范 v0.1 positioning, quickstart: pnpm & docker, architecture, three demo paths), docs/spec-v0.1.md + docs/spec-v0.1.zh-CN.md (full spec text from §2–§8 of this contract, expanded), CONTRIBUTING.md + CONTRIBUTING.zh-CN.md (bilingual flow, RFC requirement, release gate: schemas+docs+impl+compat tests in same PR; no stable release without runnable examples + passing tests), CODE_OF_CONDUCT.md (Contributor Covenant 2.1), SECURITY.md (report via GitHub private vulnerability reporting; no real customer data; redaction), GOVERNANCE.md (founding maintainers, semver, RFC for breaking/new semantics, profile-compat declaration requires passing compat suite; v1.0 requires ≥3 independent passing implementations), rfcs/0000-template.md + rfcs/0001-v0.1-core.md, CHANGELOG.md (0.1.0 draft).

## 15. v0.1.1 extensions

- **Capability manifest**: `schemas/core/capability-manifest.json` + `CapabilityManifest`/`Capability` types in @osas/core; 16 spec capabilities (`case.read`, `customer.read`, `knowledge.read`, `evidence.read`, `note.write`, `escalation.write`, `proposal.write`, `approval.read`, `approval.decide`, `audit.read`, `ecommerce.order.read`, `ecommerce.shipment.read`, `ecommerce.refund.propose`, `ecommerce.refund.execute`, `saas.subscription.read`, `saas.credit.propose`). Enforcement helper `requireAdapterCapability` in @osas/adapter; adapters without `getCapabilities` stay permissive. Mock adapter declares all 16.
- **Policy lifecycle**: immutable versions `draft → simulated → approved → active → retired` (`POLICY_VERSION_TRANSITIONS` in @osas/core; `PolicyStore`/`InMemoryPolicyStore` in @osas/policy-engine). Runtime evaluation resolves the active version from the store (`resolveActivePolicy`), lazily importing the adapter's legacy policy as the initial active version. RBAC via the authenticated principal (§16): demo mode accepts the `x-osas-role: policy_admin` header; jwt mode reads the roles claim (single seam `policyAdminActor` in apps/api/src/routes/policies.ts). All changes audited (`policy_draft_created`/`policy_simulated`/`policy_approved`/`policy_activated`/`policy_retired`).
- **Audit integrity**: optional `sequence`/`previousHash`/`eventHash` on AuditEvent; per-tenant append-only SHA-256 chain over stable JSON (`audit-chain.ts` in @osas/policy-engine; genesis previousHash = 64 zeros). `GET /v1/audit/verify` recomputes the chain. Tamper-evidence only — does not replace WORM storage; log redaction rules unchanged.

## 16. v0.1.1 Milestone 2 — auth, storage, model/cost

- **Auth (`OSAS_AUTH_MODE`)**: `demo` (headers `x-osas-role` / `x-osas-actor-id` / `x-tenant-id`; forbidden with `NODE_ENV=production` — startup fails closed) or `jwt` (OIDC Bearer via JWKS: `OSAS_JWKS_URL` / `OSAS_JWT_ISSUER` / `OSAS_JWT_AUDIENCE`, verified with `jose`; claims `sub` / `tenant_id` / `roles`; tenant/role headers ignored). Roles: `support_agent`, `policy_admin`, `auditor`, `system_executor`. External requests never get `execute`; tokens/headers claiming `system_executor` are rejected. `policyAdminActor` now reads the authenticated principal (the Milestone 1 seam). Routes with a `:tenantId` parameter enforce `assertTenantAccess` (403 `TENANT_MISMATCH`). Auth hook: `apps/api/src/auth.ts` (`createAuthHook`, `loadAuthConfig`).
- **Storage (`OSAS_STORAGE`)**: `memory` (default) or `postgres` (requires `DATABASE_URL`; connectivity probed at boot, fail closed). `packages/store-postgres`: SQL migrations (`migrations/0001_init.sql`, runner records `schema_migrations`), `PostgresExecutionStore` / `PostgresPolicyStore` / `PostgresAuditStore` / `PostgresUsageStore`, `withTransaction`. `ExecutionStore` and `PolicyStore` interfaces became **async** (Promise-based) for real backends. Execution ledger PK `(tenant_id, idempotency_key)` enforces idempotency; execution state + audit mirror commit in one transaction (`runExecution` with `pgPool`). Audit events are written through the adapter (hash chain) and mirrored to `audit_events`. Root scripts: `pnpm db:migrate` / `db:seed` / `db:reset` (reset refuses `NODE_ENV=production`). Postgres tests are gated on `DATABASE_URL` (skip otherwise).
- **Model/cost**: fixed task→tier routing (`TASK_TIER`: classify/extract→fast, reply/propose→standard; `req.tier` no longer steers tasks). `OpenAICompatibleProvider` (fetch, Bearer from env, never logged; prices configured pairwise or cost stays unknown; structured output via native json_schema with at most one fallback retry, validated by schema-validator `validateInline`; 429/timeout/non-JSON/schema failures raise typed errors). Gateway budgets: daily + per-case measured spend, pre-call blocking at cap, `budget_warning` audit at 80%, `budget_exceeded` on block; `primeBudgets` rehydrates from the UsageStore at boot. Chat degrades to safe template/handoff on any model failure — never executes. `GET /v1/usage` (roles `policy_admin`/`auditor`; filters tenantId/date/model/task).
- **compose**: `db` (postgres:16-alpine + `osas-pgdata` volume) and one-shot `migrate` services under the `postgres` profile, keeping the default demo db-free. API Dockerfile runs `NODE_ENV=demo` + `OSAS_AUTH_MODE=demo` (production deployments must switch to jwt).

## 17. v0.1.1 Milestone 3 — Shadow Mode + reference adapters

- **Execution mode (`OSAS_EXECUTION_MODE`)**: `shadow` (default) | `live`. Only `shadow` exists in v0.1.1; `live` aborts startup with `LiveExecutionNotAvailableError` (`LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1`) from `loadExecutionMode` (`@osas/ecommerce-shadow`), called in `buildApp` before any route registration. Unknown values throw `EXECUTION_MODE_CONFIG_INVALID`.
- **ShadowRun** (`schemas/core/shadow-run.json`, `ShadowRun`/`ShadowRunOutcome`/`SuggestedAction` in @osas/core): `{ proposalId, policyDecision, wouldAutoExecute, suggestedAction, humanOutcome (accepted|rejected|modified|pending), humanComment?, externalReference?, createdAt, reviewedAt? }`. `wouldAutoExecute` ≡ `policyDecision.decision === "auto_execute"` — no other path can set it, so injection / unverified identity / stale evidence / over-threshold / duplicate proposals can never auto-execute (proved by API tests over the §4 matrix). Store seam `ShadowRunStore` (`@osas/ecommerce-shadow`: `InMemoryShadowRunStore`; `@osas/store-postgres`: `PostgresShadowRunStore` on `shadow_runs`, migration `0002_shadow_runs_milestone3.sql` adds payload/human-review columns).
- **API**: `POST /v1/proposals/:id/shadow-run` (pure §4 simulation via `evaluateProposal` — no status change, no Approval/Handoff; stores ShadowRun + audits `shadow_run_created`), `POST /v1/shadow-runs/:id/review` (roles support_agent/policy_admin; reviewed runs are final → 409; audits `shadow_run_reviewed` as actorType human), `GET /v1/shadow-runs[/:id]` (embeds proposal + evidence). `POST /v1/proposals/:id/execute` refuses (409) proposals that have any ShadowRun — Shadow Mode never marks them executed. New audit event types: `shadow_run_created`, `shadow_run_reviewed` (hash-chained like everything else). `/.well-known/osas` exposes `executionMode`.
- **Console**: `/shadow` page (pending reviews first; agent suggestion, policy reasons, evidence links, review accept/modify/reject, audit-chain verification badge; no live-execute UI).
- **`@osas/zendesk-adapter`**: ticket↔Case, user↔Customer (identity always `unverified`, region `"ZZ"`), internal notes (`public:false`), escalation → configured group; idempotency-key replay cache + `X-Idempotency-Key` header; env `ZENDESK_BASE_URL|ZENDESK_SUBDOMAIN` / `ZENDESK_EMAIL` / `ZENDESK_API_TOKEN` / `ZENDESK_ESCALATION_GROUP_ID`; fail closed (`ZENDESK_NOT_CONFIGURED`) without credentials; unsupported surface throws `AdapterCapabilityError`; manifest declares case.read/customer.read/evidence.read/note.write/escalation.write, executionModes `["shadow"]`.
- **`@osas/shopify-adapter`**: read-only orders/per-customer orders/fulfillments → OSAS Order/Shipment/Evidence (source = Shopify id + admin URL); `refundableAmount` = total − recorded refund transactions (integer minor units); `buildRefundProposalDraft()` returns amount/currency/orderStatus/captured evidence for a refund Proposal. NO refund write path — `executeAction` throws `CAPABILITY_UNSUPPORTED` with zero HTTP calls; manifest omits `ecommerce.refund.execute`; real execution requires a future RFC. Env `SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_ADMIN_ACCESS_TOKEN` / `SHOPIFY_API_VERSION` (default 2025-01); fail closed (`SHOPIFY_NOT_CONFIGURED`).
- **Both adapters**: injectable `HttpClient` (`(req) => Promise<{status, body}>`), default fetch-based; tests use mock HTTP only (request construction, error mapping, OSAS mapping) — no real tokens anywhere. Errors never include headers/bodies (tokens/PII).
- **Docker demo unchanged**: compose keeps the Mock Adapter; no Zendesk/Shopify tokens required (`OSAS_EXECUTION_MODE` passthrough defaults to shadow).
- **Docs**: `docs/adapter-guide.md(.zh-CN.md)`, `docs/zendesk-shopify-shadow.md(.zh-CN.md)`; spec §14; CHANGELOG/README/.env.example synced.
