import type { Pool } from "pg";
import {
  AdapterNotFoundError,
  AdapterPermissionError,
  requirePermission,
  type SupportAdapter,
  type ToolContext,
  type ExchangeEligibility,
  type Permission,
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
  ItemClaim,
  ItemClaimType,
  KnowledgeArticle,
  Order,
  ProposalStatus,
  RefundTransaction,
  Shipment,
  ShipmentIncident,
  Subscription,
  TenantPolicy,
} from "@osas/core";
import { AUDIT_CHAIN_GENESIS_HASH, hashAuditEvent } from "@osas/policy-engine";

const SPEC_VERSION = "0.2" as const;

/**
 * Postgres-backed SupportAdapter (P0-3 fix).
 *
 * Persists the core domain objects — cases, customers, evidence, proposals,
 * approvals, handoffs, notes, escalations, audit events — instead of keeping
 * them in process memory like MockSupportAdapter.
 *
 * P0-4 fix: audit chain heads are hydrated from the `audit_events` table on
 * `initialize()`, so `sequence` continues across restarts instead of
 * resetting to 1 (which would collide with the (tenant_id, sequence) unique
 * index and break /v1/audit/verify).
 *
 * Design constraints:
 * - Parameterized queries only (no string-built SQL).
 * - Every row is tenant-scoped; reads filter on tenant_id and id.
 * - Full objects live in a jsonb `payload` column; selected columns exist for
 *   indexing/filtering.
 * - executeAction is NOT implemented: this adapter serves shadow /
 *   proposal_only modes. Sandbox execution stays with SandboxSupportAdapter.
 */
export class PostgresSupportAdapter implements SupportAdapter {
  private readonly pool: Pool;
  /** Per-tenant audit chain head: last assigned sequence + last eventHash. */
  private readonly auditChainHeads = new Map<string, { sequence: number; lastHash: string }>();
  /** In-process id counters (demo-grade; production should use UUIDs). */
  private readonly counters = new Map<string, number>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Hydrate per-tenant audit chain heads from the database (P0-4).
   * MUST be called once at startup before serving traffic.
   */
  async initialize(): Promise<void> {
    const result = await this.pool.query<{
      tenant_id: string;
      sequence: string;
      event_hash: string;
    }>(
      `SELECT DISTINCT ON (tenant_id) tenant_id, sequence, event_hash
         FROM audit_events
        WHERE sequence IS NOT NULL
        ORDER BY tenant_id, sequence DESC`,
    );
    for (const row of result.rows) {
      this.auditChainHeads.set(row.tenant_id, {
        sequence: Number.parseInt(row.sequence, 10),
        lastHash: row.event_hash,
      });
    }
  }

  private nextId(prefix: string): string {
    const count = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, count);
    return `${prefix}_${Date.now().toString(36)}_${count}`;
  }

  private check(ctx: ToolContext, required: Permission): void {
    requirePermission(ctx.principal, required);
  }

  private static notFound(entityType: string, id: string, tenantId: string): AdapterNotFoundError {
    return new AdapterNotFoundError(`${entityType} ${id} not found for tenant ${tenantId}`);
  }

  private async ensureTenant(tenantId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenants (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  }

  // ==================== Capabilities ====================

  async getCapabilities(_ctx: ToolContext): Promise<CapabilityManifest> {
    return {
      specVersion: SPEC_VERSION,
      implementationId: "osas-postgres-support-adapter",
      implementationVersion: "0.2.1",
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
            "ecommerce.shipment_incident.read",
            "ecommerce.refund_status.read",
            "ecommerce.item_claim.propose",
            "ecommerce.exchange.propose",
          ],
        },
        {
          name: "saas",
          capabilities: ["saas.subscription.read", "saas.credit.propose"],
        },
      ],
      transports: ["http"],
      executionModes: ["proposal_only", "shadow"],
      adapterVersion: "0.2.1",
    };
  }

  // ==================== Cases ====================

  async getCase(ctx: ToolContext, id: string): Promise<Case> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: Case }>(
      `SELECT payload FROM cases WHERE tenant_id = $1 AND case_id = $2`,
      [ctx.tenantId, id],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("Case", id, ctx.tenantId);
    return result.rows[0].payload;
  }

  async searchCases(
    ctx: ToolContext,
    q: { customerId?: string; status?: CaseStatus; q?: string },
  ): Promise<Case[]> {
    this.check(ctx, "read");
    let sql = `SELECT payload FROM cases WHERE tenant_id = $1`;
    const params: unknown[] = [ctx.tenantId];
    if (q.customerId) {
      params.push(q.customerId);
      sql += ` AND customer_id = $${params.length}`;
    }
    if (q.status) {
      params.push(q.status);
      sql += ` AND status = $${params.length}`;
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      sql += ` AND subject ILIKE $${params.length}`;
    }
    sql += ` ORDER BY created_at DESC`;
    const result = await this.pool.query<{ payload: Case }>(sql, params);
    return result.rows.map((r) => r.payload);
  }

  // ==================== Customers ====================

  async getCustomer(ctx: ToolContext, id: string): Promise<Customer> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: Customer }>(
      `SELECT payload FROM customers WHERE tenant_id = $1 AND customer_id = $2`,
      [ctx.tenantId, id],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("Customer", id, ctx.tenantId);
    return result.rows[0].payload;
  }

  // ==================== Knowledge ====================

  async searchKnowledge(
    ctx: ToolContext,
    q: { q: string; limit?: number },
  ): Promise<KnowledgeArticle[]> {
    this.check(ctx, "read");
    const limit = Math.min(Math.max(q.limit ?? 10, 1), 50);
    const result = await this.pool.query<{ payload: KnowledgeArticle }>(
      `SELECT payload FROM knowledge_articles
        WHERE tenant_id = $1 AND (title ILIKE $2 OR payload::text ILIKE $2)
        LIMIT $3`,
      [ctx.tenantId, `%${q.q}%`, limit],
    );
    return result.rows.map((r) => r.payload);
  }

  // ==================== Notes & Escalations ====================

  async createCaseNote(
    ctx: ToolContext,
    input: { caseId: string; body: string; evidenceIds?: string[]; idempotencyKey: string },
  ): Promise<CaseNote> {
    this.check(ctx, "draft");
    await this.ensureTenant(ctx.tenantId);
    const note: CaseNote = {
      id: this.nextId("note"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      caseId: input.caseId,
      body: input.body,
      createdAt: new Date().toISOString(),
    };
    await this.pool.query(
      `INSERT INTO case_notes (tenant_id, note_id, case_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [ctx.tenantId, note.id, note.caseId, note],
    );
    return note;
  }

  async createEscalation(
    ctx: ToolContext,
    input: { caseId: string; reason: string; idempotencyKey: string },
  ): Promise<Escalation> {
    this.check(ctx, "draft");
    await this.ensureTenant(ctx.tenantId);
    const escalation: Escalation = {
      id: this.nextId("esc"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      caseId: input.caseId,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
    await this.pool.query(
      `INSERT INTO escalations (tenant_id, escalation_id, case_id, reason)
       VALUES ($1, $2, $3, $4)`,
      [ctx.tenantId, escalation.id, escalation.caseId, escalation.reason],
    );
    return escalation;
  }

  // ==================== Proposals ====================

  async createActionProposal(
    ctx: ToolContext,
    input: Omit<ActionProposal, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">,
  ): Promise<ActionProposal> {
    this.check(ctx, "draft");
    await this.ensureTenant(ctx.tenantId);
    const now = new Date().toISOString();
    const proposal: ActionProposal = {
      ...input,
      id: this.nextId("prop"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    };
    await this.pool.query(
      `INSERT INTO proposals (tenant_id, proposal_id, case_id, status, idempotency_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.tenantId, proposal.id, proposal.caseId, proposal.status, proposal.idempotencyKey, proposal],
    );
    return proposal;
  }

  async getProposal(ctx: ToolContext, id: string): Promise<ActionProposal> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: ActionProposal }>(
      `SELECT payload FROM proposals WHERE tenant_id = $1 AND proposal_id = $2`,
      [ctx.tenantId, id],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("ActionProposal", id, ctx.tenantId);
    return result.rows[0].payload;
  }

  async listProposals(
    ctx: ToolContext,
    q: { caseId?: string; status?: ProposalStatus },
  ): Promise<ActionProposal[]> {
    this.check(ctx, "read");
    let sql = `SELECT payload FROM proposals WHERE tenant_id = $1`;
    const params: unknown[] = [ctx.tenantId];
    if (q.caseId) {
      params.push(q.caseId);
      sql += ` AND case_id = $${params.length}`;
    }
    if (q.status) {
      params.push(q.status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY created_at DESC`;
    const result = await this.pool.query<{ payload: ActionProposal }>(sql, params);
    return result.rows.map((r) => r.payload);
  }

  async updateProposalStatus(
    ctx: ToolContext,
    id: string,
    status: ProposalStatus,
    patch?: Partial<ActionProposal>,
  ): Promise<ActionProposal> {
    this.check(ctx, "draft");
    const existing = await this.getProposal(ctx, id);
    const updated: ActionProposal = {
      ...existing,
      ...(patch ?? {}),
      id: existing.id,
      tenantId: existing.tenantId,
      status,
      updatedAt: new Date().toISOString(),
    };
    await this.pool.query(
      `UPDATE proposals SET status = $1, payload = $2, updated_at = now()
        WHERE tenant_id = $3 AND proposal_id = $4`,
      [status, updated, ctx.tenantId, id],
    );
    return updated;
  }

  // ==================== Ecommerce reads ====================

  async getOrder(ctx: ToolContext, id: string): Promise<Order> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: Order }>(
      `SELECT payload FROM orders WHERE tenant_id = $1 AND order_id = $2`,
      [ctx.tenantId, id],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("Order", id, ctx.tenantId);
    return result.rows[0].payload;
  }

  async listOrders(ctx: ToolContext, customerId: string): Promise<Order[]> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: Order }>(
      `SELECT payload FROM orders WHERE tenant_id = $1 AND customer_id = $2 ORDER BY created_at DESC`,
      [ctx.tenantId, customerId],
    );
    return result.rows.map((r) => r.payload);
  }

  async getShipment(ctx: ToolContext, id: string): Promise<Shipment> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: Shipment }>(
      `SELECT payload FROM shipments WHERE tenant_id = $1 AND shipment_id = $2`,
      [ctx.tenantId, id],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("Shipment", id, ctx.tenantId);
    return result.rows[0].payload;
  }

  async getShipmentIncident(ctx: ToolContext, id: string): Promise<ShipmentIncident> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: ShipmentIncident }>(
      `SELECT payload FROM shipment_incidents WHERE tenant_id = $1 AND incident_id = $2`,
      [ctx.tenantId, id],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("ShipmentIncident", id, ctx.tenantId);
    return result.rows[0].payload;
  }

  async getRefundStatus(ctx: ToolContext, orderId: string): Promise<RefundTransaction[]> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: RefundTransaction }>(
      `SELECT payload FROM refund_transactions WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at DESC`,
      [ctx.tenantId, orderId],
    );
    return result.rows.map((r) => r.payload);
  }

  async proposeItemClaim(
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
  ): Promise<ItemClaim> {
    this.check(ctx, "draft");
    await this.ensureTenant(ctx.tenantId);
    const now = new Date().toISOString();
    const claim: ItemClaim = {
      id: this.nextId("claim"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      orderId: input.orderId,
      lineId: input.lineId,
      claimType: input.claimType,
      quantity: input.quantity,
      ...(input.evidenceIds !== undefined ? { evidenceIds: input.evidenceIds } : {}),
      status: "submitted",
      createdAt: now,
      updatedAt: now,
    };
    await this.pool.query(
      `INSERT INTO item_claims (tenant_id, claim_id, order_id, line_id, claim_type, status, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.tenantId, claim.id, claim.orderId, claim.lineId, claim.claimType, claim.status, claim],
    );
    return claim;
  }

  async getOrderLineClaimEvidence(
    ctx: ToolContext,
    q: { orderId: string; lineId?: string },
  ): Promise<Evidence[]> {
    this.check(ctx, "read");
    let sql = `SELECT payload FROM evidence
                WHERE tenant_id = $1 AND payload->'data'->>'orderId' = $2`;
    const params: unknown[] = [ctx.tenantId, q.orderId];
    if (q.lineId !== undefined) {
      params.push(q.lineId);
      sql += ` AND payload->'data'->>'lineId' = $${params.length}`;
    }
    const result = await this.pool.query<{ payload: Evidence }>(sql, params);
    return result.rows.map((r) => r.payload);
  }

  async getExchangeEligibility(
    ctx: ToolContext,
    _input: { orderId: string; originalLineId: string; replacementSku: string },
  ): Promise<ExchangeEligibility> {
    this.check(ctx, "read");
    // Reference adapter cannot resolve replacement inventory — fail closed.
    return { eligible: false, inventoryStatus: "unknown" };
  }

  // ==================== SaaS reads ====================

  async getSubscription(ctx: ToolContext, id: string): Promise<Subscription> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: Subscription }>(
      `SELECT payload FROM subscriptions WHERE tenant_id = $1 AND subscription_id = $2`,
      [ctx.tenantId, id],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("Subscription", id, ctx.tenantId);
    return result.rows[0].payload;
  }

  async listInvoices(ctx: ToolContext, customerId: string): Promise<Invoice[]> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: Invoice }>(
      `SELECT payload FROM invoices WHERE tenant_id = $1 AND customer_id = $2 ORDER BY created_at DESC`,
      [ctx.tenantId, customerId],
    );
    return result.rows.map((r) => r.payload);
  }

  async getCreditBalance(ctx: ToolContext, customerId: string): Promise<CreditBalance> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: CreditBalance }>(
      `SELECT payload FROM credit_balances WHERE tenant_id = $1 AND customer_id = $2`,
      [ctx.tenantId, customerId],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("CreditBalance", customerId, ctx.tenantId);
    return result.rows[0].payload;
  }

  // ==================== Execution (not implemented) ====================

  async executeAction(_ctx: ToolContext, _proposal: ActionProposal): Promise<ExecutionResult> {
    throw new AdapterPermissionError(
      "PostgresSupportAdapter does not implement executeAction. " +
        "Use SandboxSupportAdapter for synthetic execution; live execution is disabled by spec.",
    );
  }

  // ==================== Evidence ====================

  async captureEvidence(
    ctx: ToolContext,
    input: Omit<Evidence, "id" | "specVersion" | "createdAt">,
  ): Promise<Evidence> {
    this.check(ctx, "draft");
    await this.ensureTenant(ctx.tenantId);
    const evidence: Evidence = {
      ...input,
      id: this.nextId("ev"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      createdAt: new Date().toISOString(),
    };
    await this.pool.query(
      `INSERT INTO evidence (tenant_id, evidence_id, case_id, kind, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [ctx.tenantId, evidence.id, evidence.caseId ?? null, evidence.kind, evidence],
    );
    return evidence;
  }

  async getEvidence(ctx: ToolContext, id: string): Promise<Evidence> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: Evidence }>(
      `SELECT payload FROM evidence WHERE tenant_id = $1 AND evidence_id = $2`,
      [ctx.tenantId, id],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("Evidence", id, ctx.tenantId);
    return result.rows[0].payload;
  }

  async listEvidence(ctx: ToolContext, q: { caseId?: string }): Promise<Evidence[]> {
    this.check(ctx, "read");
    let sql = `SELECT payload FROM evidence WHERE tenant_id = $1`;
    const params: unknown[] = [ctx.tenantId];
    if (q.caseId) {
      params.push(q.caseId);
      sql += ` AND case_id = $${params.length}`;
    }
    sql += ` ORDER BY created_at DESC`;
    const result = await this.pool.query<{ payload: Evidence }>(sql, params);
    return result.rows.map((r) => r.payload);
  }

  // ==================== Audit (P0-4: persistent chain) ====================

  async appendAuditEvent(
    ctx: ToolContext,
    e: Omit<AuditEvent, "id" | "specVersion" | "createdAt">,
  ): Promise<AuditEvent> {
    this.check(ctx, "draft");
    await this.ensureTenant(ctx.tenantId);

    // Chain head from the hydrated cache (P0-4: survives restarts).
    const head = this.auditChainHeads.get(ctx.tenantId);
    const sequence = (head?.sequence ?? 0) + 1;
    const previousHash = head?.lastHash ?? AUDIT_CHAIN_GENESIS_HASH;

    const event: AuditEvent = {
      ...e,
      id: this.nextId("audit"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      createdAt: new Date().toISOString(),
      sequence,
      previousHash,
    };
    event.eventHash = hashAuditEvent(event);

    await this.pool.query(
      `INSERT INTO audit_events (
         tenant_id, event_id, sequence, previous_hash, event_hash,
         event_type, actor_type, actor_id, case_id, proposal_id, approval_id,
         policy_version, model_info, detail, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        ctx.tenantId,
        event.id,
        sequence,
        previousHash,
        event.eventHash,
        event.eventType,
        event.actorType,
        event.actorId,
        event.caseId ?? null,
        event.proposalId ?? null,
        event.approvalId ?? null,
        event.policyVersion ?? null,
        event.modelInfo ?? null,
        event.detail,
        event.createdAt,
      ],
    );

    this.auditChainHeads.set(ctx.tenantId, { sequence, lastHash: event.eventHash });
    return event;
  }

  async listAuditEvents(
    ctx: ToolContext,
    q: { caseId?: string; proposalId?: string },
  ): Promise<AuditEvent[]> {
    this.check(ctx, "read");
    let sql = `SELECT event_id, sequence, previous_hash, event_hash, event_type,
                      actor_type, actor_id, case_id, proposal_id, approval_id,
                      policy_version, model_info, detail, created_at
                 FROM audit_events
                WHERE tenant_id = $1`;
    const params: unknown[] = [ctx.tenantId];
    if (q.caseId) {
      params.push(q.caseId);
      sql += ` AND case_id = $${params.length}`;
    }
    if (q.proposalId) {
      params.push(q.proposalId);
      sql += ` AND proposal_id = $${params.length}`;
    }
    sql += ` ORDER BY sequence ASC NULLS LAST, created_at ASC`;
    const result = await this.pool.query<{
      event_id: string;
      sequence: string | null;
      previous_hash: string | null;
      event_hash: string | null;
      event_type: AuditEvent["eventType"];
      actor_type: AuditEvent["actorType"];
      actor_id: string;
      case_id: string | null;
      proposal_id: string | null;
      approval_id: string | null;
      policy_version: string | null;
      model_info: AuditEvent["modelInfo"] | null;
      detail: Record<string, unknown>;
      created_at: Date;
    }>(sql, params);
    return result.rows.map((r) => {
      const event: AuditEvent = {
        id: r.event_id,
        specVersion: SPEC_VERSION,
        tenantId: ctx.tenantId,
        eventType: r.event_type,
        actorType: r.actor_type,
        actorId: r.actor_id,
        detail: r.detail,
        createdAt: r.created_at.toISOString(),
      };
      if (r.case_id) event.caseId = r.case_id;
      if (r.proposal_id) event.proposalId = r.proposal_id;
      if (r.approval_id) event.approvalId = r.approval_id;
      if (r.policy_version) event.policyVersion = r.policy_version;
      if (r.model_info) event.modelInfo = r.model_info;
      if (r.sequence !== null) event.sequence = Number(r.sequence);
      if (r.previous_hash) event.previousHash = r.previous_hash;
      if (r.event_hash) event.eventHash = r.event_hash;
      return event;
    });
  }

  // ==================== Approvals ====================

  async createApproval(
    ctx: ToolContext,
    a: Omit<Approval, "id" | "specVersion" | "createdAt">,
  ): Promise<Approval> {
    this.check(ctx, "draft");
    await this.ensureTenant(ctx.tenantId);
    const now = new Date().toISOString();
    const approval: Approval = {
      ...a,
      id: this.nextId("appr"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      createdAt: now,
      updatedAt: now,
    };
    await this.pool.query(
      `INSERT INTO approvals (tenant_id, approval_id, proposal_id, status, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [ctx.tenantId, approval.id, approval.proposalId, approval.status, approval],
    );
    return approval;
  }

  async getApproval(ctx: ToolContext, id: string): Promise<Approval> {
    this.check(ctx, "read");
    const result = await this.pool.query<{ payload: Approval }>(
      `SELECT payload FROM approvals WHERE tenant_id = $1 AND approval_id = $2`,
      [ctx.tenantId, id],
    );
    if (!result.rows[0]) throw PostgresSupportAdapter.notFound("Approval", id, ctx.tenantId);
    return result.rows[0].payload;
  }

  async listApprovals(ctx: ToolContext, q: { status?: Approval["status"] }): Promise<Approval[]> {
    this.check(ctx, "read");
    let sql = `SELECT payload FROM approvals WHERE tenant_id = $1`;
    const params: unknown[] = [ctx.tenantId];
    if (q.status) {
      params.push(q.status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY created_at DESC`;
    const result = await this.pool.query<{ payload: Approval }>(sql, params);
    return result.rows.map((r) => r.payload);
  }

  async decideApproval(
    ctx: ToolContext,
    id: string,
    decision: "approved" | "rejected",
    approverId: string,
    comment?: string,
  ): Promise<Approval> {
    this.check(ctx, "draft");
    const existing = await this.getApproval(ctx, id);
    const now = new Date().toISOString();
    const updated: Approval = {
      ...existing,
      status: decision,
      approverId,
      ...(comment !== undefined ? { comment } : {}),
      decidedAt: now,
      updatedAt: now,
    };
    await this.pool.query(
      `UPDATE approvals SET status = $1, payload = $2, updated_at = now()
        WHERE tenant_id = $3 AND approval_id = $4`,
      [decision, updated, ctx.tenantId, id],
    );
    return updated;
  }

  // ==================== Handoffs ====================

  async createHandoff(
    ctx: ToolContext,
    h: Omit<HumanHandoff, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">,
  ): Promise<HumanHandoff> {
    this.check(ctx, "draft");
    await this.ensureTenant(ctx.tenantId);
    const now = new Date().toISOString();
    const handoff: HumanHandoff = {
      ...h,
      id: this.nextId("hand"),
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    await this.pool.query(
      `INSERT INTO handoffs (tenant_id, handoff_id, case_id, proposal_id, status, reason, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.tenantId, handoff.id, handoff.caseId, handoff.proposalId ?? null, handoff.status, handoff.reason, handoff],
    );
    return handoff;
  }

  async listHandoffs(ctx: ToolContext, q: { status?: HumanHandoff["status"] }): Promise<HumanHandoff[]> {
    this.check(ctx, "read");
    let sql = `SELECT payload FROM handoffs WHERE tenant_id = $1`;
    const params: unknown[] = [ctx.tenantId];
    if (q.status) {
      params.push(q.status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY created_at DESC`;
    const result = await this.pool.query<{ payload: HumanHandoff }>(sql, params);
    return result.rows.map((r) => r.payload);
  }

  async updateHandoff(
    ctx: ToolContext,
    id: string,
    patch: Partial<Pick<HumanHandoff, "status" | "assignedTo" | "notes" | "resolvedAt">>,
  ): Promise<HumanHandoff> {
    this.check(ctx, "draft");
    const existing = await this.pool.query<{ payload: HumanHandoff }>(
      `SELECT payload FROM handoffs WHERE tenant_id = $1 AND handoff_id = $2`,
      [ctx.tenantId, id],
    );
    if (!existing.rows[0]) throw PostgresSupportAdapter.notFound("HumanHandoff", id, ctx.tenantId);
    const updated: HumanHandoff = {
      ...existing.rows[0].payload,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.pool.query(
      `UPDATE handoffs SET status = $1, payload = $2, updated_at = now()
        WHERE tenant_id = $3 AND handoff_id = $4`,
      [updated.status, updated, ctx.tenantId, id],
    );
    return updated;
  }

  // ==================== Policy ====================

  async getPolicy(ctx: ToolContext, tenantId: string): Promise<TenantPolicy> {
    this.check(ctx, "read");
    if (tenantId !== ctx.tenantId) {
      throw new AdapterPermissionError(`policy for tenant ${tenantId} not accessible from ${ctx.tenantId}`);
    }
    const result = await this.pool.query<{ policy: TenantPolicy }>(
      `SELECT policy FROM policy_versions
        WHERE tenant_id = $1 AND status = 'active'
        ORDER BY activated_at DESC LIMIT 1`,
      [tenantId],
    );
    if (!result.rows[0]) {
      throw new AdapterNotFoundError(`active TenantPolicy not found for tenant ${tenantId}`);
    }
    return result.rows[0].policy;
  }

  async putPolicy(ctx: ToolContext, policy: TenantPolicy): Promise<TenantPolicy> {
    this.check(ctx, "execute");
    if (policy.tenantId !== ctx.tenantId) {
      throw new AdapterPermissionError(`cannot write policy for tenant ${policy.tenantId} from ${ctx.tenantId}`);
    }
    // Legacy path: upsert the policy payload as the tenant's active version.
    // The versioned lifecycle (PolicyStore) is the preferred path; this keeps
    // the SupportAdapter contract satisfied for legacy embedders.
    await this.ensureTenant(ctx.tenantId);
    await this.pool.query(
      `INSERT INTO policy_versions (tenant_id, version, status, policy, created_by, activated_by, activated_at)
       VALUES ($1, $2, 'active', $3, 'system:legacy-import', 'system:legacy-import', now())
       ON CONFLICT (tenant_id, version) DO UPDATE SET status = 'active', policy = $3`,
      [policy.tenantId, policy.version, policy],
    );
    return policy;
  }
}
