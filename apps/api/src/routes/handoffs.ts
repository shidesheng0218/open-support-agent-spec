import type { FastifyInstance } from "fastify";
import type { SupportAdapter } from "@osas/adapter";
import type { HumanHandoff } from "@osas/core";
import { SchemaInvalidError } from "../plugins.js";
import { audit } from "../domain.js";
import { ctxFor } from "./basic.js";
import { requireRole } from "../auth.js";

export async function handoffRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;

  app.get("/v1/handoffs", async (req) => {
    const q = req.query as { status?: HumanHandoff["status"] };
    return adapter.listHandoffs(ctxFor(req), { status: q.status });
  });

  app.post("/v1/handoffs/:id/claim", async (req) => {
    // P0-1 fix: only support_agent or policy_admin can claim handoffs
    requireRole(req, "support_agent", "policy_admin");
    const ctx = ctxFor(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { assignee?: string };
    if (!body.assignee) {
      throw new SchemaInvalidError([{ message: "body must be { assignee: string }" }]);
    }
    return adapter.updateHandoff(ctx, id, { status: "claimed", assignedTo: body.assignee });
  });

  app.post("/v1/handoffs/:id/resolve", async (req) => {
    // P0-1 fix: only support_agent or policy_admin can resolve handoffs
    requireRole(req, "support_agent", "policy_admin");
    const ctx = ctxFor(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { notes?: string };
    const handoff = await adapter.updateHandoff(ctx, id, {
      status: "resolved",
      notes: body.notes,
      resolvedAt: new Date().toISOString(),
    });
    await audit(adapter, ctx, {
      caseId: handoff.caseId,
      proposalId: handoff.proposalId,
      eventType: "handoff_resolved",
      actorType: "human",
      actorId: handoff.assignedTo ?? "osas-api",
      detail: { handoffId: handoff.id, notes: body.notes },
    }, app.auditStore);
    return handoff;
  });
}
