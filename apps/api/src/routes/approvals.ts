import type { FastifyInstance } from "fastify";
import type { ToolContext } from "@osas/adapter";
import { requireAdapterCapability, type SupportAdapter } from "@osas/adapter";
import type { Approval, TenantPolicy } from "@osas/core";
import {
  APPROVAL_TIMED_OUT,
  NonExecutableActionError,
  evaluateApprovalExpiry,
} from "@osas/policy-engine";
import { ConflictError, SchemaInvalidError } from "../plugins.js";
import { audit, resolveActivePolicy, runExecution } from "../domain.js";
import { ctxFor } from "./basic.js";
import { syncAfterSalesCaseStatus } from "./after-sales.js";

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;

  /**
   * Fail-safe approval lifecycle: present the effective status. A pending
   * approval past its deadline (policy `approval.timeoutSeconds` or an
   * explicit `expiresAt`) is reported as `expired` — denial by default. The
   * stored record is not mutated on read; the effective status is recomputed
   * deterministically on every read.
   */
  const effectiveApproval = async (ctx: ToolContext, approval: Approval): Promise<Approval> => {
    if (approval.status !== "pending") return approval;
    let policy: TenantPolicy | undefined;
    try {
      policy = await resolveActivePolicy(adapter, app.policyStore, ctx, ctx.tenantId);
    } catch {
      return approval; // no resolvable policy -> no derivable deadline
    }
    const verdict = evaluateApprovalExpiry(approval, policy, new Date());
    return verdict.status === "expired" ? { ...approval, status: "expired" } : approval;
  };

  app.get("/v1/approvals", async (req) => {
    const ctx = ctxFor(req);
    await requireAdapterCapability(adapter, ctx, "approval.read");
    const q = req.query as { status?: Approval["status"] };
    const approvals = await adapter.listApprovals(ctx, {});
    const effective = await Promise.all(approvals.map((a) => effectiveApproval(ctx, a)));
    const filtered = q.status ? effective.filter((a) => a.status === q.status) : effective;
    return Promise.all(
      filtered.map(async (approval) => {
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
    const existing = await adapter.getApproval(ctx, id);
    const effective = await effectiveApproval(ctx, existing);
    if (effective.status === "expired") {
      // Fail-safe: an undecided approval past its deadline is DENIED, never
      // approved. No decision is recorded; the refusal is audited.
      await audit(adapter, ctx, {
        proposalId: existing.proposalId,
        approvalId: existing.id,
        eventType: "approval_decided",
        actorType: "system",
        actorId: "osas-api",
        policyVersion: existing.policyVersion,
        detail: {
          decision: "expired",
          reason: APPROVAL_TIMED_OUT,
          expiresAt: existing.expiresAt,
          refusedApproverId: body.approverId,
        },
      }, app.auditStore);
      throw new ConflictError(
        `approval ${id} expired at ${existing.expiresAt ?? "its deadline"} without a decision ` +
          `(${APPROVAL_TIMED_OUT}); the fail-safe policy denies it — a new proposal is required`,
      );
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
    let execution: Awaited<ReturnType<typeof runExecution>> | undefined;
    if (body.decision === "approved" && app.executionMode.mode === "sandbox") {
      // §5: human approval -> approved -> execute through the engine.
      await adapter.updateProposalStatus(ctx, proposal.id, "approved");
      const approved = await adapter.getProposal(ctx, proposal.id);
      // exchange_request is intentionally non-executable. Keep its vertical
      // case in human_handoff while the execution engine fails closed; do not
      // expose a transient `executing` state for a human-only fulfillment.
      if (proposal.actionType !== "exchange_request") {
        await syncAfterSalesCaseStatus(app, ctx.tenantId, proposal.id, "executing");
      }
      if (proposal.actionType === "exchange_request") {
        throw new NonExecutableActionError(proposal.actionType);
      }
      execution = await runExecution(adapter, ctx, app.executionStore, approved, {
        sink: app.auditStore,
        mode: app.executionMode.mode,
        attemptStore: app.executionAttemptStore,
        receiptStore: app.executionReceiptStore,
        reconciliationStore: app.reconciliationStore,
        ...(app.pgPool ? { pgPool: app.pgPool } : {}),
      });
      await syncAfterSalesCaseStatus(
        app,
        ctx.tenantId,
        proposal.id,
        execution.execution.status === "succeeded"
          ? "resolved"
          : execution.execution.status === "uncertain"
            ? "reconciliation_required"
            : "blocked",
      );
    } else if (body.decision === "approved") {
      // Proposal-only and Shadow modes record the human decision but never invoke an executor.
      await adapter.updateProposalStatus(ctx, proposal.id, "approved");
    } else {
      await adapter.updateProposalStatus(ctx, proposal.id, "rejected");
      await syncAfterSalesCaseStatus(app, ctx.tenantId, proposal.id, "blocked");
    }
    return { approval, execution };
  });
}
