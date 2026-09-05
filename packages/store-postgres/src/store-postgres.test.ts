import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AuditEvent, TenantPolicy } from "@osas/core";
import { PolicyVersionConflictError, type PolicyStore } from "@osas/policy-engine";
import type { UsageStore } from "@osas/model-gateway";
import { createPool, withTransaction } from "./pool.js";
import { migrate } from "./migrate.js";
import { PostgresExecutionStore } from "./execution-store.js";
import { PostgresPolicyStore } from "./policy-store.js";
import { PostgresAuditStore } from "./audit-store.js";
import { PostgresUsageStore } from "./usage-store.js";

// Gated: without DATABASE_URL the whole suite skips, keeping `pnpm test`
// free of network/service dependencies. With it (e.g. a throwaway docker
// container) these tests run for real.
const DATABASE_URL = process.env.DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;

function makePolicy(tenantId: string, version: string): TenantPolicy {
  return {
    id: `pol_${version}`,
    specVersion: "0.1",
    tenantId,
    version,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    duplicateWindowSeconds: 86400,
    maxEvidenceAgeSeconds: 604800,
    defaultDecision: "block",
    rules: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

run("store-postgres (requires DATABASE_URL)", () => {
  let pool: Pool;
  const tenant = `tenant_pg_${randomUUID().slice(0, 8)}`;
  const tenantB = `tenant_pg_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await migrate(pool);
  }, 30000);

  afterAll(async () => {
    await pool.end();
  });

  it("migrate is idempotent", async () => {
    const ran = await migrate(pool);
    expect(ran).toEqual([]);
  });

  it("execution store: put/get with (tenant, idempotency) uniqueness", async () => {
    const store = new PostgresExecutionStore(pool);
    const record = {
      tenantId: tenant,
      idempotencyKey: `idem_${randomUUID()}`,
      proposalId: "prop_1",
      status: "executed" as const,
      result: { status: "succeeded" as const, externalRef: "ext_1" },
      completedAt: new Date().toISOString(),
    };
    await store.put(record);
    // Replaying the same key is a no-op (idempotent put).
    await store.put({ ...record, status: "failed" });
    const got = await store.get(tenant, record.idempotencyKey);
    expect(got?.status).toBe("executed");
    expect(got?.result.externalRef).toBe("ext_1");
    // A different tenant may reuse the same key.
    await store.put({ ...record, tenantId: tenantB, status: "failed" });
    expect((await store.get(tenantB, record.idempotencyKey))?.status).toBe("failed");
  });

  it("execution record survives a reconnect (persistence)", async () => {
    const store = new PostgresExecutionStore(pool);
    const key = `idem_${randomUUID()}`;
    await store.put({
      tenantId: tenant,
      idempotencyKey: key,
      proposalId: "prop_restart",
      status: "executed",
      result: { status: "succeeded", externalRef: "ext_restart" },
      completedAt: new Date().toISOString(),
    });
    // Simulate a restart: brand-new pool over the same database.
    const pool2 = createPool(DATABASE_URL!);
    try {
      const got = await new PostgresExecutionStore(pool2).get(tenant, key);
      expect(got?.proposalId).toBe("prop_restart");
    } finally {
      await pool2.end();
    }
  });

  it("execution state + audit write are atomic under withTransaction", async () => {
    const key = `idem_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    // Failing transaction: neither the execution record nor the audit event survives.
    await expect(
      withTransaction(pool, async (client) => {
        await new PostgresExecutionStore(client).put({
          tenantId: tenant,
          idempotencyKey: key,
          proposalId: "prop_tx",
          status: "executed",
          result: { status: "succeeded" },
          completedAt: new Date().toISOString(),
        });
        await new PostgresAuditStore(client).append({
          id: eventId,
          specVersion: "0.1",
          tenantId: tenant,
          eventType: "execution_succeeded",
          actorType: "system",
          actorId: "osas-api",
          detail: {},
          createdAt: new Date().toISOString(),
        });
        throw new Error("boom");
      }),
    ).rejects.toThrowError("boom");
    expect(await new PostgresExecutionStore(pool).get(tenant, key)).toBeUndefined();
    expect(await new PostgresAuditStore(pool).list(tenant, {})).toHaveLength(0);

    // Committing transaction: both become visible together.
    await withTransaction(pool, async (client) => {
      await new PostgresExecutionStore(client).put({
        tenantId: tenant,
        idempotencyKey: key,
        proposalId: "prop_tx",
        status: "executed",
        result: { status: "succeeded" },
        completedAt: new Date().toISOString(),
      });
      await new PostgresAuditStore(client).append({
        id: eventId,
        specVersion: "0.1",
        tenantId: tenant,
        eventType: "execution_succeeded",
        actorType: "system",
        actorId: "osas-api",
        detail: {},
        createdAt: new Date().toISOString(),
      });
    });
    expect(await new PostgresExecutionStore(pool).get(tenant, key)).toBeDefined();
    expect(await new PostgresAuditStore(pool).list(tenant, {})).toHaveLength(1);
  });

  it("policy store: lifecycle, immutability, tenant isolation", async () => {
    const store: PolicyStore = new PostgresPolicyStore(pool);
    await store.importActive(makePolicy(tenant, "1.0.0"), "seed");
    await store.createDraft(tenant, makePolicy(tenant, "1.1.0"), "admin");
    await expect(store.createDraft(tenant, makePolicy(tenant, "1.1.0"), "admin")).rejects.toThrowError(
      PolicyVersionConflictError,
    );
    await store.markSimulated(tenant, "1.1.0");
    await store.approve(tenant, "1.1.0", "admin");
    const { activated, superseded } = await store.activate(tenant, "1.1.0", "admin");
    expect(activated.status).toBe("active");
    expect(superseded?.version).toBe("1.0.0");
    expect((await store.getActive(tenant))?.version).toBe("1.1.0");
    // Strict tenant isolation.
    expect(await store.list(tenantB)).toEqual([]);
  });

  it("usage store: priced and unknown-cost records, filters, budget sums", async () => {
    const store: UsageStore = new PostgresUsageStore(pool);
    const now = new Date().toISOString();
    await store.record({
      tenantId: tenant,
      caseId: "case_1",
      provider: "openai-compatible",
      model: "fast-1",
      tier: "classify",
      task: "classify",
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 42,
      costUsd: 0.0012,
      truncated: false,
      createdAt: now,
    });
    // No price configured -> costUsd omitted (unknown), never fabricated.
    await store.record({
      tenantId: tenant,
      provider: "openai-compatible",
      model: "standard-1",
      tier: "standard",
      task: "propose",
      inputTokens: 500,
      outputTokens: 200,
      latencyMs: 900,
      truncated: false,
      createdAt: now,
    });
    const all = await store.query({ tenantId: tenant });
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.task === "propose")?.costUsd).toBeUndefined();
    expect(await store.query({ tenantId: tenant, task: "classify" })).toHaveLength(1);
    expect(await store.query({ tenantId: tenant, model: "standard-1" })).toHaveLength(1);
    expect(await store.query({ tenantId: tenantB })).toHaveLength(0);
    expect(await store.sumKnownCostUsd({ tenantId: tenant })).toBeCloseTo(0.0012, 6);
    expect(
      await store.sumKnownCostUsd({ tenantId: tenant, to: "2000-01-01T00:00:00.000Z" }),
    ).toBe(0);
  });

  it("audit store: append + list with hash-chain fields", async () => {
    const store = new PostgresAuditStore(pool);
    const event: AuditEvent = {
      id: `evt_${randomUUID()}`,
      specVersion: "0.1",
      tenantId: tenant,
      eventType: "model_call_recorded",
      actorType: "model",
      actorId: "openai-compatible",
      sequence: 7,
      previousHash: "0".repeat(64),
      eventHash: "a".repeat(64),
      detail: { task: "classify" },
      createdAt: new Date().toISOString(),
    };
    await store.append(event);
    const listed = await store.list(tenant, {});
    const found = listed.find((e) => e.id === event.id);
    expect(found?.eventHash).toBe("a".repeat(64));
    expect(found?.sequence).toBe(7);
    expect(await store.list(tenantB, {})).toEqual([]);
  });
});
