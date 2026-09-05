import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { SupportAdapter, ToolContext } from "@osas/adapter";
import type { CaseStatus, Profile, TenantPolicy } from "@osas/core";
import * as schemaValidator from "@osas/schema-validator";
import { TOOL_DEFINITIONS } from "@osas/mcp-server";
import { API_VERSION, SPEC_VERSION, SchemaInvalidError, SYSTEM_PRINCIPAL } from "../plugins.js";
import { REPO_ROOT } from "../paths.js";
import { collectEvidence } from "../domain.js";

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

function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(version);
  if (!m) return version;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] ?? ""}`;
}

export async function basicRoutes(app: FastifyInstance): Promise<void> {
  const adapter: SupportAdapter = app.adapter;

  app.get("/health", async () => ({ status: "ok", specVersion: SPEC_VERSION, version: API_VERSION }));

  app.get("/v1/cases", async (req) => {
    const q = req.query as { status?: CaseStatus; customerId?: string; profile?: Profile; q?: string };
    const ctx = ctxFor(req);
    let cases = await adapter.searchCases(ctx, { status: q.status, customerId: q.customerId, q: q.q });
    if (q.profile) cases = cases.filter((c) => c.profile === q.profile);
    return cases;
  });

  app.get("/v1/cases/:id", async (req) => {
    const ctx = ctxFor(req);
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
    const { id } = req.params as { id: string };
    return adapter.getCustomer(ctxFor(req), id);
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
    const q = req.query as { caseId?: string; proposalId?: string };
    return adapter.listAuditEvents(ctxFor(req), { caseId: q.caseId, proposalId: q.proposalId });
  });

  app.get("/v1/policies/:tenantId", async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    return adapter.getPolicy(ctxFor(req, tenantId), tenantId);
  });

  app.put("/v1/policies/:tenantId", async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      throw new SchemaInvalidError([{ message: "body must be a TenantPolicy object" }]);
    }
    const candidate: Record<string, unknown> = { ...body, tenantId };
    const result = await validateSchema(POLICY_SCHEMA, candidate);
    if (!result.valid) throw new SchemaInvalidError(result.errors);
    const bumped = { ...candidate, version: bumpPatch(String(candidate.version ?? "0.1.0")) };
    return adapter.putPolicy(ctxFor(req, tenantId), bumped as TenantPolicy);
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
