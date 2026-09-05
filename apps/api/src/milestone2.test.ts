import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuditEvent } from "@osas/core";
import {
  MockModelProvider,
  ModelGateway,
  type ModelProvider,
  type ModelResponse,
} from "@osas/model-gateway";
import { buildApp, createBudgetWarningAuditor } from "./app.js";
import { createSeededAdapter } from "./seed.js";

const OPERATOR = { "x-osas-role": "auditor" };
const ADMIN = { "x-osas-role": "policy_admin" };

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function start(opts: Parameters<typeof buildApp>[0] = {}): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false, ...opts });
  apps.push(app);
  return app;
}

function failingProvider(err: Error): ModelProvider {
  return {
    name: "failing",
    supports: () => true,
    complete: async () => {
      throw err;
    },
  };
}

function telemetry(costUsd?: number) {
  return {
    provider: "fake",
    model: "fake-v0",
    tier: "standard" as const,
    task: "reply" as const,
    inputTokens: 10,
    outputTokens: 10,
    latencyMs: 1,
    ...(costUsd !== undefined ? { costUsd } : {}),
    truncated: false,
  };
}

describe("GET /v1/usage (operator-only)", () => {
  it("records chat model calls and exposes them with filters", async () => {
    const app = await start();
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "I would like a refund for order ord_small in case_refund", caseId: "case_refund" },
    });
    expect(chat.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/v1/usage", headers: OPERATOR });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.count).toBeGreaterThanOrEqual(2);
    const tasks = (body.records as Array<{ task: string }>).map((r) => r.task);
    expect(tasks).toContain("classify");
    expect(tasks).toContain("propose");

    const byTask = await app.inject({ method: "GET", url: "/v1/usage?task=classify", headers: OPERATOR });
    expect((byTask.json().records as unknown[]).length).toBeGreaterThanOrEqual(1);
    for (const r of byTask.json().records as Array<{ task: string }>) expect(r.task).toBe("classify");

    const today = new Date().toISOString().slice(0, 10);
    const byDate = await app.inject({ method: "GET", url: `/v1/usage?date=${today}`, headers: OPERATOR });
    expect(byDate.json().summary.count).toBe(body.summary.count);
    const oldDate = await app.inject({ method: "GET", url: "/v1/usage?date=2000-01-01", headers: OPERATOR });
    expect(oldDate.json().summary.count).toBe(0);
  });

  it("requires an operator role", async () => {
    const app = await start();
    const denied = await app.inject({ method: "GET", url: "/v1/usage" }); // default: support_agent
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: "GET", url: "/v1/usage", headers: ADMIN });
    expect(ok.statusCode).toBe(200);
  });

  it("rejects cross-tenant filters", async () => {
    const app = await start();
    const res = await app.inject({
      method: "GET",
      url: "/v1/usage?tenantId=tenant_other",
      headers: OPERATOR,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TENANT_MISMATCH");
  });
});

describe("model failure degradation", () => {
  it("provider failure -> safe reply + handoff, never executes", async () => {
    const gateway = new ModelGateway([failingProvider(new Error("connection refused"))]);
    const app = await start({ gateway });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "refund please for case_refund ord_small", caseId: "case_refund" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toContain("human agent");
    expect(res.json().handoff?.reason).toBe("other");
    expect(res.json().proposal).toBeUndefined();
    // No execution audit events were produced.
    const auditRes = await app.inject({ method: "GET", url: "/v1/audit?caseId=case_refund" });
    const types = (auditRes.json() as AuditEvent[]).map((e) => e.eventType);
    expect(types).toContain("handoff_created");
    expect(types).not.toContain("execution_started");
  });

  it("budget exhaustion -> safe template + budget_exceeded audit, no provider call", async () => {
    const spy = vi.fn(async (): Promise<ModelResponse> => ({ text: "ok", telemetry: telemetry(0.6) }));
    const provider: ModelProvider = { name: "mock-local", supports: () => true, complete: spy };
    const gateway = new ModelGateway([provider], { dailyBudgetUsd: 1.0 });
    const app = await start({ gateway });
    // First chat: classify (0.6) then propose (0.6) — spend reaches 1.2 >= 1.0.
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "hello", caseId: "case_refund" },
    });
    expect(first.statusCode).toBe(200);
    // Second chat: blocked BEFORE any provider call — safe template + audit.
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "hello again", caseId: "case_refund" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toContain("budget");
    expect(spy).toHaveBeenCalledTimes(2); // the blocked chat never reached the provider
    const auditRes = await app.inject({ method: "GET", url: "/v1/audit?caseId=case_refund" });
    const types = (auditRes.json() as AuditEvent[]).map((e) => e.eventType);
    expect(types).toContain("budget_exceeded");
  });

  it("budget warning at 80% is audited as budget_warning", async () => {
    const pricey: ModelProvider = {
      name: "mock-local",
      supports: () => true,
      complete: async () => ({ text: "ok", telemetry: telemetry(0.9) }),
    };
    const adapter = createSeededAdapter();
    const gateway = new ModelGateway([pricey], {
      dailyBudgetUsd: 1.0,
      onBudgetWarning: createBudgetWarningAuditor(adapter, { warn: () => undefined }),
    });
    const app = await start({ gateway, adapter });
    await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "hello", caseId: "case_refund" },
    });
    // allow the fire-and-forget audit write to land; daily-scope warnings
    // are tenant-level (no caseId), so query the unfiltered stream.
    await new Promise((r) => setTimeout(r, 50));
    const auditRes = await app.inject({ method: "GET", url: "/v1/audit" });
    const warning = (auditRes.json() as AuditEvent[]).find((e) => e.eventType === "budget_warning");
    expect(warning?.detail).toMatchObject({ scope: "daily", capUsd: 1.0 });
  });

  it("unknown costs are marked, never fabricated, and visible in /v1/usage", async () => {
    const unpriced: ModelProvider = {
      name: "mock-local",
      supports: () => true,
      complete: async () => ({ text: "plain reply", telemetry: telemetry(undefined) }),
    };
    const gateway = new ModelGateway([unpriced]);
    const app = await start({ gateway });
    const res = await app.inject({ method: "POST", url: "/v1/chat", payload: { message: "hi" } });
    expect(res.statusCode).toBe(200);
    const usage = await app.inject({ method: "GET", url: "/v1/usage", headers: OPERATOR });
    expect(usage.json().summary.unknownCostCount).toBeGreaterThanOrEqual(2);
    expect(usage.json().summary.knownCostUsd).toBe(0);
  });

  it("mock provider remains the default (no env needed)", async () => {
    const app = await start();
    const res = await app.inject({ method: "POST", url: "/v1/chat", payload: { message: "hi there" } });
    expect(res.statusCode).toBe(200);
    const usage = await app.inject({ method: "GET", url: "/v1/usage?task=classify", headers: OPERATOR });
    const records = usage.json().records as Array<{ provider: string }>;
    expect(records[0]?.provider).toBe("mock-local");
  });
});

describe("startup fail-closed", () => {
  it("OSAS_STORAGE=postgres without DATABASE_URL fails at boot", async () => {
    await expect(
      buildApp({ logger: false, env: { OSAS_STORAGE: "postgres" } }),
    ).rejects.toThrowError(/DATABASE_URL/);
  });

  it("OSAS_STORAGE=postgres with an unreachable database fails at boot", async () => {
    await expect(
      buildApp({
        logger: false,
        env: { OSAS_STORAGE: "postgres", DATABASE_URL: "postgres://127.0.0.1:1/nope" },
      }),
    ).rejects.toThrow();
  }, 20000);

  it("openai-compatible requires base url and models", async () => {
    await expect(
      buildApp({ logger: false, env: { OSAS_LLM_PROVIDER: "openai-compatible" } }),
    ).rejects.toThrowError(/OSAS_LLM_BASE_URL/);
  });

  it("prices must be configured as a pair", async () => {
    await expect(
      buildApp({
        logger: false,
        env: {
          OSAS_LLM_PROVIDER: "openai-compatible",
          OSAS_LLM_BASE_URL: "https://llm.test/v1",
          OSAS_LLM_MODEL_FAST: "fast",
          OSAS_LLM_MODEL_STANDARD: "std",
          OSAS_LLM_INPUT_USD_PER_MTOKEN: "1",
        },
      }),
    ).rejects.toThrowError(/OUTPUT_USD_PER_MTOKEN/);
  });
});
