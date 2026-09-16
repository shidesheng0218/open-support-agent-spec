import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ActionProposal } from "@osas/core";
import type { ShadowMetrics } from "@osas/core";
import { validate } from "@osas/schema-validator";
import { buildApp } from "./app.js";

/**
 * GET /v1/shadow-runs/metrics — the ShadowMetrics producer
 * (schemas/core/shadow-metrics.json). Aggregates the tenant's ShadowRun
 * records; the response must validate against the published schema.
 */

const AGENT = { "x-osas-role": "support_agent" };

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function start(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false });
  apps.push(app);
  return app;
}

async function createProposal(
  app: FastifyInstance,
  over: Record<string, unknown> = {},
): Promise<ActionProposal> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/proposals",
    headers: AGENT,
    payload: {
      caseId: "case_refund",
      profile: "ecommerce",
      actionType: "refund",
      reasonCode: "damaged",
      params: { orderId: "ord_small" },
      requestedPermission: "request-approval",
      requestedBy: { actorType: "model", actorId: "mock-local" },
      amount: { currency: "USD", minorUnits: 2500 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      ...over,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as ActionProposal;
}

async function createShadowRun(app: FastifyInstance, proposalId: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/proposals/${proposalId}/shadow-run`,
    headers: AGENT,
    payload: {},
  });
  expect(res.statusCode).toBe(201);
}

async function getMetrics(app: FastifyInstance): Promise<ShadowMetrics> {
  const res = await app.inject({
    method: "GET",
    url: "/v1/shadow-runs/metrics",
    headers: AGENT,
  });
  expect(res.statusCode).toBe(200);
  const metrics = res.json() as ShadowMetrics;
  const result = validate("core/shadow-metrics", metrics);
  expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  return metrics;
}

describe("GET /v1/shadow-runs/metrics", () => {
  it("aggregates shadow runs by decision and action type (schema-valid)", async () => {
    const app = await start();
    const auto = await createProposal(app);
    await createShadowRun(app, auto.id);
    const blocked = await createProposal(app, {
      caseId: "case_unverified",
      idempotencyKey: `idem_blocked_${Math.random().toString(36).slice(2)}`,
    });
    await createShadowRun(app, blocked.id);

    const metrics = await getMetrics(app);
    expect(metrics.totals.shadowRuns).toBe(2);
    expect(metrics.totals.autoExecuted).toBe(1);
    expect(metrics.totals.blocked).toBe(1);
    expect(metrics.totals.approvalRequested).toBe(0);
    expect(metrics.byActionType).toEqual([
      { actionType: "refund", autoExecuted: 1, approvalRequested: 0, blocked: 1 },
    ]);
    const summed =
      metrics.rates.autoExecuteRate + metrics.rates.approvalRate + metrics.rates.blockRate;
    expect(summed).toBeCloseTo(1, 10);
    // 2 proposals exist (seed prop_dup_refund + the two created), 2 covered.
    expect(metrics.rates.shadowCoveragePct).toBeGreaterThan(0);
    expect(metrics.rates.shadowCoveragePct).toBeLessThanOrEqual(1);
  });

  it("returns a schema-valid zeroed report when no shadow runs exist", async () => {
    const app = await start();
    const metrics = await getMetrics(app);
    expect(metrics.totals.shadowRuns).toBe(0);
    expect(metrics.byActionType).toEqual([]);
    expect(metrics.rates).toEqual({
      autoExecuteRate: 0,
      approvalRate: 0,
      blockRate: 0,
      shadowCoveragePct: 0,
    });
  });
});