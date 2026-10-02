import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPool, migrate } from "@osas/store-postgres";
import { buildApp } from "./app.js";

/**
 * End-to-end governance control plane on PostgreSQL.
 *
 * Gated on DATABASE_URL (same convention as @osas/store-postgres): without it
 * this suite skips, so `pnpm test` needs no service. With it, this is the test
 * that proves the whole M1 stack holds together — migration 0003, the Postgres
 * stores, the API wiring, and restart persistence.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;

run("governance control plane on PostgreSQL (requires DATABASE_URL)", () => {
  const tenant = `tenant_api_pg_${randomUUID().slice(0, 8)}`;
  const headers = { "x-osas-role": "policy_admin", "x-tenant-id": tenant };
  const env = {
    OSAS_STORAGE: "postgres",
    DATABASE_URL: DATABASE_URL!,
    OSAS_GOVERNANCE_EVENT_KEY: "api-pg-test-key",
  };

  afterAll(async () => {
    // Leave the shared database usable: drop the rows this suite created.
    const pool = createPool(DATABASE_URL!);
    try {
      for (const table of [
        "job_runs",
        "integration_events",
        "reconciliations",
        "governed_cases",
        "governance_usage_events",
        "connections",
        "workspaces",
      ]) {
        const column = table === "connections" ? "tenant_id" : "tenant_id";
        await pool.query(`DELETE FROM ${table} WHERE ${column} = $1`, [tenant]).catch(() => undefined);
      }
    } finally {
      await pool.end();
    }
  });

  it("survives an API restart with the same state", async () => {
    const setup = createPool(DATABASE_URL!);
    try {
      await migrate(setup);
    } finally {
      await setup.end();
    }

    const first = await buildApp({ logger: false, env });
    const provisioned = await first.inject({
      method: "POST",
      url: "/v1/governance/workspaces",
      headers,
      payload: { organizationName: "PG Co", workspaceName: "Support" },
    });
    expect(provisioned.statusCode).toBe(200);

    const connection = await first.inject({
      method: "POST",
      url: "/v1/governance/connections",
      headers,
      payload: {
        provider: "mock",
        externalAccountId: `acct_${randomUUID().slice(0, 8)}`,
        capabilities: ["ticket.read"],
        credentialRef: "env:PG_TEST_TOKEN",
      },
    });
    expect(connection.statusCode).toBe(200);
    const connectionId = connection.json().id as string;

    // A reconciliation opened by the runtime, then left open across the restart.
    await first.governance.stores.reconciliations.createIfAbsent({
      id: `recon_${randomUUID().slice(0, 8)}`,
      specVersion: "0.2",
      tenantId: tenant,
      reason: "unknown_outcome",
      status: "open",
      dedupeKey: `job:${randomUUID()}`,
      detail: { note: "left open on purpose" },
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await first.close();

    const second = await buildApp({ logger: false, env });
    try {
      const health = await second.inject({
        method: "GET",
        url: "/v1/governance/health",
        headers,
      });
      expect(health.statusCode).toBe(200);
      const body = health.json();
      expect(body.workspace.tenantId).toBe(tenant);
      expect(body.connections.paused).toBe(1);
      expect(body.reconciliations.open).toBe(1);

      const restored = await second.inject({
        method: "GET",
        url: `/v1/governance/connections/${connectionId}`,
        headers,
      });
      expect(restored.json().credentialRef).toBe("env:PG_TEST_TOKEN");

      // Another tenant still sees nothing.
      const other = await second.inject({
        method: "GET",
        url: "/v1/governance/connections",
        headers: { "x-osas-role": "policy_admin", "x-tenant-id": `other_${randomUUID().slice(0, 8)}` },
      });
      expect(other.json()).toEqual([]);
    } finally {
      await second.close();
    }
  }, 60000);
});
