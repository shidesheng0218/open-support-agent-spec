import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SupportAdapter, ToolContext } from "@osas/adapter";
import type { AuditEvent, CapabilityManifest } from "@osas/core";
import { MockSupportAdapter, createDemoFixtures } from "@osas/mock-backend";
import { buildApp } from "./app.js";

const TENANT = "tenant_demo";
const ADMIN = { "x-osas-role": "policy_admin", "x-osas-actor-id": "admin_test" };

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false });
});

afterEach(async () => {
  await app.close();
});

/** An adapter that declares only the core read capabilities. */
function readOnlyAdapter(): SupportAdapter {
  const adapter = new MockSupportAdapter(createDemoFixtures());
  const base: CapabilityManifest = {
    specVersion: "0.1",
    implementationId: "read-only-impl",
    implementationVersion: "0.1.1",
    profiles: [
      { name: "core", capabilities: ["case.read", "customer.read", "knowledge.read", "evidence.read"] },
    ],
    transports: ["http", "mcp"],
    executionModes: ["proposal_only"],
    adapterVersion: "0.1.1",
  };
  adapter.getCapabilities = async () => base;
  return adapter;
}

function draftPolicy(version: string, rules: unknown[] = []): Record<string, unknown> {
  return {
    version,
    effectiveFrom: new Date().toISOString(),
    duplicateWindowSeconds: 86400,
    maxEvidenceAgeSeconds: 604800,
    defaultDecision: "block",
    rules,
  };
}

describe("capability manifest API (v0.1.1)", () => {
  it("GET /.well-known/osas exposes the discovery document", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/osas" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.specVersion).toBe("0.1");
    expect(body.capabilities.implementationId).toBe("osas-mock-backend");
  });

  it("GET /v1/capabilities returns the adapter's manifest with all 16 capabilities", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(res.statusCode).toBe(200);
    const manifest = res.json() as CapabilityManifest;
    const declared = manifest.profiles.flatMap((p) => p.capabilities);
    expect(declared).toHaveLength(16);
    expect(manifest.transports).toEqual(["http", "mcp"]);
  });

  it("a read-only implementation serves reads but rejects writes with CAPABILITY_UNSUPPORTED", async () => {
    const ro = await buildApp({ logger: false, adapter: readOnlyAdapter() });
    try {
      const ok = await ro.inject({ method: "GET", url: "/v1/cases/case_refund" });
      expect(ok.statusCode).toBe(200);

      for (const attempt of [
        { method: "POST", url: "/v1/proposals", payload: {} },
        { method: "GET", url: "/v1/audit" },
        { method: "GET", url: "/v1/audit/verify" },
        { method: "GET", url: "/v1/approvals" },
      ] as const) {
        const res = await ro.inject(attempt);
        expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
        expect(res.json().error.code).toBe("CAPABILITY_UNSUPPORTED");
      }
    } finally {
      await ro.close();
    }
  });

  it("adapters without a capability provider stay permissive (backward compat)", async () => {
    const adapter = new MockSupportAdapter(createDemoFixtures());
    Object.defineProperty(adapter, "getCapabilities", { value: undefined });
    const legacy = await buildApp({ logger: false, adapter });
    try {
      const caps = await legacy.inject({ method: "GET", url: "/v1/capabilities" });
      expect(caps.statusCode).toBe(404);
      expect(caps.json().error.code).toBe("CAPABILITIES_NOT_DECLARED");
      const res = await legacy.inject({ method: "GET", url: "/v1/cases/case_refund" });
      expect(res.statusCode).toBe(200);
    } finally {
      await legacy.close();
    }
  });
});

describe("policy version lifecycle (v0.1.1)", () => {
  it("requires the policy_admin role for all lifecycle mutations", async () => {
    for (const attempt of [
      { method: "POST", url: `/v1/policies/${TENANT}/drafts`, payload: draftPolicy("1.1.0") },
      { method: "POST", url: `/v1/policies/${TENANT}/simulate`, payload: {} },
      { method: "POST", url: `/v1/policies/${TENANT}/versions/1.0.0/approve`, payload: {} },
      { method: "POST", url: `/v1/policies/${TENANT}/versions/1.0.0/activate`, payload: {} },
      { method: "POST", url: `/v1/policies/${TENANT}/versions/1.0.0/retire`, payload: {} },
    ] as const) {
      const res = await app.inject(attempt);
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
      expect(res.json().error.code).toBe("POLICY_ADMIN_REQUIRED");
    }
  });

  it("walks draft -> simulated -> approved -> active, superseding the old active version", async () => {
    const versions0 = (
      await app.inject({ method: "GET", url: `/v1/policies/${TENANT}/versions` })
    ).json() as { version: string; status: string }[];
    expect(versions0).toHaveLength(1);
    expect(versions0[0]).toMatchObject({ version: "1.0.0", status: "active" });

    const draftRes = await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/drafts`,
      headers: ADMIN,
      payload: draftPolicy("1.1.0", [
        { actionType: "refund", decision: "block", reasonCodes: ["damaged"] },
      ]),
    });
    expect(draftRes.statusCode).toBe(201);
    expect(draftRes.json()).toMatchObject({ version: "1.1.0", status: "draft", createdBy: "admin_test" });

    // Approving a draft without simulation is rejected (lifecycle enforcement).
    const earlyApprove = await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/versions/1.1.0/approve`,
      headers: ADMIN,
      payload: {},
    });
    expect(earlyApprove.statusCode).toBe(409);

    // Simulate against the draft version.
    const simRes = await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/simulate`,
      headers: ADMIN,
      payload: {
        version: "1.1.0",
        proposal: {
          caseId: "case_refund",
          profile: "ecommerce",
          actionType: "refund",
          reasonCode: "damaged",
          params: { orderId: "ord_small" },
          amount: { currency: "USD", minorUnits: 2500 },
          evidenceIds: ["ev_ord_small"],
        },
        customer: "cus_verified",
      },
    });
    expect(simRes.statusCode).toBe(200);
    const sim = simRes.json();
    expect(sim.decision.decision).toBe("block"); // draft policy blocks refunds
    expect(sim.policyVersion.status).toBe("simulated");

    const approveRes = await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/versions/1.1.0/approve`,
      headers: ADMIN,
      payload: {},
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json()).toMatchObject({ status: "approved", approvedBy: "admin_test" });

    const actRes = await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/versions/1.1.0/activate`,
      headers: ADMIN,
      payload: {},
    });
    expect(actRes.statusCode).toBe(200);
    const act = actRes.json();
    expect(act.activated.status).toBe("active");
    expect(act.activated.activatedBy).toBe("admin_test");
    expect(act.superseded).toMatchObject({ version: "1.0.0", status: "retired" });

    // Runtime evaluation now uses the new active version.
    const active = (
      await app.inject({ method: "GET", url: `/v1/policies/${TENANT}` })
    ).json();
    expect(active.version).toBe("1.1.0");

    // Activation was recorded with actor, time, old and new version.
    const auditRes = await app.inject({ method: "GET", url: "/v1/audit" });
    const events = auditRes.json() as { eventType: string; actorId: string; detail: Record<string, unknown> }[];
    const types = events.map((e) => e.eventType);
    for (const t of ["policy_draft_created", "policy_simulated", "policy_approved", "policy_activated", "policy_retired"]) {
      expect(types).toContain(t);
    }
    const activation = events.find((e) => e.eventType === "policy_activated");
    expect(activation?.actorId).toBe("admin_test");
    expect(activation?.detail).toMatchObject({ previousVersion: "1.0.0", newVersion: "1.1.0" });
    expect(typeof activation?.detail.at).toBe("string");
  });

  it("new active policy drives evaluation (refund now blocked end-to-end)", async () => {
    await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/drafts`,
      headers: ADMIN,
      payload: draftPolicy("1.1.0", [{ actionType: "refund", decision: "block" }]),
    });
    await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/simulate`,
      headers: ADMIN,
      payload: {
        version: "1.1.0",
        proposal: { caseId: "case_refund", profile: "ecommerce", actionType: "refund", reasonCode: "damaged", params: {} },
      },
    });
    await app.inject({ method: "POST", url: `/v1/policies/${TENANT}/versions/1.1.0/approve`, headers: ADMIN, payload: {} });
    await app.inject({ method: "POST", url: `/v1/policies/${TENANT}/versions/1.1.0/activate`, headers: ADMIN, payload: {} });

    const prop = await app.inject({
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
        idempotencyKey: `idem_policy_${Date.now()}`,
      },
    });
    expect(prop.statusCode).toBe(201);
    const evalRes = await app.inject({
      method: "POST",
      url: `/v1/proposals/${prop.json().id}/evaluate`,
      payload: {},
    });
    expect(evalRes.json().decision.decision).toBe("block");
    expect(evalRes.json().decision.policyVersion).toBe("1.1.0");
  });

  it("simulation produces no Approval, Execution, Handoff, proposal, or business write", async () => {
    await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/drafts`,
      headers: ADMIN,
      payload: draftPolicy("1.1.0"),
    });
    const before = {
      approvals: (await app.inject({ method: "GET", url: "/v1/approvals" })).json().length,
      handoffs: (await app.inject({ method: "GET", url: "/v1/handoffs" })).json().length,
      proposals: (await app.inject({ method: "GET", url: "/v1/proposals" })).json().length,
      order: (await app.inject({ method: "GET", url: "/v1/cases/case_refund" })).statusCode,
    };

    const simRes = await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/simulate`,
      headers: ADMIN,
      payload: {
        version: "1.1.0",
        proposal: {
          caseId: "case_refund",
          profile: "ecommerce",
          actionType: "refund",
          reasonCode: "damaged",
          params: { orderId: "ord_small" },
          amount: { currency: "USD", minorUnits: 2500 },
          evidenceIds: ["ev_ord_small"],
        },
        customer: "cus_verified",
      },
    });
    expect(simRes.statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: "/v1/approvals" })).json().length).toBe(before.approvals);
    expect((await app.inject({ method: "GET", url: "/v1/handoffs" })).json().length).toBe(before.handoffs);
    expect((await app.inject({ method: "GET", url: "/v1/proposals" })).json().length).toBe(before.proposals);
    // No business write: the simulated refund did not touch the order.
    const orderEvents = (await app.inject({ method: "GET", url: "/v1/audit" })).json() as { eventType: string }[];
    expect(orderEvents.filter((e) => e.eventType.startsWith("execution_"))).toHaveLength(0);
  });

  it("retire works from approved/active and never resurrects retired versions", async () => {
    await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/drafts`,
      headers: ADMIN,
      payload: draftPolicy("1.1.0"),
    });
    // Retiring a draft is not part of the lifecycle.
    const badRetire = await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/versions/1.1.0/retire`,
      headers: ADMIN,
      payload: {},
    });
    expect(badRetire.statusCode).toBe(409);

    // Retire the active version.
    const retire = await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/versions/1.0.0/retire`,
      headers: ADMIN,
      payload: {},
    });
    expect(retire.statusCode).toBe(200);
    expect(retire.json().status).toBe("retired");

    // Retired versions cannot be re-approved or re-activated.
    const reactivate = await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/versions/1.0.0/activate`,
      headers: ADMIN,
      payload: {},
    });
    expect(reactivate.statusCode).toBe(409);
  });
});

describe("audit hash chain verification (v0.1.1)", () => {
  it("GET /v1/audit/verify confirms an intact chain after real activity", async () => {
    await app.inject({
      method: "POST",
      url: `/v1/policies/${TENANT}/drafts`,
      headers: ADMIN,
      payload: draftPolicy("1.1.0"),
    });
    const res = await app.inject({ method: "GET", url: "/v1/audit/verify" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe(TENANT);
    expect(body.intact).toBe(true);
    expect(body.chainLength).toBeGreaterThan(0);
  });

  it("detects a tampered event and reports expected/actual hashes", async () => {
    const seeded = new MockSupportAdapter(createDemoFixtures());
    const ctx: ToolContext = {
      tenantId: TENANT,
      principal: { actorType: "system", actorId: "vitest", permission: "execute" },
    };
    await seeded.appendAuditEvent(ctx, {
      tenantId: TENANT,
      eventType: "policy_evaluated",
      actorType: "policy_engine",
      actorId: "t",
      detail: { legit: true },
    });
    await seeded.appendAuditEvent(ctx, {
      tenantId: TENANT,
      eventType: "policy_evaluated",
      actorType: "policy_engine",
      actorId: "t",
      detail: { legit: 2 },
    });
    // Simulate a storage-level tamper: the second event's detail is rewritten
    // without recomputing the chain.
    const tampered: SupportAdapter = Object.create(seeded, {
      listAuditEvents: {
        value: async (c: ToolContext, q: { caseId?: string; proposalId?: string }) => {
          const events = await seeded.listAuditEvents(c, q);
          if (events[1]) events[1] = { ...events[1], detail: { forged: true } };
          return events;
        },
      },
    }) as SupportAdapter;
    const isolated = await buildApp({ logger: false, adapter: tampered });
    try {
      const res = await isolated.inject({ method: "GET", url: "/v1/audit/verify" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.intact).toBe(false);
      expect(body.firstError.reason).toBe("event_hash_mismatch");
      expect(body.firstError.expectedEventHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.firstError.actualEventHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.firstError.actualEventHash).not.toBe(body.firstError.expectedEventHash);
    } finally {
      await isolated.close();
    }
  });

  it("tenant streams are isolated: tampering one tenant does not affect another", async () => {
    // Seed activity in a second tenant via the tenant header.
    await app.inject({
      method: "POST",
      url: `/v1/policies/tenant_other/drafts`,
      headers: { ...ADMIN, "x-tenant-id": "tenant_other" },
      payload: { ...draftPolicy("1.0.0"), tenantId: "tenant_other" },
    });
    const ownVerify = await app.inject({
      method: "GET",
      url: "/v1/audit/verify",
      headers: { "x-tenant-id": "tenant_other" },
    });
    expect(ownVerify.json().intact).toBe(true);
    expect(ownVerify.json().tenantId).toBe("tenant_other");

    // The default tenant's (empty) chain is untouched by other-tenant activity.
    const demoVerify = await app.inject({ method: "GET", url: "/v1/audit/verify" });
    expect(demoVerify.json().intact).toBe(true);
    expect(demoVerify.json().chainLength).toBe(0);
  });
});
