import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  requireCapability,
  type GovernanceActor,
  type GovernanceCapability,
} from "@osas/governance";
import { SchemaInvalidError, ConflictError } from "../plugins.js";
import { ForbiddenError } from "../auth.js";
import { governanceActorForRequest } from "../governance.js";
import { audit } from "../domain.js";
import { ctxFor } from "./basic.js";

/**
 * Governance control-plane routes (M1).
 *
 * Everything here is tenant-scoped to the authenticated principal's tenant, and
 * every operation goes through the governance RBAC matrix — a route never
 * decides authorization on its own beyond naming the capability it needs.
 */

const requireGovernance = (actor: GovernanceActor, capability: GovernanceCapability): void => {
  requireCapability([...actor.roles], capability, actor.actorId);
};

/** Constant-time compare so the internal ingest key cannot be probed by timing. */
function secretEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export async function governanceRoutes(app: FastifyInstance): Promise<void> {
  const runtime = () => app.governance;

  app.get("/v1/governance/health", async (req) => {
    const actor = governanceActorForRequest(req);
    return runtime().health(actor, req.tenantId);
  });

  app.post("/v1/governance/workspaces", async (req) => {
    const actor = governanceActorForRequest(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const organizationName = asString(body.organizationName);
    const workspaceName = asString(body.workspaceName);
    if (!organizationName || !workspaceName) {
      throw new SchemaInvalidError([
        { message: "body must be { organizationName: string, workspaceName: string }" },
      ]);
    }
    // A principal may only provision its own tenant: cross-tenant provisioning
    // would let one customer create control-plane state inside another.
    const requestedTenant = asString(body.tenantId);
    if (requestedTenant && requestedTenant !== req.tenantId) {
      throw new ForbiddenError("a principal may only provision its own tenant");
    }
    const result = await runtime().provisionWorkspace(actor, {
      organizationName,
      workspaceName,
      tenantId: req.tenantId,
    });
    return result;
  });

  app.get("/v1/governance/connections", async (req) => {
    const actor = governanceActorForRequest(req);
    const q = req.query as { status?: string; provider?: string };
    return runtime().connections.list(actor, req.tenantId, {
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.provider ? { provider: q.provider } : {}),
    });
  });

  app.post("/v1/governance/connections", async (req) => {
    const actor = governanceActorForRequest(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = asString(body.provider);
    const externalAccountId = asString(body.externalAccountId);
    const capabilities = Array.isArray(body.capabilities) ? body.capabilities : undefined;
    if (!provider || !externalAccountId || !capabilities?.every((c) => typeof c === "string")) {
      throw new SchemaInvalidError([
        {
          message:
            "body must be { provider: string, externalAccountId: string, capabilities: string[], scopes?, apiVersion?, credentialRef?, displayName? }",
        },
      ]);
    }
    return runtime().connections.create(actor, {
      tenantId: req.tenantId,
      provider,
      externalAccountId,
      capabilities: capabilities as string[],
      ...(asString(body.displayName) ? { displayName: asString(body.displayName)! } : {}),
      ...(Array.isArray(body.scopes) ? { scopes: body.scopes as string[] } : {}),
      ...(asString(body.apiVersion) ? { apiVersion: asString(body.apiVersion)! } : {}),
      ...(asString(body.credentialRef) ? { credentialRef: asString(body.credentialRef)! } : {}),
    });
  });

  app.get("/v1/governance/connections/:id", async (req) => {
    const actor = governanceActorForRequest(req);
    const { id } = req.params as { id: string };
    return runtime().connections.get(actor, req.tenantId, id);
  });

  app.post("/v1/governance/connections/:id/verify", async (req) => {
    const actor = governanceActorForRequest(req);
    const { id } = req.params as { id: string };
    return runtime().connections.verify(actor, req.tenantId, id);
  });

  app.post("/v1/governance/connections/:id/pause", async (req) => {
    const actor = governanceActorForRequest(req);
    const { id } = req.params as { id: string };
    return runtime().connections.pause(actor, req.tenantId, id);
  });

  app.post("/v1/governance/connections/:id/resume", async (req) => {
    const actor = governanceActorForRequest(req);
    const { id } = req.params as { id: string };
    return runtime().connections.resume(actor, req.tenantId, id);
  });

  app.post("/v1/governance/connections/:id/rotate", async (req) => {
    const actor = governanceActorForRequest(req);
    const { id } = req.params as { id: string };
    const credentialRef = asString((req.body as Record<string, unknown>)?.credentialRef);
    if (!credentialRef) {
      throw new SchemaInvalidError([{ message: "body must be { credentialRef: string }" }]);
    }
    return runtime().connections.rotateCredential(actor, req.tenantId, id, credentialRef);
  });

  app.post("/v1/governance/connections/:id/revoke", async (req) => {
    const actor = governanceActorForRequest(req);
    const { id } = req.params as { id: string };
    return runtime().connections.revoke(actor, req.tenantId, id);
  });

  app.delete("/v1/governance/connections/:id", async (req, reply) => {
    const actor = governanceActorForRequest(req);
    const { id } = req.params as { id: string };
    await runtime().connections.remove(actor, req.tenantId, id);
    return reply.code(204).send();
  });

  /**
   * Internal event ingest. Signature verification belongs at the edge (the
   * deployment's webhook receiver); this endpoint is the trusted internal path,
   * so it is gated by an internal key and NEVER accepts a client-supplied
   * "signatureVerified" flag. An absent key disables the endpoint entirely.
   */
  app.post("/v1/governance/integration-events", async (req) => {
    if (!app.governanceEventKey) {
      throw new ConflictError(
        "Governance event ingestion is not configured (set OSAS_GOVERNANCE_EVENT_KEY)",
      );
    }
    const provided = req.headers["x-osas-governance-key"];
    if (typeof provided !== "string" || !secretEquals(provided, app.governanceEventKey)) {
      throw new ForbiddenError("invalid governance event key");
    }
    const actor = governanceActorForRequest(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const connectionId = asString(body.connectionId);
    const topic = asString(body.topic);
    const externalEventId = asString(body.externalEventId);
    const occurredAt = asString(body.occurredAt);
    if (!connectionId || !topic || !externalEventId || !occurredAt) {
      throw new SchemaInvalidError([
        {
          message:
            "body must be { connectionId: string, topic: string, externalEventId: string, occurredAt: ISO-8601, payload?: object }",
        },
      ]);
    }
    return runtime().intake.accept(actor, req.tenantId, {
      connectionId,
      topic,
      externalEventId,
      occurredAt,
      signatureVerified: true,
      ...(body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? { payload: body.payload as Record<string, unknown> }
        : {}),
    });
  });

  app.get("/v1/governance/integration-events", async (req) => {
    const actor = governanceActorForRequest(req);
    requireGovernance(actor, "event:read");
    const q = req.query as { connectionId?: string; status?: string; topic?: string; limit?: string };
    return runtime().stores.integrationEvents.list(
      req.tenantId,
      {
        ...(q.connectionId ? { connectionId: q.connectionId } : {}),
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.topic ? { topic: q.topic } : {}),
      },
      q.limit ? Math.min(Number(q.limit) || 100, 500) : 100,
    );
  });

  app.get("/v1/governance/jobs", async (req) => {
    const actor = governanceActorForRequest(req);
    requireGovernance(actor, "job:read");
    const q = req.query as { status?: string; kind?: string; limit?: string };
    return runtime().stores.jobs.list(
      req.tenantId,
      {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.kind ? { kind: q.kind as never } : {}),
      },
      q.limit ? Math.min(Number(q.limit) || 100, 500) : 100,
    );
  });

  /**
   * Run one worker sweep for this tenant. Operator-visible so a deployment
   * without a background worker can still drain its queue deterministically.
   */
  app.post("/v1/governance/jobs/drain", async (req) => {
    const actor = governanceActorForRequest(req);
    requireGovernance(actor, "job:operate");
    const limit = Number((req.body as Record<string, unknown>)?.limit ?? 10);
    return runtime().runner.runOnce({
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 10,
      tenantId: req.tenantId,
    });
  });

  app.get("/v1/governance/reconciliations", async (req) => {
    const actor = governanceActorForRequest(req);
    requireGovernance(actor, "reconciliation:read");
    const q = req.query as { status?: string; caseId?: string; limit?: string };
    return runtime().stores.reconciliations.list(
      req.tenantId,
      {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.caseId ? { caseId: q.caseId } : {}),
      },
      q.limit ? Math.min(Number(q.limit) || 100, 500) : 100,
    );
  });

  app.post("/v1/governance/reconciliations/:id/decide", async (req) => {
    const actor = governanceActorForRequest(req);
    requireGovernance(actor, "reconciliation:resolve");
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status === "resolved" || body.status === "dismissed" ? body.status : undefined;
    const resolution = asString(body.resolution);
    const expectedVersion = Number(body.expectedVersion);
    if (!status || !resolution || !Number.isInteger(expectedVersion)) {
      throw new SchemaInvalidError([
        {
          message:
            'body must be { status: "resolved" | "dismissed", resolution: string, expectedVersion: integer }',
        },
      ]);
    }
    const decided = await runtime().stores.reconciliations.decide(
      req.tenantId,
      id,
      { status, resolvedBy: actor.actorId, resolution },
      expectedVersion,
      new Date(),
    );
    // reconciliation_resolved is an existing normative audit event type, so the
    // governance plane can join the OSAS audit chain without a schema change.
    await audit(
      app.adapter,
      ctxFor(req),
      {
        eventType: "reconciliation_resolved",
        actorType: "human",
        actorId: actor.actorId,
        detail: {
          reconciliationId: decided.id,
          status: decided.status,
          resolution: decided.resolution,
          reason: decided.reason,
          jobRunId: decided.jobRunId,
        },
      },
      app.auditStore,
    );
    return decided;
  });

  app.get("/v1/governance/usage", async (req) => {
    const actor = governanceActorForRequest(req);
    requireGovernance(actor, "usage:read");
    const q = req.query as { kind?: string; from?: string; to?: string; limit?: string };
    const records = await runtime().stores.usage.list(
      req.tenantId,
      {
        ...(q.kind ? { kind: q.kind as never } : {}),
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
      },
      q.limit ? Math.min(Number(q.limit) || 200, 500) : 200,
    );
    return { records, summary: { count: records.length, total: await runtime().stores.usage.sum(req.tenantId) } };
  });
}
