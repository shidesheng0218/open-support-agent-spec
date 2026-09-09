import type { FastifyInstance } from "fastify";
import { requireAdapterCapability, type SupportAdapter } from "@osas/adapter";
import type { Approval } from "@osas/core";
import { SchemaInvalidError } from "../plugins.js";
import { audit, runExecution } from "../domain.js";
import { ctxFor } from "./basic.js";

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;

  app.get("/v1/approvals", async (req) => {
    const ctx = ctxFor(req);
    await requireAdapterCapability(adapter, ctx, "approval.read");
    const q = req.query as { status?: Approval["status"] };
    const approvals = await adapter.listApprovals(ctx, { status: q.status });
    return Promise.all(
      approvals.map(async (approval) => {
        const proposal = await adapter.getProposal(ctx, approval.proposalId).catch(() => undefined);
        return { ...approval, proposal };
      }),
    );
  });

  app.post("/v1/approvals/:id/decide", async (req) => {
    const ctx = ctxFor(req);
    await requireAdapterCapability(adapter, ctx, "approval.decide");
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { decision?: string; approverId?: string; comment?: string };
    if ((body.decision !== "approved" && body.decision !== "rejected") || !body.approverId) {
      throw new SchemaInvalidError([
        { message: 'body must be { decision: "approved" | "rejected", approverId: string, comment? }' },
      ]);
    }
    const approval = await adapter.decideApproval(ctx, id, body.decision, body.approverId, body.comment);
    await audit(adapter, ctx, {
      proposalId: approval.proposalId,
      approvalId: approval.id,
      eventType: "approval_decided",
      actorType: "human",
      actorId: body.approverId,
      policyVersion: approval.policyVersion,
      detail: { decision: body.decision, comment: body.comment },
    }, app.auditStore);

    const proposal = await adapter.getProposal(ctx, approval.proposalId);
    let execution: unknown;
    if (body.decision === "approved" && app.executionMode.mode === "sandbox") {
      // §5: human approval -> approved -> execute through the engine.
      await adapter.updateProposalStatus(ctx, proposal.id, "approved");
      const approved = await adapter.getProposal(ctx, proposal.id);
      execution = await runExecution(adapter, ctx, app.executionStore, approved, {
        sink: app.auditStore,
        mode: app.executionMode.mode,
        attemptStore: app.executionAttemptStore,
        receiptStore: app.executionReceiptStore,
        reconciliationStore: app.reconciliationStore,
        ...(app.pgPool ? { pgPool: app.pgPool } : {}),
      });
    } else if (body.decision === "approved") {
      // Proposal-only and Shadow modes record the human decision but never invoke an executor.
      await adapter.updateProposalStatus(ctx, proposal.id, "approved");
    } else {
      await adapter.updateProposalStatus(ctx, proposal.id, "rejected");
    }
    return { approval, execution };
  });
}
