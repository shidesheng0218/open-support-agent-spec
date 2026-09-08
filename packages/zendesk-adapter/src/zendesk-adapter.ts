import {
  AdapterCapabilityError,
  AdapterNotFoundError,
  requirePermission,
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
  Order,
  Shipment,
  Subscription,
  TenantPolicy,
} from "@osas/core";
import { SPEC_VERSION } from "@osas/core";
import type { ZendeskConfig } from "./config.js";
import { ZendeskApiError, ZendeskNotConfiguredError } from "./errors.js";
import { createFetchHttpClient, type HttpClient, type HttpRequest } from "./http.js";
import {
  caseIdForTicket,
  mapTicketToCase,
  mapUserToCustomer,
  ticketEvidenceInput,
  ticketIdFromCaseId,
  userEvidenceInput,
  userIdFromCustomerId,
  type ZendeskTicket,
  type ZendeskUser,
} from "./mappers.js";

export interface ZendeskAdapterOptions {
  config: ZendeskConfig;
  /** Injectable HTTP client (tests); defaults to global fetch. */
  http?: HttpClient;
  /** Overrides the manifest's adapterVersion. */
  adapterVersion?: string;
}

interface ZendeskListResponse<T> {
  tickets?: T[];
  results?: Array<{ result?: T } & T>;
  users?: T[];
}

const unsupported = (capability: Capability): never => {
  throw new AdapterCapabilityError(
    capability,
    `ZendeskAdapter does not implement '${capability}' — it covers ticketing ` +
      "(case/customer read, internal notes, escalations, evidence capture) only.",
  );
};

/**
 * Zendesk reference adapter (v0.1.1 Milestone 3): tickets ↔ Case, users ↔
 * Customer, internal notes, human escalation to a configured group, and
 * Evidence capture with the Zendesk ticket/user id + agent URL as source.
 *
 * - All third-party traffic goes through the injectable HttpClient; the API
 *   token is sent as a Basic-auth header and never logged or surfaced in
 *   errors.
 * - Writes are idempotent: an in-process cache keyed by idempotencyKey
 *   replays the first result without re-sending the HTTP write, and the key
 *   is also forwarded as an X-Idempotency-Key header.
 * - Fail closed: no credentials → constructor/fromEnv throws
 *   ZendeskNotConfiguredError; no escalation group → createEscalation throws.
 * - Shadow Mode only: executeAction is never supported (capability
 *   ecommerce.refund.execute / execute-permission actions are undeclared).
 */
export class ZendeskAdapter implements SupportAdapter {
  private readonly config: ZendeskConfig;
  private readonly http: HttpClient;
  private readonly adapterVersion: string;
  private readonly idempotencyCache = new Map<string, CaseNote | Escalation>();
  private readonly evidenceStore = new Map<string, Evidence>();
  private evidenceCounter = 0;

  constructor(options: ZendeskAdapterOptions) {
    this.config = options.config;
    this.http = options.http ?? createFetchHttpClient();
    this.adapterVersion = options.adapterVersion ?? "0.2.0";
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.email}/token:${this.config.apiToken}`).toString("base64")}`;
  }

  private async call<T>(
    req: Omit<HttpRequest, "url" | "headers"> & { path: string; idempotencyKey?: string },
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: this.authHeader() };
    if (req.idempotencyKey) headers["x-idempotency-key"] = req.idempotencyKey;
    const res = await this.http({
      method: req.method,
      url: `${this.config.baseUrl}${req.path}`,
      headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    if (res.status === 404) {
      throw new AdapterNotFoundError(`Zendesk resource not found: ${req.method} ${req.path}`);
    }
    if (res.status < 200 || res.status >= 300) {
      // Never include headers/body — they may carry credentials or PII.
      throw new ZendeskApiError(res.status, `Zendesk API ${req.method} ${req.path} → HTTP ${res.status}`);
    }
    return res.body as T;
  }

  private async getTicket(ticketId: string): Promise<ZendeskTicket> {
    const res = await this.call<{ ticket: ZendeskTicket }>({
      method: "GET",
      path: `/api/v2/tickets/${ticketId}.json`,
    });
    return res.ticket;
  }

  private async getUser(userId: string): Promise<ZendeskUser> {
    const res = await this.call<{ user: ZendeskUser }>({
      method: "GET",
      path: `/api/v2/users/${userId}.json`,
    });
    return res.user;
  }

  // ---- supported: ticketing reads ----------------------------------------

  async getCase(ctx: ToolContext, id: string): Promise<Case> {
    requirePermission(ctx.principal, "read");
    const ticket = await this.getTicket(ticketIdFromCaseId(id));
    return mapTicketToCase(ticket, ctx.tenantId);
  }

  async searchCases(
    ctx: ToolContext,
    q: { customerId?: string; status?: string; q?: string },
  ): Promise<Case[]> {
    requirePermission(ctx.principal, "read");
    const parts = ["type:ticket"];
    if (q.customerId) parts.push(`requester:${userIdFromCustomerId(q.customerId)}`);
    if (q.q) parts.push(q.q);
    const res = await this.call<ZendeskListResponse<ZendeskTicket>>({
      method: "GET",
      path: `/api/v2/search.json?query=${encodeURIComponent(parts.join(" "))}`,
    });
    const tickets = (res.results ?? []).map((r) => r.result ?? r);
    let cases = tickets.map((t) => mapTicketToCase(t, ctx.tenantId));
    if (q.status) cases = cases.filter((c) => c.status === q.status);
    return cases;
  }

  async getCustomer(ctx: ToolContext, id: string): Promise<Customer> {
    requirePermission(ctx.principal, "read");
    const user = await this.getUser(userIdFromCustomerId(id));
    return mapUserToCustomer(user, ctx.tenantId);
  }

  // ---- supported: writes (idempotent) --------------------------------------

  async createCaseNote(
    ctx: ToolContext,
    input: { caseId: string; body: string; evidenceIds?: string[]; idempotencyKey: string },
  ): Promise<CaseNote> {
    requirePermission(ctx.principal, "draft");
    const cacheKey = `note:${ctx.tenantId}:${input.idempotencyKey}`;
    const cached = this.idempotencyCache.get(cacheKey);
    if (cached) return structuredClone(cached) as CaseNote;

    const ticketId = ticketIdFromCaseId(input.caseId);
    // Internal note only — never a public reply.
    await this.call<{ ticket: ZendeskTicket }>({
      method: "PUT",
      path: `/api/v2/tickets/${ticketId}.json`,
      body: { ticket: { comment: { body: input.body, public: false } } },
      idempotencyKey: input.idempotencyKey,
    });
    const note: CaseNote = {
      id: `zdnote_${ticketId}_${this.idempotencyCache.size + 1}`,
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      caseId: caseIdForTicket(ticketId),
      body: input.body,
      createdAt: new Date().toISOString(),
    };
    this.idempotencyCache.set(cacheKey, note);
    return structuredClone(note);
  }

  async createEscalation(
    ctx: ToolContext,
    input: { caseId: string; reason: string; idempotencyKey: string },
  ): Promise<Escalation> {
    requirePermission(ctx.principal, "draft");
    if (!this.config.escalationGroupId) {
      throw new ZendeskNotConfiguredError(
        "ZENDESK_ESCALATION_GROUP_ID is not configured; cannot route a human escalation. Failing closed.",
      );
    }
    const cacheKey = `esc:${ctx.tenantId}:${input.idempotencyKey}`;
    const cached = this.idempotencyCache.get(cacheKey);
    if (cached) return structuredClone(cached) as Escalation;

    const ticketId = ticketIdFromCaseId(input.caseId);
    await this.call<{ ticket: ZendeskTicket }>({
      method: "PUT",
      path: `/api/v2/tickets/${ticketId}.json`,
      body: {
        ticket: {
          group_id: this.config.escalationGroupId,
          comment: { body: `[OSAS escalation] ${input.reason}`, public: false },
        },
      },
      idempotencyKey: input.idempotencyKey,
    });
    const escalation: Escalation = {
      id: `zdesc_${ticketId}_${this.idempotencyCache.size + 1}`,
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      caseId: caseIdForTicket(ticketId),
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    this.idempotencyCache.set(cacheKey, escalation);
    return structuredClone(escalation);
  }

  // ---- supported: evidence capture (ticket/user ids + agent URLs as source) --

  async captureEvidence(
    ctx: ToolContext,
    input: Omit<Evidence, "id" | "specVersion" | "createdAt">,
  ): Promise<Evidence> {
    requirePermission(ctx.principal, "draft");
    const evidence: Evidence = {
      ...structuredClone(input),
      id: `zdev_${++this.evidenceCounter}`,
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      createdAt: new Date().toISOString(),
    };
    this.evidenceStore.set(evidence.id, evidence);
    return structuredClone(evidence);
  }

  /** Fetch a Zendesk ticket and capture it as OSAS Evidence in one call. */
  async captureTicketEvidence(ctx: ToolContext, ticketId: string): Promise<Evidence> {
    requirePermission(ctx.principal, "draft");
    const ticket = await this.getTicket(ticketIdFromCaseId(ticketId));
    return this.captureEvidence(ctx, ticketEvidenceInput(ticket, ctx.tenantId, this.config.baseUrl));
  }

  /** Fetch a Zendesk user and capture it as identity Evidence in one call. */
  async captureUserEvidence(ctx: ToolContext, userId: string): Promise<Evidence> {
    requirePermission(ctx.principal, "draft");
    const user = await this.getUser(userIdFromCustomerId(userId));
    return this.captureEvidence(ctx, userEvidenceInput(user, ctx.tenantId, this.config.baseUrl));
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

  // ---- capability manifest --------------------------------------------------

  async getCapabilities(_ctx: ToolContext): Promise<CapabilityManifest> {
    return {
      specVersion: SPEC_VERSION,
      implementationId: "osas-zendesk-adapter",
      implementationVersion: "0.2.0",
      profiles: [
        {
          name: "core",
          capabilities: [
            "case.read",
            "customer.read",
            "evidence.read",
            "note.write",
            "escalation.write",
          ],
        },
      ],
      transports: ["http"],
      // Shadow Mode reference integration: no live execution, ever (v0.2.0).
      executionModes: ["shadow"],
      adapterVersion: this.adapterVersion,
    };
  }

  // ---- unsupported: fail closed with CAPABILITY_UNSUPPORTED -----------------

  async searchKnowledge(): Promise<KnowledgeArticle[]> {
    return unsupported("knowledge.read");
  }
  async createActionProposal(): Promise<ActionProposal> {
    return unsupported("proposal.write");
  }
  async getOrder(): Promise<Order> {
    return unsupported("ecommerce.order.read");
  }
  async listOrders(): Promise<Order[]> {
    return unsupported("ecommerce.order.read");
  }
  async getShipment(): Promise<Shipment> {
    return unsupported("ecommerce.shipment.read");
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
  async executeAction(): Promise<ExecutionResult> {
    return unsupported("ecommerce.refund.execute");
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
