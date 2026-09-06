import {
  AdapterNotFoundError,
  requirePermission,
  type Permission,
  type SupportAdapter,
  type ToolContext,
} from "@osas/adapter";
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
import { AUDIT_CHAIN_GENESIS_HASH, hashAuditEvent } from "@osas/policy-engine";
import { createDemoFixtures, SPEC_VERSION, type DemoFixtures } from "./fixtures.js";

const clone = <T>(value: T): T => structuredClone(value);
const nowIso = (): string => new Date().toISOString();

/**
 * In-memory SupportAdapter over the §11 demo fixtures.
 *
 * - Deep clones on the way in and out: callers never alias adapter state.
 * - Deterministic id generation: `<prefix>_<counter>` with a per-prefix
 *   counter starting at 1 for each adapter instance.
 * - Permission levels enforced via @osas/adapter helpers: reads → "read";
 *   note/escalation/proposal/evidence/audit/approval/handoff persistence →
 *   "draft"; executeAction and putPolicy → "execute".
 * - executeAction demo/test hook: when `proposal.params.simulate === "timeout"`
 *   it returns `{ status: "uncertain" }` and applies NO side effects
 *   (CONTRACTS.md §5/§11). Otherwise it mutates the fixture records
 *   (refund → order refunded, credit_apply → balance increased,
 *   subscription_cancel → cancelled, note/escalation stored) and returns
 *   `{ status: "succeeded", externalRef }`.
 */
export class MockSupportAdapter implements SupportAdapter {
  private readonly counters = new Map<string, number>();

  private readonly cases = new Map<string, Case>();
  private readonly customers = new Map<string, Customer>();
  private readonly knowledge = new Map<string, KnowledgeArticle>();
  private readonly orders = new Map<string, Order>();
  private readonly shipments = new Map<string, Shipment>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly invoices = new Map<string, Invoice>();
  private readonly creditBalances = new Map<string, CreditBalance>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly proposals = new Map<string, ActionProposal>();
  private readonly caseNotes = new Map<string, CaseNote>();
  private readonly escalations = new Map<string, Escalation>();
  private readonly approvals = new Map<string, Approval>();
  private readonly handoffs = new Map<string, HumanHandoff>();
  private readonly auditEvents = new Map<string, AuditEvent>();
  private readonly policies = new Map<string, TenantPolicy>();
  /** Per-tenant hash-chain head: last assigned sequence + last eventHash. */
  private readonly auditChainHeads = new Map<string, { sequence: number; lastHash: string }>();

  constructor(fixtures: DemoFixtures = createDemoFixtures()) {
    this.load(fixtures);
  }

  private load(fixtures: DemoFixtures): void {
    const seed = clone(fixtures);
    for (const c of seed.cases) this.cases.set(c.id, c);
    for (const c of seed.customers) this.customers.set(c.id, c);
    for (const k of seed.knowledgeArticles) this.knowledge.set(k.id, k);
    for (const o of seed.orders) this.orders.set(o.id, o);
    for (const s of seed.shipments) this.shipments.set(s.id, s);
    for (const s of seed.subscriptions) this.subscriptions.set(s.id, s);
    for (const i of seed.invoices) this.invoices.set(i.id, i);
    for (const b of seed.creditBalances) this.creditBalances.set(b.id, b);
    for (const e of seed.evidence) this.evidence.set(e.id, e);
    for (const p of seed.proposals) this.proposals.set(p.id, p);
    for (const n of seed.caseNotes) this.caseNotes.set(n.id, n);
    for (const e of seed.escalations) this.escalations.set(e.id, e);
    for (const a of seed.approvals) this.approvals.set(a.id, a);
    for (const h of seed.handoffs) this.handoffs.set(h.id, h);
    for (const e of seed.auditEvents) this.auditEvents.set(e.id, e);
    this.policies.set(seed.policy.tenantId, seed.policy);
  }

  /**
   * Conformance Mode (Milestone 4): wipe ALL in-memory state (including id
   * counters and per-tenant audit hash-chain heads) and re-seed from fresh
   * fixtures. Test-only — the reference API exposes this exclusively through
   * the conformance endpoints, which fail closed in production.
   */
  reset(fixtures: DemoFixtures = createDemoFixtures()): void {
    this.counters.clear();
    this.cases.clear();
    this.customers.clear();
    this.knowledge.clear();
    this.orders.clear();
    this.shipments.clear();
    this.subscriptions.clear();
    this.invoices.clear();
    this.creditBalances.clear();
    this.evidence.clear();
    this.proposals.clear();
    this.caseNotes.clear();
    this.escalations.clear();
    this.approvals.clear();
    this.handoffs.clear();
    this.auditEvents.clear();
    this.policies.clear();
    this.auditChainHeads.clear();
    this.load(fixtures);
  }

  private nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${n}`;
  }

  private requireTenant<T extends { id: string; tenantId: string }>(
    map: Map<string, T>,
    ctx: ToolContext,
    id: string,
    what: string,
  ): T {
    const found = map.get(id);
    if (!found || found.tenantId !== ctx.tenantId) {
      throw new AdapterNotFoundError(`${what} ${id} not found for tenant ${ctx.tenantId}`);
    }
    return found;
  }

  private check(ctx: ToolContext, needed: Permission): void {
    requirePermission(ctx.principal, needed);
  }

  // ---- core reads -------------------------------------------------------

  async getCase(ctx: ToolContext, id: string): Promise<Case> {
    this.check(ctx, "read");
    return clone(this.requireTenant(this.cases, ctx, id, "Case"));
  }

  async searchCases(
    ctx: ToolContext,
    q: { customerId?: string; status?: CaseStatus; q?: string },
  ): Promise<Case[]> {
    this.check(ctx, "read");
    const needle = q.q?.toLowerCase();
    return clone(
      [...this.cases.values()].filter(
        (c) =>
          c.tenantId === ctx.tenantId &&
          (q.customerId === undefined || c.customerId === q.customerId) &&
          (q.status === undefined || c.status === q.status) &&
          (needle === undefined || c.subject.toLowerCase().includes(needle)),
      ),
    );
  }

  async getCustomer(ctx: ToolContext, id: string): Promise<Customer> {
    this.check(ctx, "read");
    return clone(this.requireTenant(this.customers, ctx, id, "Customer"));
  }

  async searchKnowledge(
    ctx: ToolContext,
    q: { q: string; limit?: number },
  ): Promise<KnowledgeArticle[]> {
    this.check(ctx, "read");
    const needle = q.q.toLowerCase();
    const hits = [...this.knowledge.values()].filter(
      (k) =>
        k.tenantId === ctx.tenantId &&
        (k.title.toLowerCase().includes(needle) ||
          k.body.toLowerCase().includes(needle) ||
          k.tags.some((t) => t.toLowerCase().includes(needle))),
    );
    return clone(hits.slice(0, q.limit ?? 10));
  }

  // ---- core writes --------------------------------------------------------

  async createCaseNote(
    ctx: ToolContext,
    input: { caseId: string; body: string; evidenceIds?: string[]; idempotencyKey: string },
  ): Promise<CaseNote> {
    this.check(ctx, "draft");
    this.requireTenant(this.cases, ctx, input.caseId, "Case");
    const note: CaseNote = {
      id: this.nextId("note"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      caseId: input.caseId,
      body: input.body,
      createdAt: nowIso(),
    };
    this.caseNotes.set(note.id, note);
    return clone(note);
  }

  async createEscalation(
    ctx: ToolContext,
    input: { caseId: string; reason: string; idempotencyKey: string },
  ): Promise<Escalation> {
    this.check(ctx, "draft");
    this.requireTenant(this.cases, ctx, input.caseId, "Case");
    const escalation: Escalation = {
      id: this.nextId("esc"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      caseId: input.caseId,
      reason: input.reason,
      createdAt: nowIso(),
    };
    this.escalations.set(escalation.id, escalation);
    return clone(escalation);
  }

  async createActionProposal(
    ctx: ToolContext,
    input: Omit<ActionProposal, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">,
  ): Promise<ActionProposal> {
    this.check(ctx, "draft");
    const ts = nowIso();
    const proposal: ActionProposal = {
      ...clone(input),
      id: this.nextId("prop"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      status: "proposed",
      createdAt: ts,
      updatedAt: ts,
    };
    this.proposals.set(proposal.id, proposal);
    return clone(proposal);
  }

  // ---- ecommerce reads ----------------------------------------------------

  async getOrder(ctx: ToolContext, id: string): Promise<Order> {
    this.check(ctx, "read");
    return clone(this.requireTenant(this.orders, ctx, id, "Order"));
  }

  async listOrders(ctx: ToolContext, customerId: string): Promise<Order[]> {
    this.check(ctx, "read");
    return clone(
      [...this.orders.values()].filter(
        (o) => o.tenantId === ctx.tenantId && o.customerId === customerId,
      ),
    );
  }

  async getShipment(ctx: ToolContext, id: string): Promise<Shipment> {
    this.check(ctx, "read");
    return clone(this.requireTenant(this.shipments, ctx, id, "Shipment"));
  }

  // ---- saas reads ---------------------------------------------------------

  async getSubscription(ctx: ToolContext, id: string): Promise<Subscription> {
    this.check(ctx, "read");
    return clone(this.requireTenant(this.subscriptions, ctx, id, "Subscription"));
  }

  async listInvoices(ctx: ToolContext, customerId: string): Promise<Invoice[]> {
    this.check(ctx, "read");
    return clone(
      [...this.invoices.values()].filter(
        (i) => i.tenantId === ctx.tenantId && i.customerId === customerId,
      ),
    );
  }

  async getCreditBalance(ctx: ToolContext, customerId: string): Promise<CreditBalance> {
    this.check(ctx, "read");
    const found = [...this.creditBalances.values()].find(
      (b) => b.tenantId === ctx.tenantId && b.customerId === customerId,
    );
    if (!found) {
      throw new AdapterNotFoundError(
        `CreditBalance for customer ${customerId} not found for tenant ${ctx.tenantId}`,
      );
    }
    return clone(found);
  }

  // ---- execution (execute-permission only; never an MCP tool) --------------

  async executeAction(ctx: ToolContext, proposal: ActionProposal): Promise<ExecutionResult> {
    this.check(ctx, "execute");
    const params = (proposal.params ?? {}) as Record<string, unknown>;

    // Documented demo/test hook (CONTRACTS.md §11): simulate an upstream
    // timeout → uncertain, NO side effects, never auto-retried here.
    if (params.simulate === "timeout") {
      return {
        status: "uncertain",
        detail: 'Simulated upstream timeout (proposal.params.simulate === "timeout")',
      };
    }

    const ext = this.nextId("ext");
    switch (proposal.actionType) {
      case "refund": {
        const orderId = typeof params.orderId === "string" ? params.orderId : undefined;
        const order = orderId ? this.orders.get(orderId) : undefined;
        if (!order || order.tenantId !== ctx.tenantId) {
          return { status: "failed", detail: `Order ${String(orderId)} not found` };
        }
        order.status = "refunded";
        return { status: "succeeded", externalRef: `rfnd_${ext}` };
      }
      case "credit_apply": {
        let customerId = typeof params.customerId === "string" ? params.customerId : undefined;
        if (!customerId) {
          const kase = this.cases.get(proposal.caseId);
          customerId = kase?.customerId;
        }
        if (!customerId) return { status: "failed", detail: "No customerId for credit_apply" };
        let balance = [...this.creditBalances.values()].find(
          (b) => b.tenantId === ctx.tenantId && b.customerId === customerId,
        );
        if (!balance) {
          balance = {
            id: this.nextId("cbal"),
            specVersion: SPEC_VERSION,
            tenantId: ctx.tenantId,
            customerId,
            balance: { currency: proposal.amount?.currency ?? "USD", minorUnits: 0 },
            createdAt: nowIso(),
          };
          this.creditBalances.set(balance.id, balance);
        }
        if (!proposal.amount) return { status: "failed", detail: "credit_apply requires amount" };
        if (proposal.amount.currency !== balance.balance.currency) {
          return { status: "failed", detail: "Currency mismatch with credit balance" };
        }
        balance.balance = {
          currency: balance.balance.currency,
          minorUnits: balance.balance.minorUnits + proposal.amount.minorUnits,
        };
        return { status: "succeeded", externalRef: `cr_${ext}` };
      }
      case "subscription_cancel": {
        const subId = typeof params.subscriptionId === "string" ? params.subscriptionId : undefined;
        const sub = subId ? this.subscriptions.get(subId) : undefined;
        if (!sub || sub.tenantId !== ctx.tenantId) {
          return { status: "failed", detail: `Subscription ${String(subId)} not found` };
        }
        sub.status = "cancelled";
        return { status: "succeeded", externalRef: `subcancel_${ext}` };
      }
      case "plan_change": {
        const subId = typeof params.subscriptionId === "string" ? params.subscriptionId : undefined;
        const sub = subId ? this.subscriptions.get(subId) : undefined;
        if (!sub || sub.tenantId !== ctx.tenantId) {
          return { status: "failed", detail: `Subscription ${String(subId)} not found` };
        }
        if (typeof params.newPlan !== "string" || params.newPlan.length === 0) {
          return { status: "failed", detail: "plan_change requires params.newPlan" };
        }
        sub.plan = params.newPlan;
        return { status: "succeeded", externalRef: `planchange_${ext}` };
      }
      case "cancel_order": {
        const orderId = typeof params.orderId === "string" ? params.orderId : undefined;
        const order = orderId ? this.orders.get(orderId) : undefined;
        if (!order || order.tenantId !== ctx.tenantId) {
          return { status: "failed", detail: `Order ${String(orderId)} not found` };
        }
        order.status = "cancelled";
        return { status: "succeeded", externalRef: `ordcancel_${ext}` };
      }
      case "create_note": {
        const body = typeof params.body === "string" ? params.body : proposal.reasonCode;
        const note: CaseNote = {
          id: this.nextId("note"),
          specVersion: SPEC_VERSION,
          tenantId: ctx.tenantId,
          caseId: proposal.caseId,
          body,
          createdAt: nowIso(),
        };
        this.caseNotes.set(note.id, note);
        return { status: "succeeded", externalRef: note.id };
      }
      case "create_escalation": {
        const reason =
          typeof params.reason === "string" ? params.reason : proposal.reasonCode;
        const escalation: Escalation = {
          id: this.nextId("esc"),
          specVersion: SPEC_VERSION,
          tenantId: ctx.tenantId,
          caseId: proposal.caseId,
          reason,
          createdAt: nowIso(),
        };
        this.escalations.set(escalation.id, escalation);
        return { status: "succeeded", externalRef: escalation.id };
      }
      case "return_request":
      case "reshipment":
        return { status: "succeeded", externalRef: `${proposal.actionType}_${ext}` };
      default:
        return { status: "failed", detail: `Unsupported actionType ${String(proposal.actionType)}` };
    }
  }

  async captureEvidence(
    ctx: ToolContext,
    input: Omit<Evidence, "id" | "specVersion" | "createdAt">,
  ): Promise<Evidence> {
    this.check(ctx, "draft");
    const evidence: Evidence = {
      ...clone(input),
      id: this.nextId("ev"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      createdAt: nowIso(),
    };
    this.evidence.set(evidence.id, evidence);
    return clone(evidence);
  }

  async getEvidence(ctx: ToolContext, id: string): Promise<Evidence> {
    this.check(ctx, "read");
    return clone(this.requireTenant(this.evidence, ctx, id, "Evidence"));
  }

  async listEvidence(ctx: ToolContext, q: { caseId?: string }): Promise<Evidence[]> {
    this.check(ctx, "read");
    return clone(
      [...this.evidence.values()].filter(
        (e) =>
          e.tenantId === ctx.tenantId && (q.caseId === undefined || e.caseId === q.caseId),
      ),
    );
  }

  // ---- proposal persistence (used by API/engine) ---------------------------

  async getProposal(ctx: ToolContext, id: string): Promise<ActionProposal> {
    this.check(ctx, "read");
    return clone(this.requireTenant(this.proposals, ctx, id, "ActionProposal"));
  }

  async listProposals(
    ctx: ToolContext,
    q: { caseId?: string; status?: ProposalStatus },
  ): Promise<ActionProposal[]> {
    this.check(ctx, "read");
    return clone(
      [...this.proposals.values()].filter(
        (p) =>
          p.tenantId === ctx.tenantId &&
          (q.caseId === undefined || p.caseId === q.caseId) &&
          (q.status === undefined || p.status === q.status),
      ),
    );
  }

  async updateProposalStatus(
    ctx: ToolContext,
    id: string,
    status: ProposalStatus,
    patch?: Partial<ActionProposal>,
  ): Promise<ActionProposal> {
    this.check(ctx, "draft");
    const existing = this.requireTenant(this.proposals, ctx, id, "ActionProposal");
    const updated: ActionProposal = {
      ...existing,
      ...clone(patch ?? {}),
      id: existing.id,
      tenantId: existing.tenantId,
      status,
      updatedAt: nowIso(),
    };
    this.proposals.set(id, updated);
    return clone(updated);
  }

  // ---- audit ---------------------------------------------------------------

  async appendAuditEvent(
    ctx: ToolContext,
    e: Omit<AuditEvent, "id" | "specVersion" | "createdAt">,
  ): Promise<AuditEvent> {
    this.check(ctx, "draft");
    const event: AuditEvent = {
      ...clone(e),
      id: this.nextId("audit"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      createdAt: nowIso(),
    };
    // Hash-chain extension (v0.1.1): per-tenant append-only chain.
    const head = this.auditChainHeads.get(ctx.tenantId) ?? {
      sequence: 0,
      lastHash: AUDIT_CHAIN_GENESIS_HASH,
    };
    const linked: AuditEvent = {
      ...event,
      sequence: head.sequence + 1,
      previousHash: head.lastHash,
    };
    linked.eventHash = hashAuditEvent(linked);
    this.auditChainHeads.set(ctx.tenantId, {
      sequence: linked.sequence as number,
      lastHash: linked.eventHash,
    });
    this.auditEvents.set(linked.id, linked);
    return clone(linked);
  }

  async listAuditEvents(
    ctx: ToolContext,
    q: { caseId?: string; proposalId?: string },
  ): Promise<AuditEvent[]> {
    this.check(ctx, "read");
    return clone(
      [...this.auditEvents.values()].filter(
        (e) =>
          e.tenantId === ctx.tenantId &&
          (q.caseId === undefined || e.caseId === q.caseId) &&
          (q.proposalId === undefined || e.proposalId === q.proposalId),
      ),
    );
  }

  // ---- approvals -------------------------------------------------------------

  async createApproval(
    ctx: ToolContext,
    a: Omit<Approval, "id" | "specVersion" | "createdAt">,
  ): Promise<Approval> {
    this.check(ctx, "draft");
    const approval: Approval = {
      ...clone(a),
      id: this.nextId("appr"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.approvals.set(approval.id, approval);
    return clone(approval);
  }

  async getApproval(ctx: ToolContext, id: string): Promise<Approval> {
    this.check(ctx, "read");
    return clone(this.requireTenant(this.approvals, ctx, id, "Approval"));
  }

  async listApprovals(ctx: ToolContext, q: { status?: Approval["status"] }): Promise<Approval[]> {
    this.check(ctx, "read");
    return clone(
      [...this.approvals.values()].filter(
        (a) => a.tenantId === ctx.tenantId && (q.status === undefined || a.status === q.status),
      ),
    );
  }

  async decideApproval(
    ctx: ToolContext,
    id: string,
    decision: "approved" | "rejected",
    approverId: string,
    comment?: string,
  ): Promise<Approval> {
    this.check(ctx, "draft");
    const existing = this.requireTenant(this.approvals, ctx, id, "Approval");
    const updated: Approval = {
      ...existing,
      status: decision,
      approverId,
      ...(comment !== undefined ? { comment } : {}),
      decidedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.approvals.set(id, updated);
    return clone(updated);
  }

  // ---- handoffs ---------------------------------------------------------------

  async createHandoff(
    ctx: ToolContext,
    h: Omit<HumanHandoff, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">,
  ): Promise<HumanHandoff> {
    this.check(ctx, "draft");
    const ts = nowIso();
    const handoff: HumanHandoff = {
      ...clone(h),
      id: this.nextId("hand"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      status: "open",
      createdAt: ts,
      updatedAt: ts,
    };
    this.handoffs.set(handoff.id, handoff);
    return clone(handoff);
  }

  async listHandoffs(
    ctx: ToolContext,
    q: { status?: HumanHandoff["status"] },
  ): Promise<HumanHandoff[]> {
    this.check(ctx, "read");
    return clone(
      [...this.handoffs.values()].filter(
        (h) => h.tenantId === ctx.tenantId && (q.status === undefined || h.status === q.status),
      ),
    );
  }

  async updateHandoff(
    ctx: ToolContext,
    id: string,
    patch: Partial<Pick<HumanHandoff, "status" | "assignedTo" | "notes" | "resolvedAt">>,
  ): Promise<HumanHandoff> {
    this.check(ctx, "draft");
    const existing = this.requireTenant(this.handoffs, ctx, id, "HumanHandoff");
    const updated: HumanHandoff = {
      ...existing,
      ...clone(patch),
      id: existing.id,
      tenantId: existing.tenantId,
      updatedAt: nowIso(),
    };
    this.handoffs.set(id, updated);
    return clone(updated);
  }

  // ---- policy -------------------------------------------------------------------

  async getPolicy(ctx: ToolContext, tenantId: string): Promise<TenantPolicy> {
    this.check(ctx, "read");
    const policy = this.policies.get(tenantId);
    if (!policy) {
      throw new AdapterNotFoundError(`TenantPolicy for tenant ${tenantId} not found`);
    }
    return clone(policy);
  }

  async putPolicy(ctx: ToolContext, policy: TenantPolicy): Promise<TenantPolicy> {
    this.check(ctx, "execute");
    this.policies.set(policy.tenantId, clone(policy));
    return clone(policy);
  }

  // ---- capability manifest (v0.1.1) -----------------------------------------

  /** The mock implements every spec capability on every profile. */
  async getCapabilities(_ctx: ToolContext): Promise<CapabilityManifest> {
    return {
      specVersion: SPEC_VERSION,
      implementationId: "osas-mock-backend",
      implementationVersion: "0.1.1",
      profiles: [
        {
          name: "core",
          capabilities: [
            "case.read",
            "customer.read",
            "knowledge.read",
            "evidence.read",
            "note.write",
            "escalation.write",
            "proposal.write",
            "approval.read",
            "approval.decide",
            "audit.read",
          ],
        },
        {
          name: "ecommerce",
          capabilities: [
            "ecommerce.order.read",
            "ecommerce.shipment.read",
            "ecommerce.refund.propose",
            "ecommerce.refund.execute",
          ],
        },
        {
          name: "saas",
          capabilities: ["saas.subscription.read", "saas.credit.propose"],
        },
      ],
      transports: ["http", "mcp"],
      executionModes: ["proposal_only", "shadow", "live"],
      adapterVersion: "0.1.1",
    };
  }
}
