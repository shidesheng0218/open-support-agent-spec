import type {
  ActionProposal,
  Approval,
  AuditEvent,
  CapabilityManifest,
  Case,
  CaseNote,
  CaseStatus,
  CreditBalance,
  Customer,
  Escalation,
  Evidence,
  ExchangeInventoryStatus,
  ExchangeRequest,
  ExecutionResult,
  HumanHandoff,
  Invoice,
  ItemClaim,
  ItemClaimType,
  KnowledgeArticle,
  Money,
  Order,
  ProposalStatus,
  RefundTransaction,
  Shipment,
  ShipmentIncident,
  Subscription,
  TenantPolicy,
} from "@osas/core";

// Permission ladder per CONTRACTS.md §3: read < draft < request-approval < execute.
// Defined identically to @osas/core's Permission (structurally interchangeable).
export type Permission = "read" | "draft" | "request-approval" | "execute";

/**
 * Read-only exchange-eligibility check (v0.2 Phase 6). An adapter answers
 * whether a proposed exchange is fulfillable: replacement stock and the price
 * delta. `eligible` must be false whenever inventoryStatus is not "in_stock" —
 * adapters fail closed and never guess eligibility.
 */
export interface ExchangeEligibility {
  eligible: boolean;
  inventoryStatus: ExchangeInventoryStatus;
  /** Replacement price minus original line price; integer minor units. */
  priceDelta?: Money;
  reason?: string;
}

export interface Principal {
  actorType: "model" | "human" | "system";
  actorId: string;
  permission: Permission;
}

export interface ToolContext {
  tenantId: string;
  principal: Principal;
}

/**
 * SupportAdapter — the single integration seam between OSAS and a real
 * support/commerce/billing stack (CONTRACTS.md §6). All model and API traffic
 * flows through this interface with an explicit Principal; models never hold
 * backend credentials.
 */
export interface SupportAdapter {
  getCase(ctx: ToolContext, id: string): Promise<Case>;
  searchCases(
    ctx: ToolContext,
    q: { customerId?: string; status?: CaseStatus; q?: string },
  ): Promise<Case[]>;
  getCustomer(ctx: ToolContext, id: string): Promise<Customer>;
  searchKnowledge(
    ctx: ToolContext,
    q: { q: string; limit?: number },
  ): Promise<KnowledgeArticle[]>;
  createCaseNote(
    ctx: ToolContext,
    input: { caseId: string; body: string; evidenceIds?: string[]; idempotencyKey: string },
  ): Promise<CaseNote>;
  createEscalation(
    ctx: ToolContext,
    input: { caseId: string; reason: string; idempotencyKey: string },
  ): Promise<Escalation>;
  createActionProposal(
    ctx: ToolContext,
    input: Omit<ActionProposal, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">,
  ): Promise<ActionProposal>;
  getOrder(ctx: ToolContext, id: string): Promise<Order>;
  listOrders(ctx: ToolContext, customerId: string): Promise<Order[]>;
  getShipment(ctx: ToolContext, id: string): Promise<Shipment>;
  /**
   * After-sales reads (v0.2 Phase 4, optional). Adapters that do not implement
   * them MUST NOT declare the corresponding capability; the MCP layer fails
   * such calls with CAPABILITY_UNSUPPORTED instead of faking a result.
   */
  getShipmentIncident?(ctx: ToolContext, id: string): Promise<ShipmentIncident>;
  /** All known refund transactions for an order (empty array when none). */
  getRefundStatus?(ctx: ToolContext, orderId: string): Promise<RefundTransaction[]>;
  /**
   * Record an ItemClaim with status "submitted" for human review (draft-level
   * permission). Never resolves the claim and never triggers a refund/exchange.
   */
  proposeItemClaim?(
    ctx: ToolContext,
    input: {
      caseId: string;
      orderId: string;
      lineId: string;
      claimType: ItemClaimType;
      quantity: number;
      reasonCode?: string;
      evidenceIds?: string[];
      idempotencyKey: string;
    },
  ): Promise<ItemClaim>;
  /**
   * After-sales reads (v0.2 Phase 6, optional). Read-only: an adapter answers
   * with evidence/eligibility data and never writes. Same declaration rule as
   * the Phase 4 methods above — undeclared capability → CAPABILITY_UNSUPPORTED.
   */
  /** Evidence records attached to a specific order line (e.g. damage photos). */
  getOrderLineClaimEvidence?(
    ctx: ToolContext,
    q: { orderId: string; lineId?: string },
  ): Promise<Evidence[]>;
  /** Read-only exchange-eligibility check; never creates or fulfills an exchange. */
  getExchangeEligibility?(
    ctx: ToolContext,
    input: { orderId: string; originalLineId: string; replacementSku: string },
  ): Promise<ExchangeEligibility>;
  /** Load one ExchangeRequest record by id (read-only). */
  getExchangeRequest?(ctx: ToolContext, id: string): Promise<ExchangeRequest>;
  getSubscription(ctx: ToolContext, id: string): Promise<Subscription>;
  listInvoices(ctx: ToolContext, customerId: string): Promise<Invoice[]>;
  getCreditBalance(ctx: ToolContext, customerId: string): Promise<CreditBalance>;
  /** Execute-permission only; NOT exposed as an MCP tool. */
  executeAction(ctx: ToolContext, proposal: ActionProposal): Promise<ExecutionResult>;
  captureEvidence(
    ctx: ToolContext,
    input: Omit<Evidence, "id" | "specVersion" | "createdAt">,
  ): Promise<Evidence>;
  /** Load one Evidence record by id (§4 rule 10 freshness checks). */
  getEvidence(ctx: ToolContext, id: string): Promise<Evidence>;
  listEvidence(ctx: ToolContext, q: { caseId?: string }): Promise<Evidence[]>;
  // Proposal persistence used by the API/engine (mock keeps in memory; BYO maps to real store).
  getProposal(ctx: ToolContext, id: string): Promise<ActionProposal>;
  listProposals(
    ctx: ToolContext,
    q: { caseId?: string; status?: ProposalStatus },
  ): Promise<ActionProposal[]>;
  updateProposalStatus(
    ctx: ToolContext,
    id: string,
    status: ProposalStatus,
    patch?: Partial<ActionProposal>,
  ): Promise<ActionProposal>;
  appendAuditEvent(
    ctx: ToolContext,
    e: Omit<AuditEvent, "id" | "specVersion" | "createdAt">,
  ): Promise<AuditEvent>;
  listAuditEvents(
    ctx: ToolContext,
    q: { caseId?: string; proposalId?: string },
  ): Promise<AuditEvent[]>;
  createApproval(
    ctx: ToolContext,
    a: Omit<Approval, "id" | "specVersion" | "createdAt">,
  ): Promise<Approval>;
  getApproval(ctx: ToolContext, id: string): Promise<Approval>;
  listApprovals(ctx: ToolContext, q: { status?: Approval["status"] }): Promise<Approval[]>;
  decideApproval(
    ctx: ToolContext,
    id: string,
    decision: "approved" | "rejected",
    approverId: string,
    comment?: string,
  ): Promise<Approval>;
  createHandoff(
    ctx: ToolContext,
    h: Omit<HumanHandoff, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">,
  ): Promise<HumanHandoff>;
  listHandoffs(ctx: ToolContext, q: { status?: HumanHandoff["status"] }): Promise<HumanHandoff[]>;
  updateHandoff(
    ctx: ToolContext,
    id: string,
    patch: Partial<Pick<HumanHandoff, "status" | "assignedTo" | "notes" | "resolvedAt">>,
  ): Promise<HumanHandoff>;
  getPolicy(ctx: ToolContext, tenantId: string): Promise<TenantPolicy>;
  putPolicy(ctx: ToolContext, policy: TenantPolicy): Promise<TenantPolicy>;
  /**
   * Optional capability provider (v0.1.1). Implementations that declare a
   * CapabilityManifest have it enforced: operations needing an undeclared
   * capability fail with AdapterCapabilityError (CAPABILITY_UNSUPPORTED).
   * Adapters without this method stay permissive for backward compatibility.
   */
  getCapabilities?(ctx: ToolContext): Promise<CapabilityManifest>;
}
