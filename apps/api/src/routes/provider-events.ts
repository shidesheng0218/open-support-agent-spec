import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ProviderEvent } from "@osas/core";
import { hashProviderPayload } from "@osas/ecommerce-shadow";
import { createValidator, resolveSchemasDir } from "@osas/schema-validator";
import { join } from "node:path";
import { ConflictError, SchemaInvalidError } from "../plugins.js";
import { ForbiddenError } from "../auth.js";
import { audit, runReconcile } from "../domain.js";
import { ctxFor } from "./basic.js";

export async function providerEventRoutes(app: FastifyInstance): Promise<void> {
  const executionValidator = createValidator(join(resolveSchemasDir(), "execution-v0.3"));
  app.get("/v1/reconciliation", async (req) => {
    const q = req.query as { status?: "open" | "resolved" };
    return app.reconciliationStore.list(req.tenantId, q.status);
  });

  app.get("/v1/executions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const attempt = await app.executionAttemptStore.get(req.tenantId, id);
    if (!attempt) return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Execution ${id} not found` } });
    const receipts = await app.executionReceiptStore.list(req.tenantId, attempt.proposalId);
    return { attempt, receipt: receipts.at(-1) };
  });

  app.post("/v1/provider-events", async (req) => {
    if (!app.providerEventKey) throw new ConflictError("Provider Event ingestion is not configured");
    const key = req.headers["x-osas-provider-key"];
    if (typeof key !== "string" || key !== app.providerEventKey) {
      throw new ForbiddenError("invalid provider event key");
    }
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.provider !== "string" || typeof body.providerEventId !== "string" ||
        typeof body.eventType !== "string" || typeof body.idempotencyKey !== "string" ||
        typeof body.occurredAt !== "string" || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      throw new SchemaInvalidError([
        { message: "body must include provider, providerEventId, eventType, idempotencyKey, occurredAt and object payload" },
      ]);
    }
    const payload = body.payload as Record<string, unknown>;
    const ctx = ctxFor(req);
    const event: ProviderEvent = {
      id: `provider_event_${randomUUID()}`,
      specVersion: "0.3",
      tenantId: ctx.tenantId,
      provider: body.provider,
      providerEventId: body.providerEventId,
      eventType: body.eventType,
      idempotencyKey: body.idempotencyKey,
      occurredAt: body.occurredAt,
      payloadHash: hashProviderPayload(payload),
      payload,
      createdAt: new Date().toISOString(),
    };
    const validation = executionValidator.validate("provider-event", event);
    if (!validation.valid) throw new SchemaInvalidError(validation.errors);
    const stored = await app.providerEventStore.append(event);
    if (stored.duplicate) return { duplicate: true, event: stored.event };

    await audit(app.adapter, ctx, {
      eventType: "provider_event_received",
      actorType: "adapter",
      actorId: body.provider,
      detail: {
        providerEventId: body.providerEventId,
        eventType: body.eventType,
        idempotencyKey: body.idempotencyKey,
        payloadHash: event.payloadHash,
      },
    }, app.auditStore);

    const proposals = await app.adapter.listProposals(ctx, {});
    const proposal = proposals.find((candidate) => candidate.idempotencyKey === event.idempotencyKey);
    if (!proposal) return { duplicate: false, event: stored.event };
    const tasks = await app.reconciliationStore.list(ctx.tenantId, "open");
    const task = tasks.find((candidate) => candidate.proposalId === proposal.id);
    const status = payload.status;
    if (!task || (status !== "succeeded" && status !== "failed")) {
      return { duplicate: false, event: stored.event, proposal };
    }
    const resolved = await runReconcile(
      app.adapter,
      ctx,
      proposal,
      status,
      `provider event ${event.providerEventId}`,
      app.auditStore,
      app.reconciliationStore,
    );
    const reconciliation = (await app.reconciliationStore.list(ctx.tenantId, "resolved"))
      .find((candidate) => candidate.id === task.id) ??
      await app.reconciliationStore.resolve(task, body.provider);
    return { duplicate: false, event: stored.event, proposal: resolved, reconciliation };
  });
}
