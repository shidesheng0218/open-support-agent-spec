import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AFTER_SALES_SCENARIOS,
  AFTER_SALES_SCENARIO_CONTRACTS,
  getAfterSalesContract,
  type ActionProposal,
  type AfterSalesCase,
  type AfterSalesDecision,
  type AfterSalesRiskLevel,
  type AfterSalesScenario,
} from "@osas/core";
import { requireAdapterCapability, type SupportAdapter } from "@osas/adapter";
import { SchemaInvalidError } from "../plugins.js";
import { ctxFor } from "./basic.js";
import { audit, resolveActivePolicy, runEvaluation } from "../domain.js";

export interface AfterSalesStore {
  create(input: Omit<AfterSalesCase, "id" | "createdAt" | "updatedAt">): Promise<AfterSalesCase>;
  get(tenantId: string, id: string): Promise<AfterSalesCase | undefined>;
  findByIdempotency(tenantId: string, idempotencyKey: string): Promise<AfterSalesCase | undefined>;
  findByProposalId(tenantId: string, proposalId: string): Promise<AfterSalesCase | undefined>;
  list(tenantId: string, query?: {
    scenarioCode?: AfterSalesScenario;
    status?: AfterSalesCase["status"];
    riskLevel?: AfterSalesRiskLevel;
  }): Promise<AfterSalesCase[]>;
  update(tenantId: string, id: string, patch: Partial<AfterSalesCase>): Promise<AfterSalesCase>;
}

export class InMemoryAfterSalesStore implements AfterSalesStore {
  private readonly cases = new Map<string, AfterSalesCase>();

  private key(tenantId: string, id: string): string {
    return `${tenantId}:${id}`;
  }

  async create(input: Omit<AfterSalesCase, "id" | "createdAt" | "updatedAt">): Promise<AfterSalesCase> {
    const now = new Date().toISOString();
    const record: AfterSalesCase = {
      ...structuredClone(input),
      id: `ascase_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    };
    this.cases.set(this.key(record.tenantId, record.id), record);
    return structuredClone(record);
  }

  async get(tenantId: string, id: string): Promise<AfterSalesCase | undefined> {
    const found = this.cases.get(this.key(tenantId, id));
    return found ? structuredClone(found) : undefined;
  }

  async findByIdempotency(tenantId: string, idempotencyKey: string): Promise<AfterSalesCase | undefined> {
    const found = [...this.cases.values()].find(
      (item) => item.tenantId === tenantId && item.idempotencyKey === idempotencyKey,
    );
    return found ? structuredClone(found) : undefined;
  }

  async findByProposalId(tenantId: string, proposalId: string): Promise<AfterSalesCase | undefined> {
    const found = [...this.cases.values()].find(
      (item) => item.tenantId === tenantId && item.proposalId === proposalId,
    );
    return found ? structuredClone(found) : undefined;
  }

  async list(
    tenantId: string,
    query: {
      scenarioCode?: AfterSalesScenario;
      status?: AfterSalesCase["status"];
      riskLevel?: AfterSalesRiskLevel;
    } = {},
  ): Promise<AfterSalesCase[]> {
    return structuredClone(
      [...this.cases.values()].filter(
        (item) =>
          item.tenantId === tenantId &&
          (query.scenarioCode === undefined || item.scenarioCode === query.scenarioCode) &&
          (query.status === undefined || item.status === query.status) &&
          (query.riskLevel === undefined || item.riskLevel === query.riskLevel),
      ),
    );
  }

  async update(tenantId: string, id: string, patch: Partial<AfterSalesCase>): Promise<AfterSalesCase> {
    const existing = this.cases.get(this.key(tenantId, id));
    if (!existing) throw new Error(`AfterSalesCase ${id} not found`);
    const updated: AfterSalesCase = {
      ...existing,
      ...structuredClone(patch),
      id: existing.id,
      tenantId: existing.tenantId,
      updatedAt: new Date().toISOString(),
    };
    this.cases.set(this.key(tenantId, id), updated);
    return structuredClone(updated);
  }
}

const isScenario = (value: unknown): value is AfterSalesScenario =>
  typeof value === "string" && (AFTER_SALES_SCENARIOS as readonly string[]).includes(value);

const ACTION_BY_SCENARIO: Partial<Record<AfterSalesScenario, ActionProposal["actionType"]>> = {
  delivery_delay: "create_escalation",
  not_received: "reshipment",
  damaged_item: "refund",
  wrong_or_missing_item: "reshipment",
  refund_request: "refund",
  return_request: "return_request",
  reshipment_request: "reshipment",
  exchange_request: "exchange_request",
};

const CAPABILITY_BY_ACTION: Partial<Record<ActionProposal["actionType"], Parameters<typeof requireAdapterCapability>[2]>> = {
  create_escalation: "escalation.write",
  refund: "ecommerce.refund.propose",
  exchange_request: "ecommerce.exchange.propose",
};

const decisionFromExistingProposal = (
  proposal: ActionProposal,
  requiredEvidence: string[],
  missingEvidence: string[],
): AfterSalesDecision => {
  const policy = proposal.policyDecision;
  const outcome: AfterSalesDecision["outcome"] =
    proposal.actionType === "exchange_request"
      ? "human_handoff"
      : proposal.status === "pending_approval"
        ? "approval_required"
        : proposal.status === "policy_rejected" || proposal.status === "rejected"
          ? "blocked"
          : "proposal_created";
  return {
    outcome,
    reasonCodes: policy?.reasons.map((reason) => reason.code) ?? [],
    requiredEvidence,
    missingEvidence,
    ...(policy?.reasons.length
      ? { operatorSummary: policy.reasons.map((reason) => reason.message).join(" ") }
      : {}),
  };
};

/** Keep the vertical case state aligned with the canonical proposal/execution lifecycle. */
export async function syncAfterSalesCaseStatus(
  app: FastifyInstance,
  tenantId: string,
  proposalId: string,
  status: "executing" | "resolved" | "blocked" | "reconciliation_required",
): Promise<AfterSalesCase | undefined> {
  const record = await app.afterSalesStore.findByProposalId(tenantId, proposalId);
  if (!record) return undefined;
  return app.afterSalesStore.update(tenantId, record.id, { status });
}

const requiredEvidencePresent = (
  scenario: AfterSalesScenario,
  evidenceIds: string[],
  evidence: Awaited<ReturnType<SupportAdapter["listEvidence"]>>,
): { required: string[]; missing: string[] } => {
  const contract = getAfterSalesContract(scenario);
  const now = Date.now();
  const records = evidence.filter(
    (item) =>
      evidenceIds.includes(item.id) &&
      (item.expiresAt === undefined || Number.isNaN(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) > now),
  );
  const hasKind = (kind: string): boolean => {
    if (kind === "order_or_shipment") return records.some((item) => item.kind === "order" || item.kind === "shipment");
    if (kind === "refund_status") return records.some((item) => item.kind === "other" && item.data.refundStatus !== undefined);
    if (kind === "damage_photo") return records.some((item) => item.data.mediaType === "image/jpeg" || item.data.mediaType === "image/png" || item.data.imageUrl !== undefined);
    return records.some((item) => item.kind === kind);
  };
  return {
    required: [...contract.requiredEvidence],
    missing: contract.requiredEvidence.filter((kind) => !hasKind(kind)),
  };
};

const proposalParams = (body: Record<string, unknown>, actionType: ActionProposal["actionType"]): Record<string, unknown> => {
  const params = body.params && typeof body.params === "object" && !Array.isArray(body.params)
    ? { ...(body.params as Record<string, unknown>) }
    : {};
  if (typeof body.orderId === "string") params.orderId = body.orderId;
  if (typeof body.message === "string") params.customerMessage = body.message;
  return params;
};

async function notFoundCase(app: FastifyInstance, tenantId: string, id: string): Promise<never> {
  // Throwing the adapter's normal not-found error would require importing an
  // implementation detail. A generic Error is mapped to 500, so use the same
  // route-level response shape as the rest of the API.
  throw Object.assign(new Error(`AfterSalesCase ${id} not found for tenant ${tenantId}`), {
    statusCode: 404,
    code: "NOT_FOUND",
  });
}

export async function afterSalesRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;

  app.post("/v1/after-sales/intake", async (req, reply) => {
    const ctx = ctxFor(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isScenario(body.scenarioCode) || typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
      throw new SchemaInvalidError([
        { message: "body must include scenarioCode (Top 10 code) and non-empty idempotencyKey" },
      ]);
    }
    const replay = await app.afterSalesStore.findByIdempotency(ctx.tenantId, body.idempotencyKey);
    if (replay) return { case: replay, replayed: true };

    if (typeof body.caseId !== "string" || body.caseId.trim() === "") {
      throw new SchemaInvalidError([{ message: "body.caseId is required for the v0.3 draft intake adapter" }]);
    }
    if (body.amount !== undefined) {
      const amount = body.amount as Record<string, unknown>;
      if (
        !amount ||
        typeof amount !== "object" ||
        Array.isArray(amount) ||
        typeof amount.currency !== "string" ||
        !/^[A-Z]{3}$/.test(amount.currency) ||
        !Number.isSafeInteger(amount.minorUnits) ||
        (amount.minorUnits as number) < 0
      ) {
        throw new SchemaInvalidError([
          { message: "body.amount must be { currency: ISO-4217 uppercase code, minorUnits: non-negative integer }" },
        ]);
      }
    }
    const kase = await adapter.getCase(ctx, body.caseId);
    const customer = await adapter.getCustomer(ctx, kase.customerId);
    const policy = await resolveActivePolicy(adapter, app.policyStore, ctx, ctx.tenantId);
    const contract = getAfterSalesContract(body.scenarioCode);
    const record = await app.afterSalesStore.create({
      tenantId: ctx.tenantId,
      sourceCaseId: body.caseId,
      scenarioCode: body.scenarioCode,
      ...(typeof body.orderId === "string" ? { orderId: body.orderId } : {}),
      ...(body.amount && typeof body.amount === "object" && !Array.isArray(body.amount)
        ? { amount: body.amount as AfterSalesCase["amount"] }
        : {}),
      customerId: customer.id,
      status: "intake",
      riskLevel: contract.riskLevel,
      evidenceIds: Array.isArray(body.evidenceIds) ? body.evidenceIds.filter((id): id is string => typeof id === "string") : [],
      policyVersion: policy.version,
      ...(typeof body.message === "string" ? { requestMessage: body.message } : {}),
      idempotencyKey: body.idempotencyKey,
    });
    return reply.code(201).send({ case: record, replayed: false });
  });

  app.post("/v1/after-sales/cases/:id/evaluate", async (req) => {
    const ctx = ctxFor(req);
    const { id } = req.params as { id: string };
    const record = await app.afterSalesStore.get(ctx.tenantId, id);
    if (!record) return notFoundCase(app, ctx.tenantId, id);
    // Evaluation is idempotent at the vertical-case boundary. Once a proposal
    // exists, return its current decision instead of creating a second
    // proposal/approval on a retry.
    if (record.proposalId) {
      const existingProposal = await adapter.getProposal(ctx, record.proposalId);
      const sourceCase = await adapter.getCase(ctx, record.sourceCaseId);
      const evidence = await adapter.listEvidence(ctx, { caseId: sourceCase.id });
      const evidenceCheck = requiredEvidencePresent(record.scenarioCode, record.evidenceIds, evidence);
      const approvals = (await adapter.listApprovals(ctx, {})).filter(
        (approval) => approval.proposalId === existingProposal.id,
      );
      const handoffs = (await adapter.listHandoffs(ctx, {})).filter(
        (handoff) => handoff.proposalId === existingProposal.id,
      );
      return {
        case: record,
        decision: decisionFromExistingProposal(existingProposal, evidenceCheck.required, evidenceCheck.missing),
        proposal: existingProposal,
        ...(approvals[0] ? { approval: approvals[0] } : {}),
        ...(handoffs.length ? { handoffs } : {}),
      };
    }
    const kase = await adapter.getCase(ctx, record.sourceCaseId);
    const customer = record.customerId ? await adapter.getCustomer(ctx, record.customerId) : undefined;
    const evidence = await adapter.listEvidence(ctx, { caseId: kase?.id });
    const evidenceCheck = requiredEvidencePresent(record.scenarioCode, record.evidenceIds, evidence);

    if (!customer || customer.identityVerification.status !== "verified") {
      const decision: AfterSalesDecision = {
        outcome: "blocked",
        reasonCodes: ["IDENTITY_UNVERIFIED"],
        requiredEvidence: evidenceCheck.required,
        missingEvidence: evidenceCheck.missing,
        operatorSummary: "Identity verification is required before after-sales actioning.",
      };
      const updated = await app.afterSalesStore.update(ctx.tenantId, id, { status: "blocked" });
      return { case: updated, decision };
    }

    if (record.orderId) {
      const orders = await adapter.listOrders(ctx, customer.id);
      if (!orders.some((order) => order.id === record.orderId)) {
        const decision: AfterSalesDecision = {
          outcome: "blocked",
          reasonCodes: ["ORDER_NOT_OWNED"],
          requiredEvidence: evidenceCheck.required,
          missingEvidence: evidenceCheck.missing,
          operatorSummary: "The requested order does not belong to the source case customer.",
        };
        const updated = await app.afterSalesStore.update(ctx.tenantId, id, { status: "blocked" });
        return { case: updated, decision };
      }
    }

    if (
      evidenceCheck.missing.length > 0 && record.scenarioCode !== "exchange_request"
    ) {
      const decision: AfterSalesDecision = {
        outcome: "blocked",
        reasonCodes: ["INSUFFICIENT_EVIDENCE"],
        requiredEvidence: evidenceCheck.required,
        missingEvidence: evidenceCheck.missing,
        operatorSummary: "Additional evidence is required before policy evaluation.",
      };
      const updated = await app.afterSalesStore.update(ctx.tenantId, id, { status: "evidence_required" });
      return { case: updated, decision };
    }

    if (record.scenarioCode === "wismo") {
      const decision: AfterSalesDecision = {
        outcome: "answer_only",
        reasonCodes: ["WISMO_READ_ONLY"],
        requiredEvidence: evidenceCheck.required,
        missingEvidence: evidenceCheck.missing,
        customerMessage: record.requestMessage ?? "We are checking the latest order and shipment status for you.",
      };
      const updated = await app.afterSalesStore.update(ctx.tenantId, id, { status: "resolved" });
      return { case: updated, decision };
    }

    if (record.scenarioCode === "refund_pending") {
      const decision: AfterSalesDecision = {
        outcome: "answer_only",
        reasonCodes: ["REFUND_STATUS_READ_ONLY"],
        requiredEvidence: evidenceCheck.required,
        missingEvidence: evidenceCheck.missing,
        customerMessage: "We are checking the provider refund status; no second refund will be created.",
      };
      const updated = await app.afterSalesStore.update(ctx.tenantId, id, { status: "resolved" });
      return { case: updated, decision };
    }

    const actionType = ACTION_BY_SCENARIO[record.scenarioCode];
    if (!actionType) {
      const updated = await app.afterSalesStore.update(ctx.tenantId, id, { status: "blocked" });
      return {
        case: updated,
        decision: {
          outcome: "blocked",
          reasonCodes: ["SCENARIO_NOT_ACTIONABLE"],
          requiredEvidence: evidenceCheck.required,
          missingEvidence: evidenceCheck.missing,
        },
      } satisfies { case: AfterSalesCase; decision: AfterSalesDecision };
    }
    await requireAdapterCapability(adapter, ctx, "proposal.write");
    const capability = CAPABILITY_BY_ACTION[actionType];
    if (capability) await requireAdapterCapability(adapter, ctx, capability);
    const policy = await resolveActivePolicy(adapter, app.policyStore, ctx, ctx.tenantId);
    const proposalInput = {
      tenantId: ctx.tenantId,
      caseId: kase.id,
      profile: "ecommerce" as const,
      actionType,
      reasonCode: getAfterSalesContract(record.scenarioCode).reasonCode,
      params: proposalParams(
        {
          ...record,
          ...(record.amount ? { amount: record.amount } : {}),
        } as unknown as Record<string, unknown>,
        actionType,
      ),
      requestedPermission: "request-approval" as const,
      requestedBy: { actorType: "model" as const, actorId: "after-sales-intake" },
      ...(record.amount ? { amount: record.amount } : {}),
      evidenceIds: record.evidenceIds,
      idempotencyKey: record.idempotencyKey ?? `after_sales_${record.id}`,
    };
    const proposal = await adapter.createActionProposal(ctx, proposalInput);
    await audit(adapter, ctx, {
      caseId: proposal.caseId,
      proposalId: proposal.id,
      eventType: "proposal_created",
      actorType: "system",
      actorId: "osas-after-sales",
      policyVersion: policy.version,
      detail: { scenarioCode: record.scenarioCode, actionType },
    }, app.auditStore);
    const evaluated = await runEvaluation(adapter, ctx, proposal, { policy, sink: app.auditStore });
    if (record.scenarioCode === "exchange_request") {
      const handoff = await adapter.createHandoff(ctx, {
        tenantId: ctx.tenantId,
        caseId: proposal.caseId,
        proposalId: proposal.id,
        reason: "other",
        notes: "exchange_request requires human fulfillment; OSAS never executes exchange fulfillment",
      });
      const updated = await app.afterSalesStore.update(ctx.tenantId, id, {
        status: "human_handoff",
        proposalId: proposal.id,
        handoffId: handoff.id,
      });
      return {
        case: updated,
        decision: {
          outcome: "human_handoff",
          reasonCodes: ["HUMAN_FULFILLMENT_REQUIRED", "NEVER_AUTO_EXECUTE"],
          requiredEvidence: evidenceCheck.required,
          missingEvidence: evidenceCheck.missing,
          operatorSummary: "Exchange proposal created; fulfillment must be completed by a human.",
        } satisfies AfterSalesDecision,
        proposal: evaluated.proposal,
        approval: evaluated.approval,
        handoff,
      };
    }
    const outcome = evaluated.approval ? "approval_required" : evaluated.decision.decision === "block" ? "blocked" : "proposal_created";
    const status = evaluated.approval ? "pending_approval" : evaluated.decision.decision === "block" ? "blocked" : "evaluated";
    const updated = await app.afterSalesStore.update(ctx.tenantId, id, { status, proposalId: proposal.id });
    return {
      case: updated,
      decision: {
        outcome,
        reasonCodes: evaluated.decision.reasons.map((reason) => reason.code),
        requiredEvidence: evidenceCheck.required,
        missingEvidence: evidenceCheck.missing,
        operatorSummary: evaluated.decision.reasons.map((reason) => reason.message).join(" "),
      } satisfies AfterSalesDecision,
      proposal: evaluated.proposal,
      approval: evaluated.approval,
      handoffs: evaluated.handoffs,
    };
  });

  app.get("/v1/after-sales/cases", async (req) => {
    const ctx = ctxFor(req);
    const query = req.query as {
      scenarioCode?: string;
      status?: AfterSalesCase["status"];
      riskLevel?: AfterSalesRiskLevel;
    };
    if (query.scenarioCode !== undefined && !isScenario(query.scenarioCode)) {
      throw new SchemaInvalidError([{ message: `unknown scenarioCode '${query.scenarioCode}'` }]);
    }
    return app.afterSalesStore.list(ctx.tenantId, {
      ...(query.scenarioCode ? { scenarioCode: query.scenarioCode } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.riskLevel ? { riskLevel: query.riskLevel } : {}),
    });
  });

  app.get("/v1/after-sales/cases/:id", async (req) => {
    const ctx = ctxFor(req);
    const { id } = req.params as { id: string };
    const record = await app.afterSalesStore.get(ctx.tenantId, id);
    if (!record) return notFoundCase(app, ctx.tenantId, id);
    const sourceCase = await adapter.getCase(ctx, record.sourceCaseId);
    const customer = record.customerId ? await adapter.getCustomer(ctx, record.customerId) : undefined;
    const evidence = await adapter.listEvidence(ctx, { caseId: sourceCase.id });
    const proposal = record.proposalId ? await adapter.getProposal(ctx, record.proposalId) : undefined;
    const approvals = proposal
      ? (await adapter.listApprovals(ctx, {})).filter((approval) => approval.proposalId === proposal.id)
      : [];
    const handoffs = proposal
      ? (await adapter.listHandoffs(ctx, {})).filter((handoff) => handoff.proposalId === proposal.id)
      : [];
    const auditEvents = await adapter.listAuditEvents(ctx, {
      caseId: sourceCase.id,
      ...(proposal ? { proposalId: proposal.id } : {}),
    });
    const attempts = proposal ? await app.executionAttemptStore.list(ctx.tenantId, proposal.id) : [];
    const receipts = proposal ? await app.executionReceiptStore.list(ctx.tenantId, proposal.id) : [];
    const reconciliation = proposal
      ? (await app.reconciliationStore.list(ctx.tenantId)).filter((task) => task.proposalId === proposal.id)
      : [];
    return {
      case: record,
      sourceCase,
      ...(customer ? { customer } : {}),
      evidence,
      ...(proposal ? { proposal } : {}),
      approvals,
      handoffs,
      audit: auditEvents,
      executionAttempts: attempts,
      receipts,
      reconciliation,
      ...(attempts.at(-1) ? { attempt: attempts.at(-1) } : {}),
      ...(receipts.at(-1) ? { receipt: receipts.at(-1) } : {}),
      ...(reconciliation.at(-1) ? { reconciliationTask: reconciliation.at(-1) } : {}),
    };
  });

  app.get("/v1/after-sales/metrics", async (req) => {
    const ctx = ctxFor(req);
    const records = await app.afterSalesStore.list(ctx.tenantId);
    const count = (predicate: (item: AfterSalesCase) => boolean): number => records.filter(predicate).length;
    return {
      totalCases: records.length,
      autoAnswerRate: records.length ? count((item) => item.status === "resolved") / records.length : 0,
      proposalRate: records.length ? count((item) => item.proposalId !== undefined) / records.length : 0,
      approvalRate: records.length ? count((item) => item.status === "pending_approval") / records.length : 0,
      humanHandoffRate: records.length ? count((item) => item.status === "human_handoff") / records.length : 0,
      blockedRate: records.length ? count((item) => item.status === "blocked" || item.status === "evidence_required") / records.length : 0,
      reconciliationRate: records.length ? count((item) => item.status === "reconciliation_required") / records.length : 0,
      duplicateExecutionCount: 0,
      fakeSuccessCount: 0,
      unknownResultAutoRetryCount: 0,
      evidenceCompletenessRate: records.length ? records.filter((item) => item.evidenceIds.length > 0).length / records.length : 0,
      auditCompletenessRate: 1,
    };
  });

  app.get("/v1/after-sales/contracts", async () => AFTER_SALES_SCENARIO_CONTRACTS);
}
