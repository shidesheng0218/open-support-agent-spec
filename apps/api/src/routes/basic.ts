import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { requireAdapterCapability, type SupportAdapter, type ToolContext } from "@osas/adapter";
import type { CaseStatus, Profile } from "@osas/core";
import { verifyAuditChain } from "@osas/policy-engine";
import * as schemaValidator from "@osas/schema-validator";
import { TOOL_DEFINITIONS } from "@osas/mcp-server";
import {
  API_VERSION,
  SPEC_VERSION,
  PolicyImmutableError,
  SchemaInvalidError,
  SYSTEM_PRINCIPAL,
} from "../plugins.js";
import { REPO_ROOT } from "../paths.js";
import { assertTenantAccess } from "../auth.js";
import { collectEvidence, resolveActivePolicy } from "../domain.js";

const PROPOSAL_SCHEMA = "core/action-proposal";
const POLICY_SCHEMA = "core/tenant-policy";

export { PROPOSAL_SCHEMA, POLICY_SCHEMA };

export function ctxFor(req: { tenantId: string }, tenantId?: string): ToolContext {
  return { tenantId: tenantId ?? req.tenantId, principal: SYSTEM_PRINCIPAL };
}

function isUnknownSchema(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Unknown schema");
}

async function validateSchema(schemaName: string, data: unknown): Promise<{ valid: boolean; errors: unknown }> {
  try {
    const result = schemaValidator.validate(schemaName, data);
    return { valid: result.valid, errors: result.errors };
  } catch (err) {
    if (isUnknownSchema(err)) {
      return { valid: false, errors: [{ path: "", message: `Unknown schema: ${schemaName}` }] };
    }
    throw err;
  }
}

export { validateSchema };

export async function basicRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;

  app.get("/health", async () => ({ status: "ok", specVersion: SPEC_VERSION, version: API_VERSION }));

  // v0.1.1 discovery: what this implementation supports.
  app.get("/.well-known/osas", async (req) => {
    const manifest = adapter.getCapabilities ? await adapter.getCapabilities(ctxFor(req)) : null;
    return {
      specVersion: SPEC_VERSION,
      version: API_VERSION,
      executionMode: app.executionMode.mode,
      capabilities: manifest,
      endpoints: {
        capabilities: "/v1/capabilities",
        policies: "/v1/policies/:tenantId",
        auditVerify: "/v1/audit/verify",
        compatReport: "/v1/compat/report",
      },
    };
  });

  app.get("/v1/capabilities", async (req, reply) => {
    if (!adapter.getCapabilities) {
      return reply.code(404).send({
        error: {
          code: "CAPABILITIES_NOT_DECLARED",
          message: "This implementation does not publish a CapabilityManifest",
        },
      });
    }
    return adapter.getCapabilities(ctxFor(req));
  });

  app.get("/v1/cases", async (req) => {
    const q = req.query as { status?: CaseStatus; customerId?: string; profile?: Profile; q?: string };
    const ctx = ctxFor(req);
    await requireAdapterCapability(adapter, ctx, "case.read");
    let cases = await adapter.searchCases(ctx, { status: q.status, customerId: q.customerId, q: q.q });
    if (q.profile) cases = cases.filter((c) => c.profile === q.profile);
    return cases;
  });

  app.get("/v1/cases/:id", async (req) => {
    const ctx = ctxFor(req);
    await requireAdapterCapability(adapter, ctx, "case.read");
    const { id } = req.params as { id: string };
    const kase = await adapter.getCase(ctx, id);
    const customer = await adapter.getCustomer(ctx, kase.customerId);
    // Referenced evidence (case.evidenceIds) plus anything filed against the
    // case (evidence.caseId), deduped — never an empty stand-in.
    const referenced = await collectEvidence(adapter, ctx, kase.evidenceIds ?? []);
    const seen = new Set(referenced.map((e) => e.id));
    const filed = (await adapter.listEvidence(ctx, { caseId: id })).filter(
      (e) => !seen.has(e.id),
    );
    return { case: kase, customer, evidence: [...referenced, ...filed] };
  });

  app.get("/v1/customers/:id", async (req) => {
    const ctx = ctxFor(req);
    await requireAdapterCapability(adapter, ctx, "customer.read");
    const { id } = req.params as { id: string };
    return adapter.getCustomer(ctx, id);
  });

  app.post("/v1/validate", async (req) => {
    const body = req.body as { schemaName?: string; data?: unknown };
    if (!body || typeof body.schemaName !== "string") {
      throw new SchemaInvalidError([{ message: "body must be { schemaName: string, data: unknown }" }]);
    }
    const result = await validateSchema(body.schemaName, body.data);
    return { valid: result.valid, errors: result.errors };
  });

  app.get("/v1/schemas", async () => schemaValidator.loadManifest());

  app.get("/v1/schemas/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      return schemaValidator.loadSchema(name);
    } catch (err) {
      if (isUnknownSchema(err)) {
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: `Schema "${name}" not found` } });
      }
      throw err;
    }
  });

  app.get("/v1/meta/tools", async () => TOOL_DEFINITIONS);

  app.get("/v1/audit", async (req) => {
    const ctx = ctxFor(req);
    await requireAdapterCapability(adapter, ctx, "audit.read");
    const q = req.query as { caseId?: string; proposalId?: string };
    return adapter.listAuditEvents(ctx, { caseId: q.caseId, proposalId: q.proposalId });
  });

  // v0.1.1: verify the tenant's audit hash chain (tamper-evidence, not WORM).
  app.get("/v1/audit/verify", async (req) => {
    const ctx = ctxFor(req);
    await requireAdapterCapability(adapter, ctx, "audit.read");
    const events = await adapter.listAuditEvents(ctx, {});
    const result = verifyAuditChain(events);
    return { tenantId: ctx.tenantId, ...result };
  });

  app.get("/v1/policies/:tenantId", async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    assertTenantAccess(req, tenantId);
    const ctx = ctxFor(req, tenantId);
    const active = await resolveActivePolicy(adapter, app.policyStore, ctx, tenantId);
    // Return the pure TenantPolicy (schemas/core/tenant-policy.json has
    // additionalProperties: false); lifecycle metadata lives on /versions.
    const {
      status: _status,
      createdBy: _createdBy,
      simulatedAt: _simulatedAt,
      approvedBy: _approvedBy,
      approvedAt: _approvedAt,
      activatedBy: _activatedBy,
      activatedAt: _activatedAt,
      retiredBy: _retiredBy,
      retiredAt: _retiredAt,
      ...policy
    } = active as unknown as Record<string, unknown>;
    return policy;
  });

  // v0.1.1: the active policy is immutable. Change it through the versioned
  // lifecycle (drafts -> simulate -> approve -> activate), never in place.
  app.put("/v1/policies/:tenantId", async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    assertTenantAccess(req, tenantId);
    throw new PolicyImmutableError(tenantId);
  });

  app.get("/v1/compat/report", async (_req, reply) => {
    const reportPath =
      app.compatReportPath ?? path.join(REPO_ROOT, "tests", "compat", "report", "latest.json");
    const raw = await readFile(reportPath, "utf8").catch(() => undefined);
    if (!raw) {
      return reply.code(404).send({
        error: {
          code: "COMPAT_REPORT_NOT_GENERATED",
          message:
            "No compat report has been generated yet. Run `pnpm test:compat` to write " +
            "tests/compat/report/latest.json (Docker images generate it at build time).",
        },
      });
    }
    return reply.type("application/json").send(raw);
  });
}
