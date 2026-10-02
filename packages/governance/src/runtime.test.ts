import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_SPEC_VERSION,
  GovernanceConflictError,
  GovernanceForbiddenError,
  GovernanceRuntime,
  IntegrationEventIntake,
  IntegrationSignatureError,
  JobRunner,
  createRecordOnlyEventConsumer,
  fixedClock,
  inMemoryGovernanceStores,
  sequentialIdFactory,
  type GovernanceActor,
  type GovernanceRuntimeOptions,
} from "./index.js";

const TENANT_A = "tenant_alpha";
const TENANT_B = "tenant_beta";

const admin = (tenantId = TENANT_A): GovernanceActor => ({
  actorId: "u_admin",
  roles: ["admin"],
  tenantId,
  authenticated: true,
});

function makeRuntime(options: Partial<GovernanceRuntimeOptions> = {}) {
  const clock = fixedClock("2026-01-01T00:00:00.000Z");
  const stores = inMemoryGovernanceStores();
  const ids = sequentialIdFactory();
  const runtime = new GovernanceRuntime({ stores, clock, ids, ...options });
  return { runtime, clock, stores, ids };
}

/** Connection that is created and verified, ready to accept events. */
async function activeConnection(runtime: GovernanceRuntime, tenantId = TENANT_A) {
  const connection = await runtime.connections.create(admin(tenantId), {
    tenantId,
    provider: "mock",
    externalAccountId: "acct_1",
    capabilities: ["ticket.read"],
  });
  // Activate directly through the store: probes are covered by the connection
  // suite, and the intake contract under test here is "only active accepts".
  await runtime.stores.connections.update(
    tenantId,
    connection.id,
    { status: "active", lastVerifiedAt: "2026-01-01T00:00:00.000Z" },
    connection.version,
  );
  const active = await runtime.stores.connections.get(tenantId, connection.id);
  if (!active) throw new Error("connection vanished");
  return active;
}

describe("workspace provisioning and health", () => {
  it("provisions one workspace per tenant and is idempotent", async () => {
    const { runtime } = makeRuntime();
    const first = await runtime.provisionWorkspace(admin(), {
      organizationName: "Acme",
      workspaceName: "Support",
      tenantId: TENANT_A,
    });
    expect(first.created).toBe(true);
    expect(first.workspace.tenantId).toBe(TENANT_A);
    expect(first.organization.id).toBe(first.workspace.organizationId);

    const again = await runtime.provisionWorkspace(admin(), {
      organizationName: "Acme renamed",
      workspaceName: "Support renamed",
      tenantId: TENANT_A,
    });
    expect(again.created).toBe(false);
    expect(again.workspace.id).toBe(first.workspace.id);
    expect(again.organization.name).toBe("Acme");
  });

  it("requires workspace:write to provision", async () => {
    const { runtime } = makeRuntime();
    await expect(
      runtime.provisionWorkspace({ actorId: "u_aud", roles: ["auditor"], tenantId: TENANT_A, authenticated: true }, {
        organizationName: "Acme",
        workspaceName: "Support",
      }),
    ).rejects.toBeInstanceOf(GovernanceForbiddenError);
  });

  it("reports a health snapshot without guessing", async () => {
    const { runtime } = makeRuntime();
    const { workspace } = await runtime.provisionWorkspace(admin(), {
      organizationName: "Acme",
      workspaceName: "Support",
      tenantId: TENANT_A,
    });
    await activeConnection(runtime);
    await runtime.recordUsage({ tenantId: TENANT_A, kind: "case_intake", idempotencyKey: "u1" });
    await runtime.recordUsage({ tenantId: TENANT_A, kind: "case_intake", idempotencyKey: "u1" });

    const health = await runtime.health(admin(), TENANT_A);
    expect(health.workspace?.id).toBe(workspace.id);
    expect(health.connections.active).toBe(1);
    expect(health.usage.total).toBe(1);
    expect(health.jobs.queued).toBe(0);
    expect(health.registeredJobKinds).toEqual([]);
    expect(health.reconciliations.open).toBe(0);
  });

  it("denies health to a role without usage:read", async () => {
    const { runtime } = makeRuntime();
    await expect(
      runtime.health({ actorId: "u_v", roles: ["viewer"], tenantId: TENANT_A, authenticated: true }, TENANT_A),
    ).rejects.toBeInstanceOf(GovernanceForbiddenError);
  });
});

describe("integration event inbox", () => {
  it("rejects an unverified delivery without occupying the dedupe key", async () => {
    const { runtime, stores } = makeRuntime();
    const connection = await activeConnection(runtime);
    const base = {
      connectionId: connection.id,
      topic: "ticket.updated",
      externalEventId: "evt_ext_1",
      occurredAt: "2026-01-01T10:00:00.000Z",
    };
    await expect(
      runtime.intake.accept(admin(), TENANT_A, { ...base, signatureVerified: false }),
    ).rejects.toBeInstanceOf(IntegrationSignatureError);
    expect(await stores.integrationEvents.countByStatus(TENANT_A)).toMatchObject({ received: 0 });

    // The forged delivery must not block the genuine one.
    const accepted = await runtime.intake.accept(admin(), TENANT_A, {
      ...base,
      signatureVerified: true,
    });
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.jobRunId).toBeDefined();
  });

  it("deduplicates on the provider identity and enqueues exactly one job", async () => {
    const { runtime, stores } = makeRuntime();
    const connection = await activeConnection(runtime);
    const input = {
      connectionId: connection.id,
      topic: "ticket.updated",
      externalEventId: "evt_ext_2",
      occurredAt: "2026-01-01T10:00:00.000Z",
      signatureVerified: true,
    };
    const first = await runtime.intake.accept(admin(), TENANT_A, input);
    const second = await runtime.intake.accept(admin(), TENANT_A, input);
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("duplicate");
    expect(second.event.id).toBe(first.event.id);
    expect(second.jobRunId).toBeUndefined();
    expect((await stores.jobs.list(TENANT_A)).length).toBe(1);
  });

  it("parks an out-of-order event and asks for a refetch instead of applying it", async () => {
    const { runtime, stores } = makeRuntime();
    const connection = await activeConnection(runtime);
    await runtime.intake.accept(admin(), TENANT_A, {
      connectionId: connection.id,
      topic: "ticket.updated",
      externalEventId: "evt_new",
      occurredAt: "2026-01-01T10:00:00.000Z",
      signatureVerified: true,
    });
    const late = await runtime.intake.accept(admin(), TENANT_A, {
      connectionId: connection.id,
      topic: "ticket.updated",
      externalEventId: "evt_old",
      occurredAt: "2026-01-01T09:00:00.000Z",
      signatureVerified: true,
    });
    expect(late.outcome).toBe("out_of_order");
    expect(late.event.status).toBe("stale_ignored");
    expect(late.reconciliationId).toBeDefined();

    const open = await stores.reconciliations.list(TENANT_A, { status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]?.reason).toBe("out_of_order_event");
    expect(open[0]?.detail.acceptedWatermark).toBe("2026-01-01T10:00:00.000Z");

    const refetch = await stores.jobs.get(TENANT_A, late.jobRunId!);
    expect(refetch?.kind).toBe("reconciliation.refetch");
    expect(refetch?.retryClass).toBe("safe_read");

    // The stale payload never moved the watermark.
    expect(await stores.integrationEvents.acceptedWatermark(TENANT_A, connection.id)).toBe(
      "2026-01-01T10:00:00.000Z",
    );
  });

  it("refuses events for a connection that is not active", async () => {
    const { runtime } = makeRuntime();
    const connection = await runtime.connections.create(admin(), {
      tenantId: TENANT_A,
      provider: "mock",
      externalAccountId: "acct_paused",
      capabilities: ["ticket.read"],
    });
    await expect(
      runtime.intake.accept(admin(), TENANT_A, {
        connectionId: connection.id,
        topic: "ticket.updated",
        externalEventId: "evt_x",
        occurredAt: "2026-01-01T10:00:00.000Z",
        signatureVerified: true,
      }),
    ).rejects.toThrow(/is paused; only an active connection accepts events/);
  });

  it("requires event:write and matching tenant", async () => {
    const { runtime } = makeRuntime();
    const connection = await activeConnection(runtime, TENANT_B);
    await expect(
      runtime.intake.accept(admin(TENANT_A), TENANT_A, {
        connectionId: connection.id,
        topic: "ticket.updated",
        externalEventId: "evt_y",
        occurredAt: "2026-01-01T10:00:00.000Z",
        signatureVerified: true,
      }),
    ).rejects.toThrow();
  });
});

describe("job runner", () => {
  it("never retries a side-effecting job and opens a reconciliation instead", async () => {
    const { runtime, clock } = makeRuntime();
    let calls = 0;
    const runner = new JobRunner({
      stores: runtime.stores,
      clock,
      ids: sequentialIdFactory(),
      owner: "worker_1",
      handlers: {
        "integration_event.process": async () => {
          calls += 1;
          throw new Error("provider blew up");
        },
      },
    });
    const job = await runner.enqueue({
      tenantId: TENANT_A,
      kind: "integration_event.process",
      input: { eventId: "evt_1", connectionId: "conn_1" },
      maxAttempts: 3,
    });
    const report = await runner.runOnce();
    expect(calls).toBe(1);
    expect(report.deadLettered).toHaveLength(1);
    expect(report.retried).toHaveLength(0);
    expect(report.reconciliations).toHaveLength(1);

    const stored = await runtime.stores.jobs.get(TENANT_A, job.id);
    expect(stored?.status).toBe("dead_letter");
    expect(stored?.attempts).toBe(1);
    expect(stored?.lastErrorCode).toBe("ERROR");

    const recon = report.reconciliations[0];
    expect(recon?.reason).toBe("unknown_outcome");
    expect(recon?.jobRunId).toBe(job.id);
    expect(recon?.dedupeKey).toBe(`job:${job.id}`);

    // A later sweep must not resurrect it.
    clock.advance(60_000);
    const second = await runner.runOnce();
    expect(second.deadLettered).toHaveLength(0);
    expect(calls).toBe(1);
  });

  it("retries a safe_read job with backoff and then succeeds", async () => {
    const { runtime, clock } = makeRuntime();
    let calls = 0;
    const runner = new JobRunner({
      stores: runtime.stores,
      clock,
      ids: sequentialIdFactory(),
      owner: "worker_1",
      handlers: {
        "reconciliation.refetch": async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient read failure");
          return { refetched: true };
        },
      },
    });
    const job = await runner.enqueue({
      tenantId: TENANT_A,
      kind: "reconciliation.refetch",
      input: { connectionId: "conn_1" },
      maxAttempts: 3,
    });
    const first = await runner.runOnce();
    expect(first.retried).toHaveLength(1);
    expect(first.reconciliations).toHaveLength(0);
    const afterFirst = await runtime.stores.jobs.get(TENANT_A, job.id);
    expect(afterFirst?.status).toBe("queued");
    expect(afterFirst?.runAt).toBe("2026-01-01T00:00:01.000Z");

    const immediate = await runner.runOnce();
    expect(immediate.claimed).toHaveLength(0);

    clock.advance(5_000);
    const second = await runner.runOnce();
    expect(second.succeeded).toHaveLength(1);
    expect(calls).toBe(2);
    const done = await runtime.stores.jobs.get(TENANT_A, job.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toEqual({ refetched: true });
  });

  it("dead-letters a safe_read job once attempts are exhausted", async () => {
    const { runtime, clock } = makeRuntime();
    const runner = new JobRunner({
      stores: runtime.stores,
      clock,
      ids: sequentialIdFactory(),
      owner: "worker_1",
      handlers: {
        "reconciliation.refetch": async () => {
          throw new Error("still down");
        },
      },
    });
    const job = await runner.enqueue({
      tenantId: TENANT_A,
      kind: "reconciliation.refetch",
      input: {},
      maxAttempts: 2,
    });
    await runner.runOnce();
    clock.advance(60_000);
    const second = await runner.runOnce();
    expect(second.deadLettered).toHaveLength(1);
    expect(second.reconciliations).toHaveLength(0);
    const stored = await runtime.stores.jobs.get(TENANT_A, job.id);
    expect(stored?.status).toBe("dead_letter");
    expect(stored?.attempts).toBe(2);
  });

  it("treats an expired lease on a side-effecting job as an unknown outcome", async () => {
    const { runtime, clock } = makeRuntime();
    const runner = new JobRunner({
      stores: runtime.stores,
      clock,
      ids: sequentialIdFactory(),
      owner: "worker_1",
      leaseMs: 1_000,
      handlers: {},
    });
    const job = await runner.enqueue({
      tenantId: TENANT_A,
      kind: "integration_event.process",
      input: { eventId: "evt_9" },
      maxAttempts: 3,
    });
    // A worker claims it and dies before finishing.
    const claimed = await runtime.stores.jobs.claim({
      owner: "worker_dead",
      now: clock.now(),
      leaseMs: 1_000,
      limit: 10,
      kinds: ["integration_event.process"],
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(job.id);

    clock.advance(2_000);
    const reclaimed = await runner.reclaimExpiredLeases();
    expect(reclaimed.reclaimed).toHaveLength(1);
    expect(reclaimed.deadLettered).toHaveLength(1);
    expect(reclaimed.reconciliations).toHaveLength(1);
    expect(reclaimed.reconciliations[0]?.detail.errorCode).toBe("LEASE_EXPIRED_UNKNOWN_OUTCOME");

    const stored = await runtime.stores.jobs.get(TENANT_A, job.id);
    expect(stored?.status).toBe("dead_letter");
  });

  it("requeues an expired lease on a read-only job without reconciliation", async () => {
    const { runtime, clock } = makeRuntime();
    const runner = new JobRunner({
      stores: runtime.stores,
      clock,
      ids: sequentialIdFactory(),
      owner: "worker_1",
      leaseMs: 1_000,
      handlers: {},
    });
    const job = await runner.enqueue({
      tenantId: TENANT_A,
      kind: "reconciliation.refetch",
      input: {},
      maxAttempts: 5,
    });
    await runtime.stores.jobs.claim({
      owner: "worker_dead",
      now: clock.now(),
      leaseMs: 1_000,
      limit: 10,
      kinds: ["reconciliation.refetch"],
    });
    clock.advance(2_000);
    const reclaimed = await runner.reclaimExpiredLeases();
    expect(reclaimed.reclaimed).toHaveLength(1);
    expect(reclaimed.deadLettered).toHaveLength(0);
    expect(reclaimed.reconciliations).toHaveLength(0);
    const stored = await runtime.stores.jobs.get(TENANT_A, job.id);
    expect(stored?.status).toBe("queued");
  });

  it("never claims a kind it has no handler for", async () => {
    const { runtime, clock } = makeRuntime();
    const runner = new JobRunner({
      stores: runtime.stores,
      clock,
      ids: sequentialIdFactory(),
      owner: "worker_1",
      handlers: {},
    });
    const job = await runner.enqueue({
      tenantId: TENANT_A,
      kind: "integration_event.process",
      input: { eventId: "evt_unhandled" },
    });
    const report = await runner.runOnce();
    expect(report.claimed).toHaveLength(0);
    const stored = await runtime.stores.jobs.get(TENANT_A, job.id);
    expect(stored?.status).toBe("queued");
  });
});

describe("inbox to processed pipeline", () => {
  it("advances the inbox state machine and is idempotent across sweeps", async () => {
    const clock = fixedClock("2026-01-01T00:00:00.000Z");
    const stores = inMemoryGovernanceStores();
    const ids = sequentialIdFactory();
    const intake = new IntegrationEventIntake({ stores, clock, ids });
    const runner = new JobRunner({
      stores,
      clock,
      ids,
      owner: "worker_1",
      handlers: { "integration_event.process": createRecordOnlyEventConsumer(intake) },
    });
    const connection = {
      id: "conn_1",
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: TENANT_A,
      provider: "mock",
      externalAccountId: "acct_1",
      displayName: "mock:acct_1",
      status: "active" as const,
      capabilities: ["ticket.read"],
      scopes: [],
      version: 1,
      createdBy: "u_admin",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await stores.connections.createIfAbsent(connection);

    const accepted = await intake.accept(admin(), TENANT_A, {
      connectionId: connection.id,
      topic: "ticket.updated",
      externalEventId: "evt_pipeline",
      occurredAt: "2026-01-01T10:00:00.000Z",
      signatureVerified: true,
    });
    const report = await runner.runOnce();
    expect(report.succeeded).toHaveLength(1);
    expect(accepted.jobRunId).toBe(report.succeeded[0]?.id);

    const events = await stores.integrationEvents.list(TENANT_A, {});
    expect(events[0]?.status).toBe("processed");
    const counts = await stores.integrationEvents.countByStatus(TENANT_A);
    expect(counts.processed).toBe(1);
    expect(counts.received).toBe(0);
  });
});

describe("reconciliation decisions", () => {
  it("is compare-and-set and single-shot", async () => {
    const { runtime, stores } = makeRuntime();
    const created = await stores.reconciliations.createIfAbsent({
      id: "recon_1",
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: TENANT_A,
      reason: "unknown_outcome",
      status: "open",
      dedupeKey: "job:job_1",
      detail: {},
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(created.inserted).toBe(true);
    const decided = await stores.reconciliations.decide(
      TENANT_A,
      "recon_1",
      { status: "resolved", resolvedBy: "u_approver", resolution: "provider shows no charge" },
      1,
      new Date("2026-01-02T00:00:00.000Z"),
    );
    expect(decided.status).toBe("resolved");
    expect(decided.version).toBe(2);
    await expect(
      stores.reconciliations.decide(
        TENANT_A,
        "recon_1",
        { status: "dismissed", resolvedBy: "u_approver", resolution: "again" },
        2,
        new Date("2026-01-03T00:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(GovernanceConflictError);
    expect(await stores.reconciliations.countOpen(TENANT_A)).toBe(0);
  });
});

describe("restart recovery", () => {
  it("keeps control-plane state across a new runtime over the same stores", async () => {
    const clock = fixedClock("2026-01-01T00:00:00.000Z");
    const stores = inMemoryGovernanceStores();
    const ids = sequentialIdFactory();
    const first = new GovernanceRuntime({ stores, clock, ids });
    const { workspace } = await first.provisionWorkspace(admin(), {
      organizationName: "Acme",
      workspaceName: "Support",
      tenantId: TENANT_A,
    });
    const connection = await activeConnection(first);
    await first.intake.accept(admin(), TENANT_A, {
      connectionId: connection.id,
      topic: "ticket.updated",
      externalEventId: "evt_restart",
      occurredAt: "2026-01-01T10:00:00.000Z",
      signatureVerified: true,
    });

    // Simulate a process restart: brand-new runtime objects, same storage.
    const second = new GovernanceRuntime({ stores, clock, ids });
    const health = await second.health(admin(), TENANT_A);
    expect(health.workspace?.id).toBe(workspace.id);
    expect(health.connections.active).toBe(1);
    expect(health.integrationEvents.received).toBe(1);
    expect(health.jobs.queued).toBe(1);

    const restored = await second.connections.get(admin(), TENANT_A, connection.id);
    expect(restored.credentialRef).toBeUndefined();
  });
});

describe("job tenant isolation", () => {
  it("never returns another tenant's job", async () => {
    const { runtime, stores } = makeRuntime();
    const runner = new JobRunner({
      stores: runtime.stores,
      clock: fixedClock("2026-01-01T00:00:00.000Z"),
      ids: sequentialIdFactory(),
      owner: "worker_1",
      handlers: {},
    });
    const job = await runner.enqueue({ tenantId: TENANT_B, kind: "connection.verify", input: {} });
    expect(await stores.jobs.get(TENANT_A, job.id)).toBeUndefined();
    expect(await stores.jobs.list(TENANT_A)).toEqual([]);
    expect((await stores.jobs.list(TENANT_B)).map((j) => j.id)).toEqual([job.id]);
  });
});
