import {
  AdapterCapabilityError,
  AdapterNotFoundError,
  requirePermission,
  type ExchangeEligibility,
  type SupportAdapter,
  type ToolContext,
} from "@osas/adapter";
import type {
  ActionProposal,
  Approval,
  AuditEvent,
  Capability,
  CapabilityManifest,
  Case,
  CaseNote,
  CreditBalance,
  Customer,
  Escalation,
  Evidence,
  ExecutionResult,
  HumanHandoff,
  Invoice,
  KnowledgeArticle,
  Money,
  Order,
  OrderStatus,
  RefundTransaction,
  Shipment,
  ShipmentIncident,
  Subscription,
  TenantPolicy,
} from "@osas/core";
import { SPEC_VERSION } from "@osas/core";
import type { ShopifyConfig } from "./config.js";
import { ShopifyApiError } from "./errors.js";
import { createFetchHttpClient, type HttpClient, type HttpRequest } from "./http.js";
import {
  deriveShipmentIncident,
  fulfillmentEvidenceInput,
  mapShopifyFulfillment,
  mapShopifyOrder,
  mapShopifyRefundTransactions,
  orderEvidenceInput,
  orderIdForShopify,
  orderLineClaimEvidenceInput,
  parseShipmentId,
  parseShipmentIncidentId,
  refundEligibilityEvidenceInput,
  refundableAmount,
  shopifyCustomerIdFromOsas,
  shopifyOrderIdFromOsas,
  toMinorUnits,
  type ShopifyFulfillment,
  type ShopifyOrder,
} from "./mappers.js";

export interface ShopifyAdapterOptions {
  config: ShopifyConfig;
  /** Injectable HTTP client (tests); defaults to global fetch. */
  http?: HttpClient;
  adapterVersion?: string;
}

/** Everything a refund Proposal needs, priced from live read-only data. */
export interface RefundProposalDraft {
  orderId: string;
  orderStatus: OrderStatus;
  /** Refundable amount (total minus refunds already recorded). */
  amount: Money;
  currency: string;
  /** Captured Evidence records (order, fulfillments, refund eligibility). */
  evidence: Evidence[];
  params: { orderId: string };
}

const unsupported = (capability: Capability): never => {
  throw new AdapterCapabilityError(
    capability,
    `ShopifyAdapter does not implement '${capability}' — it is a read-only ` +
      "commerce source (orders, fulfillments, refund proposal drafts) with no " +
      "write path at all.",
  );
};

/**
 * Shopify reference adapter (v0.1.1 Milestone 3) — READ-ONLY by design.
 *
 * - Reads orders, per-customer orders and fulfillments, and converts them
 *   into OSAS Evidence (source = shopify order/fulfillment id + admin URL).
 * - buildRefundProposalDraft() prices a refund Proposal from live data:
 *   refundable amount, currency, order status and evidence.
 * - There is NO refund write path: executeAction always throws
 *   AdapterCapabilityError without making any HTTP call. Real refund
 *   execution requires a separate RFC before it may ever be added.
 * - Fail closed: missing credentials → ShopifyNotConfiguredError.
 */
export class ShopifyAdapter implements SupportAdapter {
  private readonly config: ShopifyConfig;
  private readonly http: HttpClient;
  private readonly adapterVersion: string;
  private readonly evidenceStore = new Map<string, Evidence>();
  private evidenceCounter = 0;

  constructor(options: ShopifyAdapterOptions) {
    this.config = options.config;
    this.http = options.http ?? createFetchHttpClient();
    this.adapterVersion = options.adapterVersion ?? "0.2.0";
  }

  private adminUrl(path: string): string {
    return `https://${this.config.shopDomain}/admin/api/${this.config.apiVersion}${path}`;
  }

  private async call<T>(req: Omit<HttpRequest, "url" | "headers"> & { path: string }): Promise<T> {
    const res = await this.http({
      method: req.method,
      url: this.adminUrl(req.path),
      headers: { "x-shopify-access-token": this.config.adminAccessToken },
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    if (res.status === 404) {
      throw new AdapterNotFoundError(`Shopify resource not found: ${req.method} ${req.path}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ShopifyApiError(res.status, `Shopify API ${req.method} ${req.path} → HTTP ${res.status}`);
    }
    return res.body as T;
  }

  private async fetchOrder(orderId: string): Promise<ShopifyOrder> {
    const res = await this.call<{ order: ShopifyOrder }>({
      method: "GET",
      path: `/orders/${orderId}.json`,
    });
    return res.order;
  }

  private async fetchFulfillments(orderId: string): Promise<ShopifyFulfillment[]> {
    const res = await this.call<{ fulfillments: ShopifyFulfillment[] }>({
      method: "GET",
      path: `/orders/${orderId}/fulfillments.json`,
    });
    return res.fulfillments ?? [];
  }

  // ---- supported: ecommerce reads -----------------------------------------

  async getOrder(ctx: ToolContext, id: string): Promise<Order> {
    requirePermission(ctx.principal, "read");
    return mapShopifyOrder(await this.fetchOrder(shopifyOrderIdFromOsas(id)), ctx.tenantId);
  }

  async listOrders(ctx: ToolContext, customerId: string): Promise<Order[]> {
    requirePermission(ctx.principal, "read");
    const shopifyCustomerId = shopifyCustomerIdFromOsas(customerId);
    const res = await this.call<{ orders: ShopifyOrder[] }>({
      method: "GET",
      path: `/orders.json?customer_id=${encodeURIComponent(shopifyCustomerId)}&status=any`,
    });
    return (res.orders ?? []).map((o) => mapShopifyOrder(o, ctx.tenantId));
  }

  /** id = "shopify_ship_{orderId}_{fulfillmentId}" (see shipmentIdFor). */
  async getShipment(ctx: ToolContext, id: string): Promise<Shipment> {
    requirePermission(ctx.principal, "read");
    const { orderId, fulfillmentId } = parseShipmentId(id);
    const fulfillments = await this.fetchFulfillments(orderId);
    const found = fulfillments.find((f) => String(f.id) === fulfillmentId);
    if (!found) {
      throw new AdapterNotFoundError(`Shopify fulfillment ${fulfillmentId} not found on order ${orderId}`);
    }
    return mapShopifyFulfillment(found, ctx.tenantId);
  }

  // ---- supported: evidence capture ------------------------------------------

  async captureEvidence(
    ctx: ToolContext,
    input: Omit<Evidence, "id" | "specVersion" | "createdAt">,
  ): Promise<Evidence> {
    requirePermission(ctx.principal, "draft");
    const evidence: Evidence = {
      ...structuredClone(input),
      id: `shopev_${++this.evidenceCounter}`,
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      createdAt: new Date().toISOString(),
    };
    this.evidenceStore.set(evidence.id, evidence);
    return structuredClone(evidence);
  }

  async getEvidence(ctx: ToolContext, id: string): Promise<Evidence> {
    requirePermission(ctx.principal, "read");
    const found = this.evidenceStore.get(id);
    if (!found || found.tenantId !== ctx.tenantId) {
      throw new AdapterNotFoundError(`Evidence ${id} not found for tenant ${ctx.tenantId}`);
    }
    return structuredClone(found);
  }

  async listEvidence(ctx: ToolContext, q: { caseId?: string }): Promise<Evidence[]> {
    requirePermission(ctx.principal, "read");
    return structuredClone(
      [...this.evidenceStore.values()].filter(
        (e) =>
          e.tenantId === ctx.tenantId && (q.caseId === undefined || e.caseId === q.caseId),
      ),
    );
  }

  /**
   * Price a refund Proposal from live, read-only Shopify data: loads the
   * order and its fulfillments, computes the refundable amount, and captures
   * order/shipment/refund-eligibility Evidence. This is the ONLY refund
   * surface in v0.2.0 — drafting a Proposal, never executing a refund.
   */
  async buildRefundProposalDraft(ctx: ToolContext, orderId: string): Promise<RefundProposalDraft> {
    requirePermission(ctx.principal, "read");
    const shopifyId = shopifyOrderIdFromOsas(orderId);
    const order = await this.fetchOrder(shopifyId);
    const fulfillments = await this.fetchFulfillments(shopifyId);
    const evidence: Evidence[] = [];
    evidence.push(await this.captureEvidence(ctx, orderEvidenceInput(order, ctx.tenantId, this.config.shopDomain)));
    for (const f of fulfillments) {
      evidence.push(
        await this.captureEvidence(ctx, fulfillmentEvidenceInput(f, ctx.tenantId, this.config.shopDomain)),
      );
    }
    evidence.push(
      await this.captureEvidence(ctx, refundEligibilityEvidenceInput(order, ctx.tenantId, this.config.shopDomain)),
    );
    const amount = refundableAmount(order);
    return {
      orderId: orderIdForShopify(order.id),
      orderStatus: mapShopifyOrder(order, ctx.tenantId).status,
      amount,
      currency: amount.currency,
      evidence,
      params: { orderId: String(order.id) },
    };
  }

  // ---- supported: after-sales reads (v0.2 Phase 6, GET only) ---------------

  /** All refund transactions Shopify has recorded for an order (read-only). */
  async getRefundStatus(ctx: ToolContext, orderId: string): Promise<RefundTransaction[]> {
    requirePermission(ctx.principal, "read");
    const order = await this.fetchOrder(shopifyOrderIdFromOsas(orderId));
    return mapShopifyRefundTransactions(order, ctx.tenantId);
  }

  /**
   * Read-only incident view derived from fulfillment state (see
   * deriveShipmentIncident). id = "shopify_inc_{orderId}_{fulfillmentId}".
   */
  async getShipmentIncident(ctx: ToolContext, id: string): Promise<ShipmentIncident> {
    requirePermission(ctx.principal, "read");
    const { orderId, fulfillmentId } = parseShipmentIncidentId(id);
    const fulfillments = await this.fetchFulfillments(orderId);
    const found = fulfillments.find((f) => String(f.id) === fulfillmentId);
    if (!found) {
      throw new AdapterNotFoundError(
        `Shopify fulfillment ${fulfillmentId} not found on order ${orderId} for incident ${id}`,
      );
    }
    return deriveShipmentIncident(found, ctx.tenantId);
  }

  /**
   * Claim evidence for one order line: the order snapshot scoped to that line
   * plus the fulfillment state. lineId may be a Shopify line-item id or SKU.
   */
  async getOrderLineClaimEvidence(
    ctx: ToolContext,
    q: { orderId: string; lineId?: string },
  ): Promise<Evidence[]> {
    requirePermission(ctx.principal, "read");
    const shopifyId = shopifyOrderIdFromOsas(q.orderId);
    const order = await this.fetchOrder(shopifyId);
    if (
      q.lineId !== undefined &&
      !(order.line_items ?? []).some((li) => String(li.id) === q.lineId || li.sku === q.lineId)
    ) {
      throw new AdapterNotFoundError(
        `line ${q.lineId} not found on Shopify order ${shopifyId}`,
      );
    }
    const evidence: Evidence[] = [
      await this.captureEvidence(
        ctx,
        orderLineClaimEvidenceInput(order, q.lineId, ctx.tenantId, this.config.shopDomain),
      ),
    ];
    for (const f of await this.fetchFulfillments(shopifyId)) {
      evidence.push(
        await this.captureEvidence(ctx, fulfillmentEvidenceInput(f, ctx.tenantId, this.config.shopDomain)),
      );
    }
    return evidence;
  }

  /**
   * Read-only exchange eligibility. Fail closed by design: the read-only
   * order/fulfillment JSON cannot resolve replacement-SKU inventory, so
   * inventoryStatus is always "unknown" and eligible is always false — a
   * human must verify stock before approving an exchange. priceDelta is
   * computed only when the replacement SKU happens to appear on the same
   * order (its price is then known from the line item).
   */
  async getExchangeEligibility(
    ctx: ToolContext,
    input: { orderId: string; originalLineId: string; replacementSku: string },
  ): Promise<ExchangeEligibility> {
    requirePermission(ctx.principal, "read");
    const order = await this.fetchOrder(shopifyOrderIdFromOsas(input.orderId));
    const lines = order.line_items ?? [];
    const original = lines.find(
      (li) => String(li.id) === input.originalLineId || li.sku === input.originalLineId,
    );
    if (!original) {
      throw new AdapterNotFoundError(
        `original line ${input.originalLineId} not found on Shopify order ${order.id}`,
      );
    }
    const replacement = lines.find((li) => li.sku === input.replacementSku);
    const currency = (order.currency ?? "USD").toUpperCase();
    return {
      eligible: false,
      inventoryStatus: "unknown",
      ...(replacement
        ? {
            priceDelta: {
              currency,
              minorUnits: toMinorUnits(replacement.price) - toMinorUnits(original.price),
            },
          }
        : {}),
      reason:
        "read-only adapter: replacement-SKU inventory is not resolvable from order data; " +
        "a human must verify stock before any exchange is approved",
    };
  }

  // ---- capability manifest ---------------------------------------------------

  async getCapabilities(_ctx: ToolContext): Promise<CapabilityManifest> {
    return {
      specVersion: SPEC_VERSION,
      implementationId: "osas-shopify-adapter",
      implementationVersion: "0.2.0",
      profiles: [
        {
          name: "ecommerce",
          capabilities: [
            "ecommerce.order.read",
            "ecommerce.shipment.read",
            "evidence.read",
            "ecommerce.refund.propose",
            "ecommerce.shipment_incident.read",
            "ecommerce.refund_status.read",
          ],
        },
      ],
      transports: ["http"],
      // No live execution — refund.execute is deliberately undeclared.
      executionModes: ["shadow"],
      adapterVersion: this.adapterVersion,
    };
  }

  // ---- unsupported: fail closed with CAPABILITY_UNSUPPORTED -------------------

  /** No refund write path exists. Ever throws without any HTTP call. */
  async executeAction(): Promise<ExecutionResult> {
    return unsupported("ecommerce.refund.execute");
  }
  async getCase(): Promise<Case> {
    return unsupported("case.read");
  }
  async searchCases(): Promise<Case[]> {
    return unsupported("case.read");
  }
  async getCustomer(): Promise<Customer> {
    return unsupported("customer.read");
  }
  async searchKnowledge(): Promise<KnowledgeArticle[]> {
    return unsupported("knowledge.read");
  }
  async createCaseNote(): Promise<CaseNote> {
    return unsupported("note.write");
  }
  async createEscalation(): Promise<Escalation> {
    return unsupported("escalation.write");
  }
  async createActionProposal(): Promise<ActionProposal> {
    return unsupported("proposal.write");
  }
  async getSubscription(): Promise<Subscription> {
    return unsupported("saas.subscription.read");
  }
  async listInvoices(): Promise<Invoice[]> {
    return unsupported("saas.subscription.read");
  }
  async getCreditBalance(): Promise<CreditBalance> {
    return unsupported("saas.credit.propose");
  }
  async getProposal(): Promise<ActionProposal> {
    return unsupported("proposal.write");
  }
  async listProposals(): Promise<ActionProposal[]> {
    return unsupported("proposal.write");
  }
  async updateProposalStatus(): Promise<ActionProposal> {
    return unsupported("proposal.write");
  }
  async appendAuditEvent(): Promise<AuditEvent> {
    return unsupported("audit.read");
  }
  async listAuditEvents(): Promise<AuditEvent[]> {
    return unsupported("audit.read");
  }
  async createApproval(): Promise<Approval> {
    return unsupported("approval.read");
  }
  async getApproval(): Promise<Approval> {
    return unsupported("approval.read");
  }
  async listApprovals(): Promise<Approval[]> {
    return unsupported("approval.read");
  }
  async decideApproval(): Promise<Approval> {
    return unsupported("approval.decide");
  }
  async createHandoff(): Promise<HumanHandoff> {
    return unsupported("escalation.write");
  }
  async listHandoffs(): Promise<HumanHandoff[]> {
    return unsupported("escalation.write");
  }
  async updateHandoff(): Promise<HumanHandoff> {
    return unsupported("escalation.write");
  }
  async getPolicy(): Promise<TenantPolicy> {
    return unsupported("proposal.write");
  }
  async putPolicy(): Promise<TenantPolicy> {
    return unsupported("proposal.write");
  }
}
