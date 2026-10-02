import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { createSeededAdapter } from "./seed.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    adapter: createSeededAdapter(),
    logger: false,
    auth: { mode: "demo", nodeEnv: "test" },
  });
});

afterAll(async () => {
  await app.close();
});

describe("GET /v1/openapi.json", () => {
  it("serves an OpenAPI 3.1 document of the v1 surface", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toContain("OSAS");
    // The stable surface, spot-checked across tags.
    for (const p of [
      "/health",
      "/v1/cases",
      "/v1/proposals",
      "/v1/proposals/{id}/evaluate",
      "/v1/proposals/{id}/execute",
      "/v1/approvals/{id}/decide",
      "/v1/audit/verify",
      "/v1/policies/{tenantId}/simulate",
      "/v1/shadow-runs",
      "/v1/chat",
    ]) {
      expect(doc.paths, `missing path ${p}`).toHaveProperty(p);
    }
  });

  it("embeds the authoritative schemas with rewritten internal refs", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    const doc = res.json() as {
      components: { schemas: Record<string, { properties?: Record<string, { $ref?: string }> }> };
    };
    const schemas = doc.components.schemas;
    // core + profiles land as components (dot-separated keys).
    expect(schemas).toHaveProperty("core.action-proposal");
    expect(schemas).toHaveProperty("core.tenant-policy");
    expect(schemas).toHaveProperty("profiles.ecommerce.order");
    expect(schemas).toHaveProperty("profiles.saas.subscription");
    // Tool input schemas stay out of the REST components (they are served by
    // /v1/schemas and /v1/meta/tools).
    expect(schemas).not.toHaveProperty("tools.osas_core_get_case");
    // File-relative refs were rewritten to component refs.
    const proposal = schemas["core.action-proposal"];
    expect(proposal?.properties?.tenantId?.$ref).toBe("#/components/schemas/core.common/$defs/Id");
    // No file-relative ref survives anywhere in the document.
    expect(JSON.stringify(doc)).not.toMatch(/\.\.?\/.*common\.json/);
  });

  it("marks the proposal create body with subset semantics and no required list", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    const doc = res.json() as {
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: Record<string, unknown> }> } }>>;
    };
    const schema =
      doc.paths["/v1/proposals"]?.post?.requestBody?.content["application/json"]?.schema;
    expect(schema).toBeDefined();
    expect(schema?.required).toBeUndefined();
    expect(String(schema?.description)).toContain("server-assigned");
  });
});
