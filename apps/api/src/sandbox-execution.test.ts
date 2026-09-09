import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("sandbox execution mode", () => {
  it("keeps the default shadow mode simulation-only", async () => {
    app = await buildApp({ logger: false });
    const proposal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      payload: {
        caseId: "case_refund",
        profile: "ecommerce",
        actionType: "refund",
        reasonCode: "damaged",
        params: { orderId: "ord_small" },
        requestedPermission: "request-approval",
        requestedBy: { actorType: "human", actorId: "agent_1" },
        amount: { currency: "USD", minorUnits: 2500 },
        evidenceIds: ["ev_ord_small"],
        idempotencyKey: "shadow-refund-1",
      },
    });
    const id = proposal.json().id as string;
    await app.inject({ method: "POST", url: `/v1/proposals/${id}/evaluate` });
    const executed = await app.inject({ method: "POST", url: `/v1/proposals/${id}/execute` });
    expect(executed.statusCode).toBe(409);
    expect(executed.json().error.code).toBe("CONFLICT");
    const saved = await app.inject({ method: "GET", url: `/v1/proposals/${id}` });
    expect(saved.json().status).toBe("approved");
  });

  it("boots with sandbox mode and advertises it without enabling live", async () => {
    app = await buildApp({
      logger: false,
      env: { OSAS_EXECUTION_MODE: "sandbox" },
    });

    const discovery = await app.inject({ method: "GET", url: "/.well-known/osas" });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json().executionMode).toBe("sandbox");
    expect(discovery.json().capabilities.executionModes).toContain("sandbox");
    expect(discovery.json().capabilities.executionModes).not.toContain("live");
  });

  it("keeps proposal_only draft-only and never invokes execution", async () => {
    app = await buildApp({
      logger: false,
      env: { OSAS_EXECUTION_MODE: "proposal_only" },
    });
    const proposal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      payload: {
        caseId: "case_refund",
        profile: "ecommerce",
        actionType: "refund",
        reasonCode: "damaged",
        params: { orderId: "ord_small" },
        requestedPermission: "request-approval",
        requestedBy: { actorType: "human", actorId: "agent_1" },
        amount: { currency: "USD", minorUnits: 2500 },
        evidenceIds: ["ev_ord_small"],
        idempotencyKey: "proposal-only-refund-1",
      },
    });
    const id = proposal.json().id as string;
    const evaluated = await app.inject({ method: "POST", url: `/v1/proposals/${id}/evaluate` });
    expect(evaluated.json().proposal.status).toBe("approved");
    const executed = await app.inject({ method: "POST", url: `/v1/proposals/${id}/execute` });
    expect(executed.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: `/v1/proposals/${id}` })).json().status).toBe("approved");
  });

  it("publishes the v0.3 execution schemas without changing the v0.2 manifest", async () => {
    app = await buildApp({ logger: false });
    const manifest = await app.inject({ method: "GET", url: "/v1/schemas" });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().specVersion).toBe("0.2");
    const schema = await app.inject({ method: "GET", url: "/v1/schemas/execution-v0.3/execution-attempt" });
    expect(schema.statusCode).toBe(200);
    expect(schema.json().$id).toContain("execution-v0.3/execution-attempt");
  });

  it("executes the synthetic refund only through the sandbox adapter", async () => {
    app = await buildApp({
      logger: false,
      env: { OSAS_EXECUTION_MODE: "sandbox" },
    });
    const proposal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      payload: {
        caseId: "case_refund",
        profile: "ecommerce",
        actionType: "refund",
        reasonCode: "damaged",
        params: { orderId: "ord_small" },
        requestedPermission: "request-approval",
        requestedBy: { actorType: "human", actorId: "agent_1" },
        amount: { currency: "USD", minorUnits: 2500 },
        evidenceIds: ["ev_ord_small"],
        idempotencyKey: "sandbox-api-refund-1",
      },
    });
    expect(proposal.statusCode).toBe(201);
    const id = proposal.json().id as string;

    const evaluated = await app.inject({ method: "POST", url: `/v1/proposals/${id}/evaluate` });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().proposal.status).toBe("approved");

    const executed = await app.inject({ method: "POST", url: `/v1/proposals/${id}/execute` });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().execution).toMatchObject({
      status: "succeeded",
      externalRef: "sandbox_refund_1",
      providerStatus: "sandbox_succeeded",
    });
    expect(executed.json().attempt).toMatchObject({
      specVersion: "0.3",
      mode: "sandbox",
      status: "succeeded",
    });
    expect(executed.json().receipt).toMatchObject({
      specVersion: "0.3",
      status: "succeeded",
      safeToRetry: false,
    });
  });

  it("accepts a signed sandbox provider event and resolves an uncertain execution", async () => {
    app = await buildApp({
      logger: false,
      env: { OSAS_EXECUTION_MODE: "sandbox", OSAS_PROVIDER_EVENT_KEY: "sandbox-key" },
    });
    const proposal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      payload: {
        caseId: "case_refund",
        profile: "ecommerce",
        actionType: "refund",
        reasonCode: "damaged",
        params: { orderId: "ord_small", simulate: "timeout" },
        requestedPermission: "request-approval",
        requestedBy: { actorType: "human", actorId: "agent_1" },
        amount: { currency: "USD", minorUnits: 2500 },
        evidenceIds: ["ev_ord_small"],
        idempotencyKey: "sandbox-uncertain-1",
      },
    });
    const id = proposal.json().id as string;
    await app.inject({ method: "POST", url: `/v1/proposals/${id}/evaluate` });
    const executed = await app.inject({ method: "POST", url: `/v1/proposals/${id}/execute` });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().execution.status).toBe("uncertain");
    expect(executed.json().reconciliation.status).toBe("open");

    const event = await app.inject({
      method: "POST",
      url: "/v1/provider-events",
      headers: { "x-osas-provider-key": "sandbox-key" },
      payload: {
        provider: "sandbox",
        providerEventId: "evt_uncertain_1",
        eventType: "refund.succeeded",
        idempotencyKey: "sandbox-uncertain-1",
        occurredAt: "2026-09-09T00:00:00.000Z",
        payload: { status: "succeeded", externalRef: "sandbox_refund_confirmed" },
      },
    });
    expect(event.statusCode).toBe(200);
    expect(event.json().duplicate).toBe(false);
    expect(event.json().proposal.status).toBe("executed");
    expect(event.json().reconciliation.status).toBe("resolved");

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/provider-events",
      headers: { "x-osas-provider-key": "sandbox-key" },
      payload: {
        provider: "sandbox",
        providerEventId: "evt_uncertain_1",
        eventType: "refund.succeeded",
        idempotencyKey: "sandbox-uncertain-1",
        occurredAt: "2026-09-09T00:00:00.000Z",
        payload: { status: "succeeded", externalRef: "sandbox_refund_confirmed" },
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
  });
});
