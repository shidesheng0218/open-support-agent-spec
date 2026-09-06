import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConformanceConfig, ConfigError } from "./config.js";

const KEY = "test-only-conformance-key";
const ENV = {
  OSAS_CONFORMANCE_MODE: "true",
  OSAS_CONFORMANCE_KEY: KEY,
};

const APPS: FastifyInstance[] = [];
async function startApp(opts: Parameters<typeof buildApp>[0] = {}): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false, ...opts });
  APPS.push(app);
  return app;
}

afterEach(async () => {
  while (APPS.length > 0) await APPS.pop()!.close();
});

describe("loadConformanceConfig", () => {
  it("is disabled by default", () => {
    expect(loadConformanceConfig({})).toEqual({ enabled: false });
    expect(loadConformanceConfig({ OSAS_CONFORMANCE_MODE: "false" })).toEqual({ enabled: false });
  });

  it("requires OSAS_CONFORMANCE_KEY when enabled (fail closed)", () => {
    expect(() => loadConformanceConfig({ OSAS_CONFORMANCE_MODE: "true" })).toThrow(ConfigError);
  });

  it("refuses NODE_ENV=production (fail closed)", () => {
    expect(() =>
      loadConformanceConfig({
        OSAS_CONFORMANCE_MODE: "true",
        OSAS_CONFORMANCE_KEY: KEY,
        NODE_ENV: "production",
      }),
    ).toThrow(/production/);
  });

  it("rejects garbage values", () => {
    expect(() =>
      loadConformanceConfig({ OSAS_CONFORMANCE_MODE: "yes", OSAS_CONFORMANCE_KEY: KEY }),
    ).toThrow(ConfigError);
  });
});

describe("conformance endpoints", () => {
  it("are NOT registered when conformance mode is off", async () => {
    const app = await startApp();
    for (const method of ["POST", "GET"] as const) {
      const res = await app.inject({
        method,
        url: method === "POST" ? "/v1/conformance/reset" : "/v1/conformance/snapshot",
        headers: { "x-osas-conformance-key": KEY },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("reject requests without/with a wrong conformance key", async () => {
    const app = await startApp({ env: ENV });
    const missing = await app.inject({ method: "POST", url: "/v1/conformance/reset" });
    expect(missing.statusCode).toBe(403);
    const wrong = await app.inject({
      method: "POST",
      url: "/v1/conformance/reset",
      headers: { "x-osas-conformance-key": "wrong-key" },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it("reset restores the deterministic demo state", async () => {
    const app = await startApp({ env: ENV });
    const headers = { "x-osas-conformance-key": KEY };

    // Mutate state: a chat message creates usage + audit records.
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { caseId: "case_refund", message: "Please refund order ord_small, it arrived damaged ($25)" },
    });
    expect(chat.statusCode).toBe(200);
    const before = await app.inject({ method: "GET", url: "/v1/conformance/snapshot", headers });
    expect(before.json().counts.auditEvents).toBeGreaterThan(0);

    const reset = await app.inject({ method: "POST", url: "/v1/conformance/reset", headers });
    expect(reset.statusCode).toBe(200);
    const body = reset.json();
    expect(body.reset).toBe(true);
    expect(body.fixture).toBe("demo");
    // Demo fixtures re-seeded, side effects wiped (1 seeded proposal, 0 audit events).
    expect(body.snapshot.counts).toMatchObject({
      cases: 4,
      proposals: 1,
      auditEvents: 0,
      policyVersions: 0,
      shadowRuns: 0,
      usageRecords: 0,
    });
    expect(body.snapshot.auditChain.intact).toBe(true);
  });

  it("fixtures/load supports demo and empty", async () => {
    const app = await startApp({ env: ENV });
    const headers = { "x-osas-conformance-key": KEY };
    const empty = await app.inject({
      method: "POST",
      url: "/v1/conformance/fixtures/load",
      headers,
      payload: { name: "empty" },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().snapshot.counts.cases).toBe(0);

    const demo = await app.inject({
      method: "POST",
      url: "/v1/conformance/fixtures/load",
      headers,
      payload: { name: "demo" },
    });
    expect(demo.json().snapshot.counts.cases).toBe(4);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/conformance/fixtures/load",
      headers,
      payload: { name: "production-snapshot" },
    });
    expect(bad.statusCode).toBe(422);
  });

  it("fails closed at startup when production + conformance mode combine", async () => {
    await expect(
      buildApp({ logger: false, env: { ...ENV, NODE_ENV: "production" } }),
    ).rejects.toThrow(/production/);
  });

  it("fails closed at startup when the key is missing", async () => {
    await expect(
      buildApp({ logger: false, env: { OSAS_CONFORMANCE_MODE: "true" } }),
    ).rejects.toThrow(/OSAS_CONFORMANCE_KEY/);
  });
});
