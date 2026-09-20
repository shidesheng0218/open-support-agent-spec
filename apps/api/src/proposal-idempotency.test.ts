import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ActionProposal } from "@osas/core";
import { buildApp } from "./app.js";

/**
 * POST /v1/proposals is idempotent on idempotencyKey (CONTRACTS.md §9):
 * a replay with identical content returns the stored proposal with no side
 * effects; the same key with different content is a 409 conflict.
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

const BODY = {
  caseId: "case_refund",
  profile: "ecommerce",
  actionType: "refund",
  reasonCode: "damaged",
  params: { orderId: "ord_small" },
  requestedPermission: "request-approval",
  requestedBy: { actorType: "model", actorId: "mock-local" },
  amount: { currency: "USD", minorUnits: 2500 },
  evidenceIds: ["ev_ord_small"],
  idempotencyKey: "idem_idem_test_1",
} as const;

describe("POST /v1/proposals idempotency", () => {
  it("replays an identical re-submission without a second side effect", async () => {
    const app = await start();
    const first = await app.inject({ method: "POST", url: "/v1/proposals", headers: AGENT, payload: BODY });
    expect(first.statusCode).toBe(201);
    const created = first.json() as ActionProposal;

    const replay = await app.inject({ method: "POST", url: "/v1/proposals", headers: AGENT, payload: BODY });
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json() as ActionProposal & { replayed: boolean };
    expect(replayed.replayed).toBe(true);
    expect(replayed.id).toBe(created.id);

    const list = await app.inject({ method: "GET", url: "/v1/proposals", headers: AGENT });
    const all = list.json() as ActionProposal[];
    expect(all.filter((p) => p.idempotencyKey === BODY.idempotencyKey)).toHaveLength(1);

    const auditRes = await app.inject({ method: "GET", url: "/v1/audit", headers: AGENT });
    const events = auditRes.json() as { eventType: string; proposalId?: string }[];
    expect(
      events.filter((e) => e.eventType === "proposal_created" && e.proposalId === created.id),
    ).toHaveLength(1);
  });

  it("rejects the same idempotencyKey with different content (409)", async () => {
    const app = await start();
    await app.inject({ method: "POST", url: "/v1/proposals", headers: AGENT, payload: BODY });
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: AGENT,
      payload: { ...BODY, amount: { currency: "USD", minorUnits: 4900 } },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("creates normally when the key is fresh", async () => {
    const app = await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: AGENT,
      payload: { ...BODY, idempotencyKey: "idem_idem_test_fresh" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as ActionProposal & { replayed?: boolean }).replayed).toBeUndefined();
  });
});