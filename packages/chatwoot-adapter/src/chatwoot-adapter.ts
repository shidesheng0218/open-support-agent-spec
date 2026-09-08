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
import type { ChatwootConfig } from "./config.js";
import { ChatwootApiError, ChatwootNotConfiguredError } from "./errors.js";
import { createFetchHttpClient, type HttpClient, type HttpRequest } from "./http.js";
import {
  caseIdForConversation,
  contactEvidenceInput,
  contactIdFromCustomerId,
  conversationEvidenceInput,
  conversationIdFromCaseId,
  mapContactToCustomer,
  mapConversationToCase,
  type ChatwootContact,
  type ChatwootConversation,
} from "./mappers.js";

export interface ChatwootAdapterOptions {
  config: ChatwootConfig;
  /** Injectable HTTP client (tests); defaults to global fetch. */
  http?: HttpClient;
  /** Overrides the manifest's adapterVersion. */
  adapterVersion?: string;
}

/**
 * Escalation result/record. An escalation is two external writes (team
 * assignment, then a private note); when the assignment lands but the note
 * fails the record is "partial_success" and carries both legs' detail for
 * human reconciliation. A retry with the same idempotencyKey resumes from
 * the failed note leg and transitions the cached record to "success".
 */
export interface ChatwootEscalationRecord extends Escalation {
  status: "success" | "partial_success";
  assignment: { teamId: string; response: unknown };
  noteError?: string;
}

interface ChatwootListResponse<T> {
  payload?: T[];
  data?: { payload?: T[] };
}

const unsupported = (capability: Capability): never => {
  throw new AdapterCapabilityError(
    capability,
    `ChatwootAdapter does not implement '${capability}' — it covers the inbox ` +
      "(case/customer read, private notes, escalations, evidence capture) only.",
  );
};

/**
 * Chatwoot reference adapter (v0.1.1 Milestone 3): conversations ↔ Case,
 * contacts ↔ Customer, private notes (message private:true), human
 * escalation to a configured team, and Evidence capture with the Chatwoot
 * conversation/contact id + agent URL as source.
 *
 * - All third-party traffic goes through the injectable HttpClient; the API
 *   token is sent as the api_access_token header and never logged or
 *   surfaced in errors.
 * - Writes are idempotent: an in-process cache keyed by idempotencyKey
 *   replays the first result without re-sending the HTTP write, and the key
 *   is also forwarded as an X-Idempotency-Key header. Escalations use
 *   distinct per-leg keys (`{key}:assignment` / `{key}:note`); a partial
 *   failure is cached as `partial_success` and a retry resumes the failed
 *   leg. The cache is in-process only — see docs/chatwoot-adapter.md for
 *   the production idempotency boundary.
 * - Fail closed: no credentials → constructor/fromEnv throws
 *   ChatwootNotConfiguredError; no escalation team → createEscalation throws.
 * - Shadow Mode only: executeAction is never supported (capability
 *   ecommerce.refund.execute / execute-permission actions are undeclared).
 */
export class ChatwootAdapter implements SupportAdapter {
  private readonly config: ChatwootConfig;
  private readonly http: HttpClient;
  private readonly adapterVersion: string;
  private readonly idempotencyCache = new Map<string, CaseNote | ChatwootEscalationRecord>();
  private readonly evidenceStore = new Map<string, Evidence>();
  private evidenceCounter = 0;

  constructor(options: ChatwootAdapterOptions) {
    this.config = options.config;
    this.http = options.http ?? createFetchHttpClient();
    this.adapterVersion = options.adapterVersion ?? "0.2.0";
  }

  private accountPath(suffix: string): string {
    return `/api/v1/accounts/${this.config.accountId}${suffix}`;
  }

  private async call<T>(
    req: Omit<HttpRequest, "url" | "headers"> & { path: string; idempotencyKey?: string },
  ): Promise<T> {
    const headers: Record<string, string> = { api_access_token: this.config.apiToken };
    if (req.idempotencyKey) headers["x-idempotency-key"] = req.idempotencyKey;
    const res = await this.http({
      method: req.method,
      url: `${this.config.baseUrl}${req.path}`,
      headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    if (res.status === 404) {
      throw new AdapterNotFoundError(`Chatwoot resource not found: ${req.method} ${req.path}`);
    }
    if (res.status < 200 || res.status >= 300) {
      // Never include headers/body — they may carry credentials or PII.
      throw new ChatwootApiError(res.status, `Chatwoot API ${req.method} ${req.path} → HTTP ${res.status}`);
    }
    return res.body as T;
  }

  private async getConversation(conversationId: string): Promise<ChatwootConversation> {
    return this.call<ChatwootConversation>({
      method: "GET",
      path: this.accountPath(`/conversations/${conversationId}`),
    });
  }

  private async getContact(contactId: string): Promise<ChatwootContact> {
    return this.call<ChatwootContact>({
      method: "GET",
      path: this.accountPath(`/contacts/${contactId}`),
    });
  }

  /** Private note — never a public reply. */
  private async postPrivateNote(
    conversationId: string,
    content: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.call<unknown>({
      method: "POST",
      path: this.accountPath(`/conversations/${conversationId}/messages`),
      body: { content, message_type: "outgoing", private: true },
      idempotencyKey,
    });
  }

  // ---- supported: inbox reads --------------------------------------------

  async getCase(ctx: ToolContext, id: string): Promise<Case> {
    requirePermission(ctx.principal, "read");
    const conv = await this.getConversation(conversationIdFromCaseId(id));
    return mapConversationToCase(conv, ctx.tenantId);
  }

  async searchCases(
    ctx: ToolContext,
    q: { customerId?: string; status?: string; q?: string },
  ): Promise<Case[]> {
    requirePermission(ctx.principal, "read");
    let conversations: ChatwootConversation[];
    if (q.customerId) {
      const res = await this.call<ChatwootListResponse<ChatwootConversation>>({
        method: "GET",
        path: this.accountPath(`/contacts/${contactIdFromCustomerId(q.customerId)}/conversations`),
      });
      conversations = res.payload ?? res.data?.payload ?? [];
    } else if (q.q) {
      const res = await this.call<ChatwootListResponse<ChatwootConversation>>({
        method: "GET",
        path: this.accountPath(`/conversations/search?q=${encodeURIComponent(q.q)}`),
      });
      conversations = res.payload ?? res.data?.payload ?? [];
    } else {
      const res = await this.call<ChatwootListResponse<ChatwootConversation>>({
        method: "GET",
        path: this.accountPath("/conversations"),
      });
      conversations = res.data?.payload ?? res.payload ?? [];
    }
    let cases = conversations.map((c) => mapConversationToCase(c, ctx.tenantId));
    if (q.status) cases = cases.filter((c) => c.status === q.status);
    return cases;
  }

  async getCustomer(ctx: ToolContext, id: string): Promise<Customer> {
    requirePermission(ctx.principal, "read");
    const contact = await this.getContact(contactIdFromCustomerId(id));
    return mapContactToCustomer(contact, ctx.tenantId);
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

    const conversationId = conversationIdFromCaseId(input.caseId);
    await this.postPrivateNote(conversationId, input.body, input.idempotencyKey);
    const note: CaseNote = {
      id: `cwnote_${conversationId}_${this.idempotencyCache.size + 1}`,
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      caseId: caseIdForConversation(conversationId),
      body: input.body,
      createdAt: new Date().toISOString(),
    };
    this.idempotencyCache.set(cacheKey, note);
    return structuredClone(note);
  }

  async createEscalation(
    ctx: ToolContext,
    input: { caseId: string; reason: string; idempotencyKey: string },
  ): Promise<ChatwootEscalationRecord> {
    requirePermission(ctx.principal, "draft");
    if (!this.config.escalationTeamId) {
      throw new ChatwootNotConfiguredError(
        "CHATWOOT_ESCALATION_TEAM_ID is not configured; cannot route a human escalation. Failing closed.",
      );
    }
    const teamId = this.config.escalationTeamId;
    const cacheKey = `esc:${ctx.tenantId}:${input.idempotencyKey}`;
    const conversationId = conversationIdFromCaseId(input.caseId);
    const noteKey = `${input.idempotencyKey}:note`;
    const noteBody = `[OSAS escalation] ${input.reason}`;

    const cached = this.idempotencyCache.get(cacheKey);
    if (cached) {
      const record = cached as ChatwootEscalationRecord;
      if (record.status === "success") return structuredClone(record);
      // partial_success: resume at the failed note leg — never re-assign.
      await this.postPrivateNote(conversationId, noteBody, noteKey);
      const done: ChatwootEscalationRecord = { ...record, status: "success" };
      delete done.noteError;
      this.idempotencyCache.set(cacheKey, done);
      return structuredClone(done);
    }

    const assignmentResponse = await this.call<unknown>({
      method: "POST",
      path: this.accountPath(`/conversations/${conversationId}/assignments`),
      body: { team_id: teamId },
      idempotencyKey: `${input.idempotencyKey}:assignment`,
    });
    const record: ChatwootEscalationRecord = {
      id: `cwesc_${conversationId}_${this.idempotencyCache.size + 1}`,
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      caseId: caseIdForConversation(conversationId),
      reason: input.reason,
      status: "success",
      assignment: { teamId, response: assignmentResponse },
      createdAt: new Date().toISOString(),
    };
    try {
      await this.postPrivateNote(conversationId, noteBody, noteKey);
    } catch (err) {
      const partial: ChatwootEscalationRecord = {
        ...record,
        status: "partial_success",
        noteError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
      this.idempotencyCache.set(cacheKey, partial);
      return structuredClone(partial);
    }
    this.idempotencyCache.set(cacheKey, record);
    return structuredClone(record);
  }

  // ---- supported: evidence capture (conversation/contact ids + agent URLs) --

  async captureEvidence(
    ctx: ToolContext,
    input: Omit<Evidence, "id" | "specVersion" | "createdAt">,
  ): Promise<Evidence> {
    requirePermission(ctx.principal, "draft");
    const evidence: Evidence = {
      ...structuredClone(input),
      id: `cwev_${++this.evidenceCounter}`,
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      createdAt: new Date().toISOString(),
    };
    this.evidenceStore.set(evidence.id, evidence);
    return structuredClone(evidence);
  }

  /** Fetch a Chatwoot conversation and capture it as OSAS Evidence in one call. */
  async captureConversationEvidence(ctx: ToolContext, conversationId: string): Promise<Evidence> {
    requirePermission(ctx.principal, "draft");
    const conv = await this.getConversation(conversationIdFromCaseId(conversationId));
    return this.captureEvidence(
      ctx,
      conversationEvidenceInput(conv, ctx.tenantId, this.config.baseUrl, this.config.accountId),
    );
  }

  /** Fetch a Chatwoot contact and capture it as identity Evidence in one call. */
  async captureContactEvidence(ctx: ToolContext, contactId: string): Promise<Evidence> {
    requirePermission(ctx.principal, "draft");
    const contact = await this.getContact(contactIdFromCustomerId(contactId));
    return this.captureEvidence(
      ctx,
      contactEvidenceInput(contact, ctx.tenantId, this.config.baseUrl, this.config.accountId),
    );
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
      implementationId: "osas-chatwoot-adapter",
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
