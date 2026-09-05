import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { SupportAdapter } from "@osas/adapter";
import type { Evidence, ShadowRunOutcome } from "@osas/core";
import { detectInjection } from "@osas/core";
import { evaluateProposal } from "@osas/policy-engine";
import {
  ShadowRunNotFoundError,
  planShadowRun,
  reviewShadowRun,
} from "@osas/ecommerce-shadow";
import { SchemaInvalidError } from "../plugins.js";
import { requireRole } from "../auth.js";
import { audit, collectEvidence, resolveActivePolicy } from "../domain.js";
import { ctxFor } from "./basic.js";

/**
 * Shadow Mode routes (v0.1.1 Milestone 3).
 *
 * Shadow Mode ONLY: creates proposals (existing route), simulates policy
 * decisions, records what would have been auto-executed (ShadowRun), and
 * lets humans write the final outcome. It NEVER executes the suggested
 * action and NEVER transitions a proposal to "executed" — the execute route
 * refuses proposals under shadow review (see proposals.ts).
 */
export async function shadowRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;

  const embed = async (req: { tenantId: string }, runProposalId: string) => {
    const ctx = ctxFor(req);
    try {
      return await adapter.getProposal(ctx, runProposalId);
    } catch {
      return undefined; // proposal store is the runtime adapter's; never fail the read
    }
  };

  const embedEvidence = async (
    req: { tenantId: string },
    evidenceIds: string[],
  ): Promise<Evidence[]> => collectEvidence(adapter, ctxFor(req), evidenceIds);

  app.post("/v1/proposals/:id/shadow-run", async (req, reply) => {
    requireRole(req, "support_agent", "policy_admin");
    const ctx = ctxFor(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { injectionSuspected?: boolean };
    const proposal = await adapter.getProposal(ctx, id);

    // Pure policy simulation: no status change, no Approval, no Handoff.
    const kase = await adapter.getCase(ctx, proposal.caseId);
    const customer = await adapter.getCustomer(ctx, kase.customerId);
    const evidence = await collectEvidence(adapter, ctx, proposal.evidenceIds);
    const policy = await resolveActivePolicy(adapter, app.policyStore, ctx, ctx.tenantId);
    const recentProposals = await adapter.listProposals(ctx, { caseId: proposal.caseId });
    const injectionSuspected =
      body.injectionSuspected ?? detectInjection(JSON.stringify(proposal.params ?? {}));

    const decision = evaluateProposal(proposal, {
      customer,
      evidence,
      policy,
      recentProposals,
      injectionSuspected,
    });

    const run = planShadowRun(proposal, decision, { id: `shadow_${randomUUID()}` });
    await app.shadowRunStore.create(run);
    await audit(
      adapter,
      ctx,
      {
        caseId: proposal.caseId,
        proposalId: proposal.id,
        eventType: "shadow_run_created",
        actorType: "policy_engine",
        actorId: "osas-api",
        policyVersion: decision.policyVersion,
        detail: {
          shadowRunId: run.id,
          decision: decision.decision,
          reasons: decision.reasons,
          wouldAutoExecute: run.wouldAutoExecute,
          suggestedAction: run.suggestedAction,
        },
      },
      app.auditStore,
    );
    return reply.code(201).send({ shadowRun: run, proposal, evidence });
  });

  app.get("/v1/shadow-runs", async (req) => {
    const q = req.query as { proposalId?: string; humanOutcome?: ShadowRunOutcome };
    const runs = await app.shadowRunStore.list(req.tenantId, {
      proposalId: q.proposalId,
      humanOutcome: q.humanOutcome,
    });
    return Promise.all(
      runs.map(async (shadowRun) => {
        const proposal = await embed(req, shadowRun.proposalId);
        const evidence = proposal ? await embedEvidence(req, proposal.evidenceIds) : [];
        return { shadowRun, proposal, evidence };
      }),
    );
  });

  app.get("/v1/shadow-runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    const run = await app.shadowRunStore.get(req.tenantId, id);
    if (!run) throw new ShadowRunNotFoundError(id, req.tenantId);
    const proposal = await embed(req, run.proposalId);
    const evidence = proposal ? await embedEvidence(req, proposal.evidenceIds) : [];
    return { shadowRun: run, proposal, evidence };
  });

  app.post("/v1/shadow-runs/:id/review", async (req) => {
    const principal = requireRole(req, "support_agent", "policy_admin");
    const ctx = ctxFor(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      outcome?: string;
      humanComment?: string;
      externalReference?: string;
    };
    if (
      body.outcome !== "accepted" &&
      body.outcome !== "rejected" &&
      body.outcome !== "modified"
    ) {
      throw new SchemaInvalidError([
        { message: 'body must be { outcome: "accepted" | "rejected" | "modified", humanComment?, externalReference? }' },
      ]);
    }
    const run = await app.shadowRunStore.get(ctx.tenantId, id);
    if (!run) throw new ShadowRunNotFoundError(id, ctx.tenantId);
    // Throws ShadowRunAlreadyReviewedError (→ 409) unless still pending.
    const reviewed = reviewShadowRun(run, {
      outcome: body.outcome,
      ...(body.humanComment !== undefined ? { humanComment: body.humanComment } : {}),
      ...(body.externalReference !== undefined
        ? { externalReference: body.externalReference }
        : {}),
    });
    await app.shadowRunStore.save(reviewed);
    await audit(
      adapter,
      ctx,
      {
        proposalId: run.proposalId,
        eventType: "shadow_run_reviewed",
        actorType: "human",
        actorId: principal.actorId,
        policyVersion: run.policyDecision.policyVersion,
        detail: {
          shadowRunId: run.id,
          outcome: body.outcome,
          ...(body.humanComment !== undefined ? { humanComment: body.humanComment } : {}),
          ...(body.externalReference !== undefined
            ? { externalReference: body.externalReference }
            : {}),
          wouldAutoExecute: run.wouldAutoExecute,
        },
      },
      app.auditStore,
    );
    const proposal = await embed(req, run.proposalId);
    const evidence = proposal ? await embedEvidence(req, proposal.evidenceIds) : [];
    return { shadowRun: reviewed, proposal, evidence };
  });
}
