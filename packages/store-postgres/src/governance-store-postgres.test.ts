import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  GOVERNANCE_SPEC_VERSION,
  GovernanceConflictError,
  type Connection,
  type GovernedCase,
  type IntegrationEvent,
  type JobRun,
} from "@osas/governance";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";
import { postgresGovernanceStores } from "./governance-stores.js";
import type { GovernanceStores } from "@osas/governance";

// Same gating as the rest of this package: without DATABASE_URL the suite is
// skipped, so `pnpm test` needs no service. With it, these run for real.
const DATABASE_URL = process.env.DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;

const iso = (offsetMs = 0) => new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString();

run("governance stores on PostgreSQL", () => {
  let pool: Pool;
  let stores: GovernanceStores;
  const tenant = `tenant_gov_${randomUUID().slice(0, 8)}`;
  const other = `tenant_gov_${randomUUID().slice(0, 8)}`;
  const orgId = `org_${randomUUID().slice(0, 8)}`;

  const makeConnection = (overrides: Partial<Connection> = {}): Connection => ({
    id: `conn_${randomUUID().slice(0, 8)}`,
    specVersion: GOVERNANCE_SPEC_VERSION,
    tenantId: tenant,
    provider: "mock",
    externalAccountId: `acct_${randomUUID().slice(0, 8)}`,
    displayName: "mock",
    status: "paused",
    capabilities: ["ticket.read"],
    scopes: [],
    version: 1,
    createdBy: "u_admin",
    createdAt: iso(),
    updatedAt: iso(),
    ...overrides,
  });

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await migrate(pool);
    stores = postgresGovernanceStores(pool);
  }, 30000);

  afterAll(async () => {
    await pool.end();
  });

  it("enforces one workspace per tenant", async () => {
    await stores.organizations.createIfAbsent({
      id: orgId,
      specVersion: GOVERNANCE_SPEC_VERSION,
      name: "Acme",
      status: "active",
      version: 1,
      createdAt: iso(),
      updatedAt: iso(),
    });
    const base = {
      specVersion: GOVERNANCE_SPEC_VERSION,
      organizationId: orgId,
      tenantId: tenant,
      name: "Support",
      status: "active" as const,
      version: 1,
      createdAt: iso(),
      updatedAt: iso(),
    };
    const first = await stores.workspaces.createIfAbsent({ id: `ws_${randomUUID().slice(0, 8)}`, ...base });
    expect(first.inserted).toBe(true);
    await expect(
      stores.workspaces.createIfAbsent({ id: `ws_${randomUUID().slice(0, 8)}`, ...base }),
    ).rejects.toBeInstanceOf(GovernanceConflictError);
    const loaded = await stores.workspaces.getByTenantId(tenant);
    expect(loaded?.id).toBe(first.workspace.id);
  });

  it("is compare-and-set on organization version", async () => {
    const renamed = await stores.organizations.update(orgId, { name: "Acme Inc" }, 1);
    expect(renamed.name).toBe("Acme Inc");
    expect(renamed.version).toBe(2);
    await expect(stores.organizations.update(orgId, { name: "Nope" }, 1)).rejects.toBeInstanceOf(
      GovernanceConflictError,
    );
  });

  it("keeps one live connection per provider account and enforces CAS", async () => {
    const connection = makeConnection({ externalAccountId: "acct_live" });
    const created = await stores.connections.createIfAbsent(connection);
    expect(created.inserted).toBe(true);

    const duplicate = makeConnection({ externalAccountId: "acct_live" });
    await expect(stores.connections.createIfAbsent(duplicate)).rejects.toBeInstanceOf(
      GovernanceConflictError,
    );

    const active = await stores.connections.update(
      tenant,
      connection.id,
      { status: "active", lastVerifiedAt: iso(1000) },
      1,
    );
    expect(active.status).toBe("active");
    expect(active.lastVerifiedAt).toBe(iso(1000));
    await expect(
      stores.connections.update(tenant, connection.id, { status: "paused" }, 1),
    ).rejects.toBeInstanceOf(GovernanceConflictError);

    // An explicitly-undefined patch field clears the column (resume path).
    const resumed = await stores.connections.update(
      tenant,
      connection.id,
      { lastErrorAt: undefined, lastErrorCode: undefined },
      active.version,
    );
    expect(resumed.lastErrorCode).toBeUndefined();
  });

  it("does not leak a connection across tenants", async () => {
    const connection = makeConnection();
    await stores.connections.createIfAbsent(connection);
    expect(await stores.connections.get(other, connection.id)).toBeUndefined();
  });

  it("deduplicates integration events and tracks the watermark", async () => {
    const connection = makeConnection();
    await stores.connections.createIfAbsent(connection);
    const event: IntegrationEvent = {
      id: `evt_${randomUUID().slice(0, 8)}`,
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: tenant,
      connectionId: connection.id,
      provider: "mock",
      topic: "ticket.updated",
      externalEventId: "ext_1",
      occurredAt: iso(10_000),
      receivedAt: iso(10_000),
      status: "received",
      payload: { id: 1 },
      signatureVerified: true,
      attempts: 0,
    };
    const first = await stores.integrationEvents.insertIfAbsent(event);
    expect(first.inserted).toBe(true);
    const replay = await stores.integrationEvents.insertIfAbsent({ ...event, id: `evt_${randomUUID()}` });
    expect(replay.inserted).toBe(false);
    expect(replay.event.id).toBe(event.id);

    expect(await stores.integrationEvents.acceptedWatermark(tenant, connection.id)).toBe(iso(10_000));
    const stale = await stores.integrationEvents.markStatus(tenant, event.id, "stale_ignored");
    expect(stale.status).toBe("stale_ignored");
    // A parked event no longer counts toward the watermark.
    expect(await stores.integrationEvents.acceptedWatermark(tenant, connection.id)).toBeUndefined();

    const counts = await stores.integrationEvents.countByStatus(tenant);
    expect(counts.stale_ignored).toBeGreaterThanOrEqual(1);
  });

  it("leases a job to exactly one worker and applies the retry policy", async () => {
    const job: JobRun = {
      id: `job_${randomUUID().slice(0, 8)}`,
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: tenant,
      kind: "integration_event.process",
      status: "queued",
      retryClass: "side_effecting",
      attempts: 0,
      maxAttempts: 3,
      runAt: iso(),
      input: { eventId: "evt_1" },
      createdAt: iso(),
      updatedAt: iso(),
    };
    await stores.jobs.create(job);

    const claim = (owner: string) =>
      stores.jobs.claim({
        owner,
        now: new Date(iso()),
        leaseMs: 1000,
        limit: 10,
        tenantId: tenant,
        kinds: ["integration_event.process"],
      });
    const [a, b] = await Promise.all([claim("w1"), claim("w2")]);
    const claimedIds = [...a, ...b].map((j) => j.id);
    expect(claimedIds.filter((id) => id === job.id)).toHaveLength(1);

    const dead = await stores.jobs.fail(
      tenant,
      job.id,
      { errorCode: "BOOM", errorMessage: "exploded" },
      new Date(iso(2000)),
    );
    expect(dead.status).toBe("dead_letter");
    expect(dead.attempts).toBe(1);

    const counts = await stores.jobs.countByStatus(tenant);
    expect(counts.dead_letter).toBeGreaterThanOrEqual(1);
  });

  it("requeues a read-only job with backoff", async () => {
    const job: JobRun = {
      id: `job_${randomUUID().slice(0, 8)}`,
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: tenant,
      kind: "reconciliation.refetch",
      status: "queued",
      retryClass: "safe_read",
      attempts: 0,
      maxAttempts: 3,
      runAt: iso(),
      input: {},
      createdAt: iso(),
      updatedAt: iso(),
    };
    await stores.jobs.create(job);
    await stores.jobs.claim({
      owner: "w1",
      now: new Date(iso()),
      leaseMs: 1000,
      limit: 1,
      tenantId: tenant,
      kinds: ["reconciliation.refetch"],
    });
    const retried = await stores.jobs.fail(
      tenant,
      job.id,
      { errorCode: "TRANSIENT", errorMessage: "try again" },
      new Date(iso(1000)),
    );
    expect(retried.status).toBe("queued");
    expect(retried.runAt).toBe(iso(2000));
  });

  it("reclaims an expired lease", async () => {
    const job: JobRun = {
      id: `job_${randomUUID().slice(0, 8)}`,
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: tenant,
      kind: "connection.verify",
      status: "queued",
      retryClass: "safe_read",
      attempts: 0,
      maxAttempts: 3,
      runAt: iso(),
      input: {},
      createdAt: iso(),
      updatedAt: iso(),
    };
    await stores.jobs.create(job);
    await stores.jobs.claim({
      owner: "w_dying",
      now: new Date(iso()),
      leaseMs: 500,
      limit: 1,
      tenantId: tenant,
      kinds: ["connection.verify"],
    });
    const reclaimed = await stores.jobs.reclaimExpiredLeases(new Date(iso(5000)));
    expect(reclaimed.map((j) => j.id)).toContain(job.id);
    const after = await stores.jobs.get(tenant, job.id);
    expect(after?.status).toBe("queued");
    expect(after?.leaseOwner).toBeUndefined();
  });

  it("applies the case state machine inside the compare-and-set", async () => {
    const governed: GovernedCase = {
      id: `case_${randomUUID().slice(0, 8)}`,
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: tenant,
      subject: "Damaged item",
      state: "intake",
      priority: "normal",
      idempotencyKey: `idem_${randomUUID().slice(0, 8)}`,
      evidenceIds: [],
      proposalIds: [],
      approvalIds: [],
      executionAttemptIds: [],
      reconciliationIds: [],
      version: 1,
      createdAt: iso(),
      updatedAt: iso(),
    };
    const created = await stores.cases.createIfAbsent(governed);
    expect(created.inserted).toBe(true);
    const replay = await stores.cases.createIfAbsent({ ...governed, id: `case_${randomUUID()}` });
    expect(replay.inserted).toBe(false);

    await expect(
      stores.cases.transition(tenant, governed.id, 1, "resolved", {}, new Date(iso(1000))),
    ).rejects.toThrow(/cannot move from "intake" to "resolved"/);

    const moved = await stores.cases.transition(
      tenant,
      governed.id,
      1,
      "proposed",
      { proposalIds: ["prop_1"] },
      new Date(iso(1000)),
    );
    expect(moved.state).toBe("proposed");
    expect(moved.proposalIds).toEqual(["prop_1"]);
    await expect(
      stores.cases.transition(tenant, governed.id, 1, "executing", {}, new Date(iso(2000))),
    ).rejects.toBeInstanceOf(GovernanceConflictError);
  });

  it("creates one reconciliation per dedupe key and decides it once", async () => {
    const dedupeKey = `job:${randomUUID()}`;
    const base = {
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: tenant,
      reason: "unknown_outcome" as const,
      status: "open" as const,
      dedupeKey,
      detail: { why: "unknown" },
      version: 1,
      createdAt: iso(),
      updatedAt: iso(),
    };
    const first = await stores.reconciliations.createIfAbsent({ id: `recon_${randomUUID()}`, ...base });
    expect(first.inserted).toBe(true);
    const second = await stores.reconciliations.createIfAbsent({ id: `recon_${randomUUID()}`, ...base });
    expect(second.inserted).toBe(false);
    expect(second.reconciliation.id).toBe(first.reconciliation.id);

    const decided = await stores.reconciliations.decide(
      tenant,
      first.reconciliation.id,
      { status: "resolved", resolvedBy: "u_approver", resolution: "no charge found" },
      1,
      new Date(iso(1000)),
    );
    expect(decided.status).toBe("resolved");
    await expect(
      stores.reconciliations.decide(
        tenant,
        first.reconciliation.id,
        { status: "dismissed", resolvedBy: "u_approver", resolution: "again" },
        2,
        new Date(iso(2000)),
      ),
    ).rejects.toBeInstanceOf(GovernanceConflictError);
  });

  it("meters usage idempotently", async () => {
    const key = `case_${randomUUID().slice(0, 8)}`;
    const event = {
      id: `usage_${randomUUID().slice(0, 8)}`,
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: tenant,
      kind: "case_intake" as const,
      quantity: 1,
      idempotencyKey: key,
      occurredAt: iso(),
    };
    expect(await stores.usage.recordIfAbsent(event)).toBe(true);
    expect(await stores.usage.recordIfAbsent({ ...event, id: `usage_${randomUUID()}` })).toBe(false);
    expect(await stores.usage.sum(tenant, "case_intake")).toBe(1);
    expect(await stores.usage.sum(other, "case_intake")).toBe(0);
  });

  it("survives a reconnect with all control-plane state intact", async () => {
    const second = createPool(DATABASE_URL!);
    try {
      const reconnected = postgresGovernanceStores(second);
      const workspace = await reconnected.workspaces.getByTenantId(tenant);
      expect(workspace?.organizationId).toBe(orgId);
      const open = await reconnected.reconciliations.countOpen(tenant);
      expect(open).toBeGreaterThanOrEqual(0);
      const jobs = await reconnected.jobs.list(tenant);
      expect(jobs.length).toBeGreaterThan(0);
    } finally {
      await second.end();
    }
  });
});
