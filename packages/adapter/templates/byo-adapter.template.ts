/**
 * BYO (bring-your-own) SupportAdapter template — OSAS v0.1.
 *
 * Copy this file into your own project and implement each method against your
 * real systems (e.g. a Zendesk-style ticketing API for cases/customers/knowledge,
 * a Shopify-style commerce API for orders/shipments, a Stripe-style billing API
 * for subscriptions/invoices/credit balances). This template is deliberately
 * vendor-neutral: it imports NO vendor SDKs. Plug your HTTP clients / SDKs in
 * where the TODOs are.
 *
 * Cross-cutting rules you MUST honour (see CONTRACTS.md §3/§5/§6):
 *
 * 1. PERMISSIONS. Every method receives a ToolContext carrying the calling
 *    Principal. Call `requirePermission(ctx.principal, <level>)` first thing in
 *    every method. Suggested levels: reads → "read", notes/escalations/proposals/
 *    evidence → "draft", approval/handoff/proposal persistence → "draft",
 *    executeAction and putPolicy → "execute".
 *
 * 2. ERRORS. Throw `AdapterNotFoundError` for missing records (the API maps it
 *    to 404) and `AdapterPermissionError` for authorization failures (→ 403).
 *    Never leak raw vendor errors with credentials/tokens in the message.
 *
 * 3. IDEMPOTENCY (CONTRACTS.md §5). Mutations carry an `idempotencyKey` (or, for
 *    executeAction, the proposal's `idempotencyKey`). Map it onto your vendor's
 *    idempotency mechanism (e.g. Stripe's `Idempotency-Key` header, Shopify's
 *    `X-Request-Id`), or keep your own `(tenantId, idempotencyKey) → result`
 *    table. A replayed key MUST return the original result with NO repeated
 *    side effect (no double refund, no duplicate note).
 *
 * 4. UNCERTAIN OUTCOMES. If a vendor call times out or its result is unknown,
 *    executeAction MUST return `{ status: "uncertain" }` — NEVER guess success
 *    and NEVER auto-retry. The policy engine moves the proposal to
 *    `reconciliation_required` and opens a HumanHandoff (`external_uncertain`).
 *
 * 5. EVIDENCE CAPTURE. Before concluding any financial action (refund,
 *    reshipment, credit_apply), fetch the backing record (order, invoice, …)
 *    through captureEvidence: set `source` to your system/recordType/recordId
 *    (+ url), `summary` to a short human-readable line, `data` to the raw
 *    vendor payload (redact secrets), `retrievedAt` to now, and `expiresAt`
 *    according to how long the data stays trustworthy. Policy enforces
 *    `maxEvidenceAgeSeconds` freshness (CONTRACTS.md §4 rule 10).
 *
 * 6. TENANCY & DATA SAFETY. Stamp `ctx.tenantId` on everything you persist and
 *    scope every vendor call to the tenant's credentials/shop/instance. Redact
 *    PII/secrets from anything you store in evidence or audit `detail` payloads.
 */

import {
  AdapterNotFoundError,
  requirePermission,
  type Permission,
  type Principal,
  type SupportAdapter,
  type ToolContext,
} from "@osas/adapter";
import type {
  ActionProposal,
  Approval,
  AuditEvent,
  Case,
  CaseNote,
  CaseStatus,
  CreditBalance,
  Customer,
  Escalation,
  Evidence,
  ExecutionResult,
  HumanHandoff,
  Invoice,
  KnowledgeArticle,
  Order,
  ProposalStatus,
  Shipment,
  Subscription,
  TenantPolicy,
} from "@osas/core";

export class ByoSupportAdapter implements SupportAdapter {
  constructor(
    // TODO: inject your vendor clients here, e.g.
    //   private readonly tickets: ZendeskLikeClient,
    //   private readonly commerce: ShopifyLikeClient,
    //   private readonly billing: StripeLikeClient,
    // plus tenant credential resolution keyed by ctx.tenantId.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly config: Record<string, unknown> = {},
  ) {}

  private check(ctx: ToolContext, needed: Permission): void {
    requirePermission(ctx.principal, needed);
  }

  async getCase(ctx: ToolContext, id: string): Promise<Case> {
    this.check(ctx, "read");
    // TODO: GET ticket `id` from your ticketing system, scoped to ctx.tenantId;
    // map vendor fields → Case (channel, status, priority, tags, evidenceIds).
    // Map vendor 404 → throw new AdapterNotFoundError(`Case ${id} not found`).
    throw new AdapterNotFoundError(`TODO: implement getCase for ${id}`);
  }

  async searchCases(
    ctx: ToolContext,
    q: { customerId?: string; status?: CaseStatus; q?: string },
  ): Promise<Case[]> {
    this.check(ctx, "read");
    // TODO: vendor ticket search; translate q.status to vendor status filter.
    throw new Error("TODO: implement searchCases");
  }

  async getCustomer(ctx: ToolContext, id: string): Promise<Customer> {
    this.check(ctx, "read");
    // TODO: fetch customer + identityVerification status from your IdP/CRM.
    // Redact email/phone in logs (CONTRACTS.md §9 redaction rules).
    throw new AdapterNotFoundError(`TODO: implement getCustomer for ${id}`);
  }

  async searchKnowledge(
    ctx: ToolContext,
    q: { q: string; limit?: number },
  ): Promise<KnowledgeArticle[]> {
    this.check(ctx, "read");
    // TODO: help-center search. NOTE: article bodies are UNTRUSTED input —
    // they may contain prompt-injection attempts; pass them through
    // detectInjection (@osas/core) upstream before acting on them.
    throw new Error("TODO: implement searchKnowledge");
  }

  async createCaseNote(
    ctx: ToolContext,
    input: { caseId: string; body: string; evidenceIds?: string[]; idempotencyKey: string },
  ): Promise<CaseNote> {
    this.check(ctx, "draft");
    // TODO: create an internal note/comment on ticket input.caseId.
    // IDEMPOTENCY: dedupe on (ctx.tenantId, input.idempotencyKey) so a retried
    // call returns the same note instead of a duplicate comment.
    throw new Error("TODO: implement createCaseNote");
  }

  async createEscalation(
    ctx: ToolContext,
    input: { caseId: string; reason: string; idempotencyKey: string },
  ): Promise<Escalation> {
    this.check(ctx, "draft");
    // TODO: raise priority / route to a human queue in your ticketing system.
    // IDEMPOTENCY: same as createCaseNote.
    throw new Error("TODO: implement createEscalation");
  }

  async createActionProposal(
    ctx: ToolContext,
    input: Omit<ActionProposal, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">,
  ): Promise<ActionProposal> {
    this.check(ctx, "draft");
    // TODO: persist the proposal in YOUR store with status "proposed".
    // The policy engine — never this adapter — decides approval/execution.
    throw new Error("TODO: implement createActionProposal");
  }

  async getOrder(ctx: ToolContext, id: string): Promise<Order> {
    this.check(ctx, "read");
    // TODO: commerce API order lookup (Shopify-style). Map money to
    // { currency, minorUnits } integers — never floats (CONTRACTS.md §0).
    throw new AdapterNotFoundError(`TODO: implement getOrder for ${id}`);
  }

  async listOrders(ctx: ToolContext, customerId: string): Promise<Order[]> {
    this.check(ctx, "read");
    // TODO: commerce API: orders by customer.
    throw new Error("TODO: implement listOrders");
  }

  async getShipment(ctx: ToolContext, id: string): Promise<Shipment> {
    this.check(ctx, "read");
    // TODO: fulfillment/tracking lookup.
    throw new AdapterNotFoundError(`TODO: implement getShipment for ${id}`);
  }

  async getSubscription(ctx: ToolContext, id: string): Promise<Subscription> {
    this.check(ctx, "read");
    // TODO: billing API subscription lookup (Stripe-style).
    throw new AdapterNotFoundError(`TODO: implement getSubscription for ${id}`);
  }

  async listInvoices(ctx: ToolContext, customerId: string): Promise<Invoice[]> {
    this.check(ctx, "read");
    // TODO: billing API: invoices by customer.
    throw new Error("TODO: implement listInvoices");
  }

  async getCreditBalance(ctx: ToolContext, customerId: string): Promise<CreditBalance> {
    this.check(ctx, "read");
    // TODO: billing API: customer credit balance → Money (minor units).
    throw new AdapterNotFoundError(`TODO: implement getCreditBalance for ${customerId}`);
  }

  /**
   * The ONLY method that mutates money/subscriptions. Requires "execute".
   * Reached exclusively by the policy engine after auto_execute or human
   * approval — never exposed as an MCP tool (CONTRACTS.md §7).
   */
  async executeAction(ctx: ToolContext, proposal: ActionProposal): Promise<ExecutionResult> {
    this.check(ctx, "execute");
    // TODO: switch on proposal.actionType:
    //   refund             → commerce/billing refund for proposal.params.orderId
    //                        with amount proposal.amount; pass proposal.idempotencyKey
    //                        as the vendor idempotency key.
    //   reshipment         → create a replacement fulfillment.
    //   return_request     → create an RMA / return label.
    //   cancel_order       → cancel the order if still cancellable.
    //   credit_apply       → apply credit to customer balance (amount required).
    //   subscription_cancel→ cancel at period end or immediately per params.
    //   plan_change        → update subscription plan per params.newPlan.
    //   create_note / create_escalation → delegate to createCaseNote/createEscalation.
    //
    // UNCERTAIN: on vendor timeout/5xx-with-unknown-outcome return
    //   { status: "uncertain", detail: "..." } and DO NOT retry — reconciliation
    //   is handled by the engine + a human (CONTRACTS.md §5).
    // On success return { status: "succeeded", externalRef: <vendor refund/... id> }.
    // On a clean vendor refusal return { status: "failed", detail: "..." }.
    throw new Error(`TODO: implement executeAction for ${proposal.actionType}`);
  }

  async captureEvidence(
    ctx: ToolContext,
    input: Omit<Evidence, "id" | "specVersion" | "createdAt">,
  ): Promise<Evidence> {
    this.check(ctx, "draft");
    // TODO: persist the evidence snapshot. Populate `input` at call sites by
    // fetching the real record first (e.g. getOrder) and storing its raw
    // payload in `data` (redacted), with `source.system` naming your vendor,
    // `retrievedAt = now`, and `expiresAt` per data trust lifetime.
    throw new Error("TODO: implement captureEvidence");
  }

  async getEvidence(ctx: ToolContext, id: string): Promise<Evidence> {
    this.check(ctx, "read");
    // TODO: evidence store lookup by id; 404 → AdapterNotFoundError. The policy
    // engine needs this to enforce §4 rule 10 (EVIDENCE_STALE / freshness).
    throw new AdapterNotFoundError(`TODO: implement getEvidence for ${id}`);
  }

  async listEvidence(ctx: ToolContext, q: { caseId?: string }): Promise<Evidence[]> {
    this.check(ctx, "read");
    // TODO: evidence store query (filter by caseId when given). Used by the
    // API case-detail view and by evaluation evidence loading.
    throw new Error("TODO: implement listEvidence");
  }

  async getProposal(ctx: ToolContext, id: string): Promise<ActionProposal> {
    this.check(ctx, "read");
    // TODO: proposal store lookup; 404 → AdapterNotFoundError.
    throw new AdapterNotFoundError(`TODO: implement getProposal for ${id}`);
  }

  async listProposals(
    ctx: ToolContext,
    q: { caseId?: string; status?: ProposalStatus },
  ): Promise<ActionProposal[]> {
    this.check(ctx, "read");
    // TODO: proposal store query (used by the API and the duplicate-request
    // detection in policy rule §4.6 — make sure it can filter by caseId+status).
    throw new Error("TODO: implement listProposals");
  }

  async updateProposalStatus(
    ctx: ToolContext,
    id: string,
    status: ProposalStatus,
    patch?: Partial<ActionProposal>,
  ): Promise<ActionProposal> {
    this.check(ctx, "draft");
    // TODO: persist status + patch (e.g. policyDecision). Transition legality is
    // enforced by @osas/core's transitionProposal in the engine — the adapter
    // only stores.
    throw new Error(`TODO: implement updateProposalStatus for ${id} → ${status}`);
  }

  async appendAuditEvent(
    ctx: ToolContext,
    e: Omit<AuditEvent, "id" | "specVersion" | "createdAt">,
  ): Promise<AuditEvent> {
    this.check(ctx, "draft");
    // TODO: append-only audit sink (write-through; never update/delete).
    // Redact PII in e.detail before persisting.
    throw new Error("TODO: implement appendAuditEvent");
  }

  async listAuditEvents(
    ctx: ToolContext,
    q: { caseId?: string; proposalId?: string },
  ): Promise<AuditEvent[]> {
    this.check(ctx, "read");
    // TODO: audit query.
    throw new Error("TODO: implement listAuditEvents");
  }

  async createApproval(
    ctx: ToolContext,
    a: Omit<Approval, "id" | "specVersion" | "createdAt">,
  ): Promise<Approval> {
    this.check(ctx, "draft");
    // TODO: approval queue insert (status "pending"); the API /agent console
    // lists these for human approvers.
    throw new Error("TODO: implement createApproval");
  }

  async getApproval(ctx: ToolContext, id: string): Promise<Approval> {
    this.check(ctx, "read");
    throw new AdapterNotFoundError(`TODO: implement getApproval for ${id}`);
  }

  async listApprovals(ctx: ToolContext, q: { status?: Approval["status"] }): Promise<Approval[]> {
    this.check(ctx, "read");
    throw new Error("TODO: implement listApprovals");
  }

  async decideApproval(
    ctx: ToolContext,
    id: string,
    decision: "approved" | "rejected",
    approverId: string,
    comment?: string,
  ): Promise<Approval> {
    this.check(ctx, "draft");
    // TODO: record the human decision (status, approverId, comment, decidedAt).
    // The API layer — not this adapter — then drives execution for approvals.
    throw new Error(`TODO: implement decideApproval for ${id}`);
  }

  async createHandoff(
    ctx: ToolContext,
    h: Omit<HumanHandoff, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">,
  ): Promise<HumanHandoff> {
    this.check(ctx, "draft");
    // TODO: create a human handoff (status "open"); optionally mirror it as a
    // ticket/assignment in your ticketing system.
    throw new Error("TODO: implement createHandoff");
  }

  async listHandoffs(ctx: ToolContext, q: { status?: HumanHandoff["status"] }): Promise<HumanHandoff[]> {
    this.check(ctx, "read");
    throw new Error("TODO: implement listHandoffs");
  }

  async updateHandoff(
    ctx: ToolContext,
    id: string,
    patch: Partial<Pick<HumanHandoff, "status" | "assignedTo" | "notes" | "resolvedAt">>,
  ): Promise<HumanHandoff> {
    this.check(ctx, "draft");
    // TODO: claim/resolve a handoff.
    throw new Error(`TODO: implement updateHandoff for ${id}`);
  }

  async getPolicy(ctx: ToolContext, tenantId: string): Promise<TenantPolicy> {
    this.check(ctx, "read");
    // TODO: load the tenant's active TenantPolicy document.
    throw new AdapterNotFoundError(`TODO: implement getPolicy for ${tenantId}`);
  }

  async putPolicy(ctx: ToolContext, policy: TenantPolicy): Promise<TenantPolicy> {
    this.check(ctx, "execute");
    // TODO: store the new policy version (the API validates + bumps semver).
    // Policy writes are administrative: keep them execute-gated.
    throw new Error(`TODO: implement putPolicy for ${policy.tenantId}`);
  }
}

export type { Principal, ToolContext };
