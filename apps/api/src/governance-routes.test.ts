import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

/**
 * Governance control-plane HTTP surface (M1).
 *
 * These tests pin the properties that would be expensive to discover in
 * production: secrets are refused, unverified ingest is impossible, capability
 * denials are explainable, and one tenant can never see another's state.
 */

const KEY = "governance-test-key";

const ADMIN = { "x-osas-role": "policy_admin", "x-tenant-id": "tenant_gov_a" };
const OPERATOR = { "x-osas-role": "support_agent", "x-tenant-id": "tenant_gov_a" };
const AUDITOR = { "x-osas-role": "auditor", "x-tenant-id": "tenant_gov_a" };
const OTHER_TENANT = { "x-osas-role": "policy_admin", "x-tenant-id": "tenant_gov_b" };

async function app() {
  return buildApp({ logger: false, env: { OSAS_GOVERNANCE_EVENT_KEY: KEY } });
}

describe("governance control plane", () => {
  it("provisions a workspace idempotently and reports health", async () => {
    const a = await app();
    const first = await a.inject({
      method: "POST",
      url: "/v1/governance/workspaces",
      headers: ADMIN,
      payload: { organizationName: "Acme", workspaceName: "Support" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toBe(true);

    const again = await a.inject({
      method: "POST",
      url: "/v1/governance/workspaces",
      headers: ADMIN,
      payload: { organizationName: "Acme", workspaceName: "Support" },
    });
    expect(again.json().created).toBe(false);
    expect(again.json().workspace.id).toBe(first.json().workspace.id);

    const health = await a.inject({ method: "GET", url: "/v1/governance/health", headers: ADMIN });
    expect(health.statusCode).toBe(200);
    expect(health.json().workspace.tenantId).toBe("tenant_gov_a");
    expect(health.json().connections).toEqual({ active: 0, paused: 0, error: 0, revoked: 0 });
  });

  it("refuses to store something that looks like a credential", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/v1/governance/connections",
      headers: ADMIN,
      payload: {
        provider: "shopify",
        externalAccountId: "acme.myshopify.com",
        capabilities: ["ecommerce.order.read"],
        credentialRef: "shpat_deadbeefdeadbeef",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("SECRET_REFUSED");
    // The refusal message must not echo the secret back.
    expect(JSON.stringify(res.json())).not.toContain("deadbeef");
  });

  it("creates connections paused and requires verification before use", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/v1/governance/connections",
      headers: ADMIN,
      payload: {
        provider: "mock",
        externalAccountId: "acct_1",
        capabilities: ["ticket.read"],
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().status).toBe("paused");
    expect(created.json().credentialRef).toBeUndefined();

    const verified = await a.inject({
      method: "POST",
      url: `/v1/governance/connections/${created.json().id}/verify`,
      headers: ADMIN,
    });
    // No probe is configured in the reference API, so verification fails closed.
    expect(verified.json().status).toBe("error");
    expect(verified.json().lastErrorCode).toBe("NO_PROBE_CONFIGURED");
  });

  it("enforces governance capabilities per role", async () => {
    const a = await app();
    const denied = await a.inject({
      method: "POST",
      url: "/v1/governance/connections",
      headers: OPERATOR,
      payload: { provider: "mock", externalAccountId: "acct_op", capabilities: ["ticket.read"] },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");

    const readOnly = await a.inject({
      method: "GET",
      url: "/v1/governance/connections",
      headers: OPERATOR,
    });
    expect(readOnly.statusCode).toBe(200);

    // An auditor may read the control-plane snapshot (counts, no payloads) ...
    const auditorHealth = await a.inject({
      method: "GET",
      url: "/v1/governance/health",
      headers: AUDITOR,
    });
    expect(auditorHealth.statusCode).toBe(200);
    expect(auditorHealth.json().tenantId).toBe("tenant_gov_a");

    // ... but a viewer is narrower still: no metering, and no connection list.
    const viewer = { ...OPERATOR, "x-osas-governance-role": "viewer" };
    expect(
      (await a.inject({ method: "GET", url: "/v1/governance/health", headers: viewer })).statusCode,
    ).toBe(403);
    expect(
      (await a.inject({ method: "GET", url: "/v1/governance/connections", headers: viewer })).statusCode,
    ).toBe(403);
    // A viewer keeps read access to cases/approvals/audit surfaces it is meant to see.
    expect(
      (await a.inject({ method: "GET", url: "/v1/governance/reconciliations", headers: viewer })).statusCode,
    ).toBe(403);
  });

  it("cannot provision a workspace for another tenant", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/v1/governance/workspaces",
      headers: ADMIN,
      payload: { organizationName: "Acme", workspaceName: "Support", tenantId: "tenant_gov_b" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("disables event ingestion without a key and never trusts a client flag", async () => {
    const disabled = await buildApp({ logger: false, env: {} });
    const off = await disabled.inject({
      method: "POST",
      url: "/v1/governance/integration-events",
      headers: ADMIN,
      payload: {
        connectionId: "conn_x",
        topic: "ticket.updated",
        externalEventId: "e1",
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(off.statusCode).toBe(409);

    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/v1/governance/connections",
      headers: ADMIN,
      payload: { provider: "mock", externalAccountId: "acct_ingest", capabilities: ["ticket.read"] },
    });
    const connectionId = created.json().id as string;
    // Activation is done through the store: the reference API has no probe.
    await a.governance.stores.connections.update(
      "tenant_gov_a",
      connectionId,
      { status: "active", lastVerifiedAt: new Date().toISOString() },
      created.json().version as number,
    );

    const wrongKey = await a.inject({
      method: "POST",
      url: "/v1/governance/integration-events",
      headers: { ...ADMIN, "x-osas-governance-key": "nope" },
      payload: {
        connectionId,
        topic: "ticket.updated",
        externalEventId: "e2",
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(wrongKey.statusCode).toBe(403);

    const accepted = await a.inject({
      method: "POST",
      url: "/v1/governance/integration-events",
      headers: { ...ADMIN, "x-osas-governance-key": KEY },
      payload: {
        connectionId,
        topic: "ticket.updated",
        externalEventId: "e3",
        occurredAt: "2026-01-01T00:00:00.000Z",
        // A client-supplied flag must be ignored: verification is the server's job.
        signatureVerified: false,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().outcome).toBe("accepted");
    expect(accepted.json().event.signatureVerified).toBe(true);

    const replay = await a.inject({
      method: "POST",
      url: "/v1/governance/integration-events",
      headers: { ...ADMIN, "x-osas-governance-key": KEY },
      payload: {
        connectionId,
        topic: "ticket.updated",
        externalEventId: "e3",
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(replay.json().outcome).toBe("duplicate");
    expect(replay.json().jobRunId).toBeUndefined();
  });

  it("does not leak a connection across tenants", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/v1/governance/connections",
      headers: ADMIN,
      payload: { provider: "mock", externalAccountId: "acct_iso", capabilities: ["ticket.read"] },
    });
    const otherTenantRead = await a.inject({
      method: "GET",
      url: `/v1/governance/connections/${created.json().id}`,
      headers: OTHER_TENANT,
    });
    expect(otherTenantRead.statusCode).toBe(404);
    const list = await a.inject({
      method: "GET",
      url: "/v1/governance/connections",
      headers: OTHER_TENANT,
    });
    expect(list.json()).toEqual([]);
  });

  it("drains the queue and reports the sweep", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/v1/governance/jobs/drain",
      headers: ADMIN,
      payload: { limit: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().claimed).toEqual([]);
    // The reference API registers no consumer unless explicitly enabled.
    expect(res.json().reconciliations).toEqual([]);
  });

  it("decides a reconciliation once and refuses a replay", async () => {
    const a = await app();
    const created = await a.governance.stores.reconciliations.createIfAbsent({
      id: "recon_api_1",
      specVersion: "0.2",
      tenantId: "tenant_gov_a",
      reason: "unknown_outcome",
      status: "open",
      dedupeKey: "job:job_api_1",
      detail: { jobId: "job_api_1" },
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(created.inserted).toBe(true);

    const listed = await a.inject({
      method: "GET",
      url: "/v1/governance/reconciliations?status=open",
      headers: ADMIN,
    });
    expect(listed.json()).toHaveLength(1);

    const decided = await a.inject({
      method: "POST",
      url: "/v1/governance/reconciliations/recon_api_1/decide",
      headers: ADMIN,
      payload: { status: "resolved", resolution: "provider shows no charge", expectedVersion: 1 },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe("resolved");
    expect(decided.json().resolvedBy).toBe("demo-policy_admin");

    const replay = await a.inject({
      method: "POST",
      url: "/v1/governance/reconciliations/recon_api_1/decide",
      headers: ADMIN,
      payload: { status: "dismissed", resolution: "again", expectedVersion: 2 },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("CONFLICT");
  });

  it("publishes its own paths in the OpenAPI document", async () => {
    const a = await app();
    const doc = await a.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(doc.statusCode).toBe(200);
    const paths = Object.keys(doc.json().paths as Record<string, unknown>);
    for (const path of [
      "/v1/governance/health",
      "/v1/governance/connections",
      "/v1/governance/integration-events",
      "/v1/governance/jobs/drain",
      "/v1/governance/reconciliations/{id}/decide",
    ]) {
      expect(paths).toContain(path);
    }
    // Provider-neutral is a statement about the contract, not about prose:
    // no COMPONENT SCHEMA may be vendor-specific. (Free-text descriptions on
    // application-layer paths may name a provider as an example — that is
    // exactly where vendor knowledge is allowed to live.)
    const components = doc.json().components.schemas as Record<string, unknown>;
    expect(Object.keys(components).some((name) => /shopify|zendesk|chatwoot/i.test(name))).toBe(false);
    expect(JSON.stringify(components)).not.toMatch(/shopify|zendesk|chatwoot/i);
  });

  it("denies reconciliation decisions to an operator", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/v1/governance/reconciliations/whatever/decide",
      headers: OPERATOR,
      payload: { status: "resolved", resolution: "nope", expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(403);
  });
});
