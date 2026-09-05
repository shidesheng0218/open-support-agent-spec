import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SupportAdapter, ToolContext } from "@osas/adapter";
import type { ActionProposal, Customer, Evidence, TenantPolicy } from "@osas/core";
import { PolicyVersionNotFoundError } from "@osas/policy-engine";
import { SPEC_VERSION, PolicyAdminRequiredError, SchemaInvalidError } from "../plugins.js";
import { assertTenantAccess } from "../auth.js";
import { audit, resolveActivePolicy, simulateProposal } from "../domain.js";
import { POLICY_SCHEMA, ctxFor, validateSchema } from "./basic.js";

/**
 * Policy version lifecycle (v0.1.1): draft -> simulated -> approved -> active
 * -> retired. All mutations require the policy_admin role; every change is
 * written to the tenant's audit stream.
 */

// Milestone 2: the role source is the authenticated principal (demo headers
// or JWT claims), resolved by the auth preHandler — this is the single seam.
export function policyAdminActor(req: FastifyRequest): { actorId: string } {
  if (!req.principal.roles.includes("policy_admin")) throw new PolicyAdminRequiredError();
  return { actorId: req.principal.actorId };
}

function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(version);
  if (!m) return version;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] ?? ""}`;
}

const asString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new SchemaInvalidError([{ message: `missing or invalid required field "${field}"` }]);
  }
  return value;
};

export async function policyRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;
  const store = app.policyStore;

  // Seed the adapter's legacy policy as the initial active version when the
  // tenant has one; tenants without a legacy policy start empty.
  const seedLegacy = async (tenantId: string, ctx: ToolContext): Promise<void> => {
    try {
      await resolveActivePolicy(adapter, store, ctx, tenantId);
    } catch (err) {
      if ((err as Error).name !== "AdapterNotFoundError") throw err;
    }
  };

  app.get("/v1/policies/:tenantId/versions", async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    assertTenantAccess(req, tenantId);
    const ctx = ctxFor(req, tenantId);
    await seedLegacy(tenantId, ctx);
    return store.list(tenantId);
  });

  app.post("/v1/policies/:tenantId/drafts", async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    assertTenantAccess(req, tenantId);
    const { actorId } = policyAdminActor(req);
    const ctx = ctxFor(req, tenantId);
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new SchemaInvalidError([{ message: "body must be a TenantPolicy object" }]);
    }
    await seedLegacy(tenantId, ctx);
    const now = new Date().toISOString();
    const candidate: Record<string, unknown> = {
      ...body,
      id: typeof body.id === "string" ? body.id : `pol_${randomUUID()}`,
      specVersion: SPEC_VERSION,
      tenantId,
      createdAt: typeof body.createdAt === "string" ? body.createdAt : now,
      updatedAt: now,
    };
    if (candidate.version === undefined) {
      const versions = await store.list(tenantId);
      const latest = versions[versions.length - 1]?.version ?? "0.1.0";
      candidate.version = bumpPatch(latest);
    }
    const result = await validateSchema(POLICY_SCHEMA, candidate);
    if (!result.valid) throw new SchemaInvalidError(result.errors);
    const draft = await store.createDraft(tenantId, candidate as unknown as TenantPolicy, actorId);
    await audit(adapter, ctx, {
      eventType: "policy_draft_created",
      actorType: "human",
      actorId,
      policyVersion: draft.version,
      detail: { version: draft.version, rules: draft.rules.length },
    }, app.auditStore);
    return reply.code(201).send(draft);
  });

  // Pure evaluation: returns only the decision + reasons. No Approval,
  // Execution, Handoff, or business write is produced; the draft->simulated
  // lifecycle transition itself is a policy change and is audited.
  app.post("/v1/policies/:tenantId/simulate", async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    assertTenantAccess(req, tenantId);
    const { actorId } = policyAdminActor(req);
    const ctx = ctxFor(req, tenantId);
    const body = (req.body ?? {}) as {
      version?: string;
      proposal?: Record<string, unknown>;
      customer?: Customer | string;
      evidence?: Evidence[];
      injectionSuspected?: boolean;
    };
    const version = asString(body.version, "version");
    const record = await store.get(tenantId, version);
    if (!record) {
      throw new PolicyVersionNotFoundError(tenantId, version);
    }
    if (!body.proposal || typeof body.proposal !== "object") {
      throw new SchemaInvalidError([{ message: "body.proposal must be an ActionProposal-like object" }]);
    }
    const now = new Date().toISOString();
    const p = body.proposal;
    const proposal: ActionProposal = {
      id: `sim_${randomUUID()}`,
      specVersion: SPEC_VERSION,
      tenantId,
      caseId: asString(p.caseId, "proposal.caseId"),
      profile: p.profile as ActionProposal["profile"],
      actionType: p.actionType as ActionProposal["actionType"],
      reasonCode: typeof p.reasonCode === "string" ? p.reasonCode : "other",
      params: (p.params ?? {}) as Record<string, unknown>,
      requestedPermission: "request-approval",
      requestedBy: { actorType: "human", actorId: "policy-simulation" },
      ...(p.amount !== undefined ? { amount: p.amount as ActionProposal["amount"] } : {}),
      evidenceIds: Array.isArray(p.evidenceIds) ? (p.evidenceIds as string[]) : [],
      idempotencyKey: `sim_${randomUUID()}`,
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    };
    let customer: Customer | undefined;
    if (typeof body.customer === "string") {
      customer = await adapter.getCustomer(ctx, body.customer);
    } else if (body.customer && typeof body.customer === "object") {
      customer = body.customer;
    }
    const decision = simulateProposal(proposal, {
      customer,
      evidence: Array.isArray(body.evidence) ? body.evidence : [],
      policy: record,
      ...(body.injectionSuspected !== undefined
        ? { injectionSuspected: body.injectionSuspected }
        : {}),
    });
    // Lifecycle: a successful simulation marks the version simulated.
    const simulated = await store.markSimulated(tenantId, version);
    await audit(adapter, ctx, {
      eventType: "policy_simulated",
      actorType: "human",
      actorId,
      policyVersion: version,
      detail: { version, decision: decision.decision, reasons: decision.reasons },
    }, app.auditStore);
    return { decision, policyVersion: simulated };
  });

  app.post("/v1/policies/:tenantId/versions/:version/approve", async (req) => {
    const { tenantId, version } = req.params as { tenantId: string; version: string };
    assertTenantAccess(req, tenantId);
    const { actorId } = policyAdminActor(req);
    const ctx = ctxFor(req, tenantId);
    const approved = await store.approve(tenantId, version, actorId);
    await audit(adapter, ctx, {
      eventType: "policy_approved",
      actorType: "human",
      actorId,
      policyVersion: version,
      detail: { version },
    }, app.auditStore);
    return approved;
  });

  app.post("/v1/policies/:tenantId/versions/:version/activate", async (req) => {
    const { tenantId, version } = req.params as { tenantId: string; version: string };
    assertTenantAccess(req, tenantId);
    const { actorId } = policyAdminActor(req);
    const ctx = ctxFor(req, tenantId);
    const previous = await store.getActive(tenantId);
    const { activated, superseded } = await store.activate(tenantId, version, actorId);
    await audit(adapter, ctx, {
      eventType: "policy_activated",
      actorType: "human",
      actorId,
      policyVersion: version,
      detail: {
        actorId,
        at: activated.activatedAt,
        previousVersion: previous?.version ?? null,
        newVersion: version,
      },
    }, app.auditStore);
    if (superseded) {
      await audit(adapter, ctx, {
        eventType: "policy_retired",
        actorType: "system",
        actorId: "osas-api",
        policyVersion: superseded.version,
        detail: { version: superseded.version, supersededBy: version },
      }, app.auditStore);
    }
    return { activated, ...(superseded ? { superseded } : {}) };
  });

  app.post("/v1/policies/:tenantId/versions/:version/retire", async (req) => {
    const { tenantId, version } = req.params as { tenantId: string; version: string };
    assertTenantAccess(req, tenantId);
    const { actorId } = policyAdminActor(req);
    const ctx = ctxFor(req, tenantId);
    const retired = await store.retire(tenantId, version, actorId);
    await audit(adapter, ctx, {
      eventType: "policy_retired",
      actorType: "human",
      actorId,
      policyVersion: version,
      detail: { version },
    }, app.auditStore);
    return retired;
  });
}
