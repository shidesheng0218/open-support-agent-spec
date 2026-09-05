import type { FastifyInstance } from "fastify";
import type { ModelTask } from "@osas/model-gateway";
import { assertTenantAccess, requireRole } from "../auth.js";
import { SchemaInvalidError } from "../plugins.js";

const TASKS: readonly string[] = ["classify", "extract", "reply", "propose"];

/**
 * GET /v1/usage — operator-only model usage query (Milestone 2).
 * Roles: policy_admin or auditor. Filters: tenantId (must match the
 * principal's tenant), date (UTC day, YYYY-MM-DD), model, task.
 */
export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/usage", async (req) => {
    requireRole(req, "policy_admin", "auditor");
    const q = req.query as {
      tenantId?: string;
      date?: string;
      from?: string;
      to?: string;
      model?: string;
      task?: string;
    };
    const tenantId = q.tenantId ?? req.tenantId;
    assertTenantAccess(req, tenantId);

    let from = q.from;
    let to = q.to;
    if (q.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date)) {
        throw new SchemaInvalidError([{ message: "date must be YYYY-MM-DD (UTC)" }]);
      }
      from = `${q.date}T00:00:00.000Z`;
      const next = new Date(Date.parse(from) + 86_400_000);
      to = next.toISOString();
    }
    if (q.task && !TASKS.includes(q.task)) {
      throw new SchemaInvalidError([{ message: `task must be one of ${TASKS.join(", ")}` }]);
    }

    const query = {
      tenantId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(q.model ? { model: q.model } : {}),
      ...(q.task ? { task: q.task as ModelTask } : {}),
    };
    const records = await app.usageStore.query(query);
    const knownCostUsd = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    return {
      records,
      summary: {
        count: records.length,
        inputTokens: records.reduce((sum, r) => sum + r.inputTokens, 0),
        outputTokens: records.reduce((sum, r) => sum + r.outputTokens, 0),
        knownCostUsd,
        unknownCostCount: records.filter((r) => r.costUsd === undefined).length,
      },
    };
  });
}
