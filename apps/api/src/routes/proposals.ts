import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireAdapterCapability, type SupportAdapter } from "@osas/adapter";
import type { Capability, ActionProposal, ProposalStatus } from "@osas/core";
import { SPEC_VERSION, SchemaInvalidError } from "../plugins.js";
import { audit, resolveActivePolicy, runEvaluation, runExecution, runReconcile } from "../domain.js";
import { PROPOSAL_SCHEMA, ctxFor, validateSchema } from "./basic.js";

/** Capability required to propose a given actionType (v0.1.1). */
const PROPOSE_CAPABILITY: Partial<Record<ActionProposal["actionType"], Capability>> = {
  refund: "ecommerce.refund.propose",
  credit_apply: "saas.credit.propose",
};

/** Capability required to execute a given actionType (v0.1.1). */
const EXECUTE_CAPABILITY: Partial<Record<ActionProposal["actionType"], Capability>> = {
  refund: "ecommerce.refund.execute",
};

export async function proposalRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;

  app.get("/v1/proposals", async (req) => {
    const q = req.query as { caseId?: string; status?: ProposalStatus };
    return adapter.listProposals(ctxFor(req), { caseId: q.caseId, status: q.status });
  });

  app.get("/v1/proposals/:id", async (req) => {
    const { id } = req.params as { id: string };
    return adapter.getProposal(ctxFor(req), id);
  });

  app.post("/v1/proposals", async (req, reply) => {
    const ctx = ctxFor(req);
    await requireAdapterCapability(adapter, ctx, "proposal.write");
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new SchemaInvalidError([{ message: "body must be an ActionProposal object" }]);
    }
    const actionCapability = PROPOSE_CAPABILITY[body.actionType as ActionProposal["actionType"]];
    if (actionCapability) await requireAdapterCapability(adapter, ctx, actionCapability);
    const now = new Date().toISOString();
    const candidate: Record<string, unknown> = {
      ...body,
      id: `prop_unvalidated_${randomUUID()}`,
      specVersion: SPEC_VERSION,
      tenantId: ctx.tenantId,
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    };
    const result = await validateSchema(PROPOSAL_SCHEMA, candidate);
    if (!result.valid) throw new SchemaInvalidError(result.errors);
    const input = {
      tenantId: candidate.tenantId,
      caseId: candidate.caseId,
      profile: candidate.profile,
      actionType: candidate.actionType,
      reasonCode: candidate.reasonCode,
      params: candidate.params,
      requestedPermission: candidate.requestedPermission,
      requestedBy: candidate.requestedBy,
      amount: candidate.amount,
      evidenceIds: candidate.evidenceIds,
      idempotencyKey: candidate.idempotencyKey,
      policyDecision: candidate.policyDecision,
    } as Omit<ActionProposal, "id" | "specVersion" | "status" | "createdAt" | "updatedAt">;
    const proposal = await adapter.createActionProposal(ctx, input);
    await audit(adapter, ctx, {
      caseId: proposal.caseId,
      proposalId: proposal.id,
      eventType: "proposal_created",
      actorType: "system",
      actorId: "osas-api",
      detail: { actionType: proposal.actionType, requestedBy: proposal.requestedBy },
    }, app.auditStore);
    return reply.code(201).send(proposal);
  });

  app.post("/v1/proposals/:id/evaluate", async (req) => {
    const ctx = ctxFor(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { injectionSuspected?: boolean };
    const proposal = await adapter.getProposal(ctx, id);
    const policy = await resolveActivePolicy(adapter, app.policyStore, ctx, ctx.tenantId);
    const outcome = await runEvaluation(adapter, ctx, proposal, {
      injectionSuspected: body.injectionSuspected,
      policy,
      sink: app.auditStore,
    });
    return { proposal: outcome.proposal, decision: outcome.decision };
  });

  app.post("/v1/proposals/:id/execute", async (req) => {
    const ctx = ctxFor(req);
    const { id } = req.params as { id: string };
    const proposal = await adapter.getProposal(ctx, id);
    const actionCapability = EXECUTE_CAPABILITY[proposal.actionType];
    if (actionCapability) await requireAdapterCapability(adapter, ctx, actionCapability);
    const outcome = await runExecution(adapter, ctx, app.executionStore, proposal, {
      sink: app.auditStore,
      ...(app.pgPool ? { pgPool: app.pgPool } : {}),
    });
    return { proposal: outcome.proposal, execution: outcome.execution, replayed: outcome.replayed };
  });

  app.post("/v1/proposals/:id/reconcile", async (req) => {
    const ctx = ctxFor(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { outcome?: string; note?: string };
    if (body.outcome !== "succeeded" && body.outcome !== "failed") {
      throw new SchemaInvalidError([{ message: 'body must be { outcome: "succeeded" | "failed", note? }' }]);
    }
    const proposal = await adapter.getProposal(ctx, id);
    return runReconcile(adapter, ctx, proposal, body.outcome, body.note, app.auditStore);
  });
}
