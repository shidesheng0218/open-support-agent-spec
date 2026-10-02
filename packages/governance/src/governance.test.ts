import { describe, expect, it } from "vitest";
import {
  ConnectionService,
  GOVERNANCE_SPEC_VERSION,
  GovernanceConflictError,
  GovernanceForbiddenError,
  GovernanceNotFoundError,
  GovernanceSecretRefusedError,
  GovernanceValidationError,
  InMemoryConnectionStore,
  InMemoryGovernedCaseStore,
  InMemoryGovernanceUsageStore,
  InMemoryOrganizationStore,
  InMemoryWorkspaceStore,
  assertCapabilitySyntax,
  assertOpaqueCredentialRef,
  assertTenantAccess,
  can,
  effectiveCapabilities,
  fixedClock,
  isWriteCapability,
  roleCapabilities,
  sequentialIdFactory,
  type Connection,
  type ConnectionProbe,
  type GovernanceActor,
  type GovernedCase,
} from "./index.js";

const TENANT_A = "tenant_alpha";
const TENANT_B = "tenant_beta";

const actor = (
  roles: GovernanceActor["roles"],
  tenantId: string | undefined = TENANT_A,
  actorId = "u_test",
): GovernanceActor => ({ actorId, roles, tenantId, authenticated: true });

describe("governance RBAC", () => {
  it("keeps separation of duties between operator and approver", () => {
    expect(can(["operator"], "case:write")).toBe(true);
    expect(can(["operator"], "approval:decide")).toBe(false);
    expect(can(["approver"], "approval:decide")).toBe(true);
    expect(can(["approver"], "case:write")).toBe(false);
    expect(can(["approver"], "connection:write")).toBe(false);
  });

  it("gives the auditor read access and nothing else", () => {
    const caps = effectiveCapabilities(["auditor"]);
    expect(caps.has("audit:read")).toBe(true);
    expect(caps.has("reconciliation:read")).toBe(true);
    for (const cap of caps) expect(cap.endsWith(":read")).toBe(true);
  });

  it("reserves organization:write for the owner", () => {
    expect(can(["owner"], "organization:write")).toBe(true);
    expect(can(["admin"], "organization:write")).toBe(false);
    expect(can(["admin"], "connection:write")).toBe(true);
  });

  it("grants nothing to an unknown role", () => {
    expect(roleCapabilities("nobody" as never)).toEqual([]);
    expect(can(["nobody" as never], "case:read")).toBe(false);
  });

  it("never grants an execution capability from the control plane", () => {
    // The governance matrix is resource:action only. Executing an approved
    // action stays behind the policy engine and the adapter permission ladder.
    for (const role of ["owner", "admin", "operator", "approver", "auditor", "viewer"] as const) {
      for (const cap of roleCapabilities(role)) {
        expect(cap).not.toMatch(/execute|execution/);
      }
    }
  });

  it("denies with an explainable error", () => {
    try {
      const roles = ["viewer"] as const;
      if (!can(roles, "connection:write")) {
        throw new GovernanceForbiddenError("u_viewer", "connection:write", roles);
      }
      throw new Error("expected denial");
    } catch (err) {
      expect(err).toBeInstanceOf(GovernanceForbiddenError);
      expect((err as Error).message).toContain("connection:write");
      expect((err as Error).message).toContain("viewer");
    }
  });
});

describe("governance tenant isolation", () => {
  it("rejects an actor with no tenant binding", () => {
    expect(() => assertTenantAccess({ actorId: "x", roles: ["admin"], authenticated: true }, TENANT_A)).toThrow(
      /no tenant binding/,
    );
  });

  it("rejects cross-tenant access", () => {
    expect(() => assertTenantAccess(actor(["admin"], TENANT_A), TENANT_B)).toThrow(/not authorized/);
  });

  it("does not leak the existence of another tenant's connection", async () => {
    const service = makeConnectionService();
    const created = await service.create(actor(["admin"], TENANT_B), {
      tenantId: TENANT_B,
      provider: "mock",
      externalAccountId: "acct_b",
      capabilities: ["ticket.read"],
    });
    await expect(service.get(actor(["admin"], TENANT_A), TENANT_A, created.id)).rejects.toBeInstanceOf(
      GovernanceNotFoundError,
    );
    await expect(service.get(actor(["admin"], TENANT_A), TENANT_A, created.id)).rejects.toThrow(
      /connection .* was not found/,
    );
  });
});

function makeConnectionService(probe?: ConnectionProbe) {
  return new ConnectionService({
    store: new InMemoryConnectionStore(),
    clock: fixedClock("2026-01-01T00:00:00.000Z"),
    ids: sequentialIdFactory(),
    ...(probe ? { probe } : {}),
  });
}

describe("credential references never store secrets", () => {
  it("refuses provider token shapes", () => {
    for (const bad of [
      "shpat_0123456789abcdef",
      "xoxb-1234-5678",
      "sk-live-abcdef",
      "Bearer abcdef",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      "AKIAIOSFODNN7EXAMPLE",
    ]) {
      expect(() => assertOpaqueCredentialRef(bad), bad).toThrow(GovernanceSecretRefusedError);
    }
  });

  it("refuses a bare token with no scheme", () => {
    expect(() => assertOpaqueCredentialRef("abcdef1234567890")).toThrow(/must be a reference with a scheme/);
    expect(() => assertOpaqueCredentialRef("has whitespace")).toThrow(GovernanceSecretRefusedError);
  });

  it("accepts an opaque pointer", () => {
    expect(() => assertOpaqueCredentialRef("vault:secret/data/osas/acme")).not.toThrow();
    expect(() => assertOpaqueCredentialRef("env:ACME_SHOPIFY_TOKEN")).not.toThrow();
    expect(() => assertOpaqueCredentialRef("aws-sm:prod/osas/acme")).not.toThrow();
  });

  it("rejects a raw token supplied at connection creation", async () => {
    const service = makeConnectionService();
    await expect(
      service.create(actor(["admin"]), {
        tenantId: TENANT_A,
        provider: "shopify",
        externalAccountId: "acme.myshopify.com",
        capabilities: ["ecommerce.order.read"],
        credentialRef: "shpat_deadbeef",
      }),
    ).rejects.toBeInstanceOf(GovernanceSecretRefusedError);
  });
});

describe("connection lifecycle", () => {
  it("creates paused and refuses use until verified", async () => {
    const service = makeConnectionService();
    const connection = await service.create(actor(["admin"]), {
      tenantId: TENANT_A,
      provider: "shopify",
      externalAccountId: "acme.myshopify.com",
      capabilities: ["ecommerce.order.read"],
    });
    expect(connection.status).toBe("paused");
    await expect(service.requireUsable(TENANT_A, connection.id, "ecommerce.order.read")).rejects.toThrow(
      /is paused/,
    );
  });

  it("fails closed when no probe is configured", async () => {
    const service = makeConnectionService();
    const connection = await service.create(actor(["admin"]), {
      tenantId: TENANT_A,
      provider: "shopify",
      externalAccountId: "acme.myshopify.com",
      capabilities: ["ecommerce.order.read"],
    });
    const verified = await service.verify(actor(["admin"]), TENANT_A, connection.id);
    expect(verified.status).toBe("error");
    expect(verified.lastErrorCode).toBe("NO_PROBE_CONFIGURED");
  });

  it("activates only after a successful probe and then enforces capabilities", async () => {
    const service = makeConnectionService(async () => ({ ok: true, apiVersion: "2026-01" }));
    const connection = await service.create(actor(["admin"]), {
      tenantId: TENANT_A,
      provider: "shopify",
      externalAccountId: "acme.myshopify.com",
      capabilities: ["ecommerce.order.read"],
    });
    const verified = await service.verify(actor(["admin"]), TENANT_A, connection.id);
    expect(verified.status).toBe("active");
    expect(verified.apiVersion).toBe("2026-01");

    const usable = await service.requireUsable(TENANT_A, connection.id, "ecommerce.order.read");
    expect(usable.id).toBe(connection.id);
    await expect(
      service.requireUsable(TENANT_A, connection.id, "ecommerce.refund.execute"),
    ).rejects.toThrow(/does not declare capability/);
  });

  it("parks a connection in error when the probe fails", async () => {
    const service = makeConnectionService(async () => ({ ok: false, errorCode: "HTTP_401" }));
    const connection = await service.create(actor(["admin"]), {
      tenantId: TENANT_A,
      provider: "zendesk",
      externalAccountId: "acme",
      capabilities: ["ticket.read"],
    });
    const verified = await service.verify(actor(["admin"]), TENANT_A, connection.id);
    expect(verified.status).toBe("error");
    expect(verified.lastErrorCode).toBe("HTTP_401");
    await expect(service.requireUsable(TENANT_A, connection.id, "ticket.read")).rejects.toThrow(/is error/);
  });

  it("refuses to resume a connection that was never verified", async () => {
    const service = makeConnectionService();
    const connection = await service.create(actor(["admin"]), {
      tenantId: TENANT_A,
      provider: "zendesk",
      externalAccountId: "acme",
      capabilities: ["ticket.read"],
    });
    await expect(service.resume(actor(["admin"]), TENANT_A, connection.id)).rejects.toBeInstanceOf(
      GovernanceConflictError,
    );
  });

  it("returns a rotated connection to paused", async () => {
    const service = makeConnectionService(async () => ({ ok: true }));
    const connection = await service.create(actor(["admin"]), {
      tenantId: TENANT_A,
      provider: "zendesk",
      externalAccountId: "acme",
      capabilities: ["ticket.read"],
      credentialRef: "vault:secret/data/osas/zendesk/one",
    });
    await service.verify(actor(["admin"]), TENANT_A, connection.id);
    const rotated = await service.rotateCredential(
      actor(["admin"]),
      TENANT_A,
      connection.id,
      "vault:secret/data/osas/zendesk/two",
    );
    expect(rotated.status).toBe("paused");
    expect(rotated.credentialRef).toBe("vault:secret/data/osas/zendesk/two");
    await expect(service.rotateCredential(actor(["operator"]), TENANT_A, connection.id, "vault:x")).rejects.toBeInstanceOf(
      GovernanceForbiddenError,
    );
  });

  it("requires revocation before deletion and blocks all use after revocation", async () => {
    const service = makeConnectionService(async () => ({ ok: true }));
    const connection = await service.create(actor(["admin"]), {
      tenantId: TENANT_A,
      provider: "chatwoot",
      externalAccountId: "acme",
      capabilities: ["conversation.read"],
    });
    await service.verify(actor(["admin"]), TENANT_A, connection.id);
    await expect(service.remove(actor(["admin"]), TENANT_A, connection.id)).rejects.toThrow(
      /must be revoked before deletion/,
    );
    const revoked = await service.revoke(actor(["admin"]), TENANT_A, connection.id);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).toBeDefined();
    await expect(
      service.requireUsable(TENANT_A, connection.id, "conversation.read"),
    ).rejects.toThrow(/is revoked/);
    await service.remove(actor(["admin"]), TENANT_A, connection.id);
    await expect(service.get(actor(["admin"]), TENANT_A, connection.id)).rejects.toBeInstanceOf(
      GovernanceNotFoundError,
    );
  });

  it("rejects undeclared write capability without a credential reference", async () => {
    const service = makeConnectionService();
    await expect(
      service.create(actor(["admin"]), {
        tenantId: TENANT_A,
        provider: "shopify",
        externalAccountId: "acme.myshopify.com",
        capabilities: ["ecommerce.refund.execute"],
      }),
    ).rejects.toBeInstanceOf(GovernanceValidationError);
  });

  it("requires the connection:write capability", async () => {
    const service = makeConnectionService();
    await expect(
      service.create(actor(["auditor"]), {
        tenantId: TENANT_A,
        provider: "mock",
        externalAccountId: "acct",
        capabilities: ["ticket.read"],
      }),
    ).rejects.toBeInstanceOf(GovernanceForbiddenError);
  });

  it("classifies write capabilities by suffix", () => {
    expect(isWriteCapability("ecommerce.refund.execute")).toBe(true);
    expect(isWriteCapability("escalation.write")).toBe(true);
    expect(isWriteCapability("ecommerce.order.read")).toBe(false);
    expect(() => assertCapabilitySyntax(["NotDotted"])).toThrow(GovernanceValidationError);
    expect(() => assertCapabilitySyntax(["a.b", "a.b"])).toThrow(/listed twice/);
  });
});

describe("governed case state machine", () => {
  const makeStore = () => new InMemoryGovernedCaseStore();
  const caseRecord = (overrides: Partial<GovernedCase> = {}): GovernedCase => ({
    id: "case_1",
    specVersion: GOVERNANCE_SPEC_VERSION,
    tenantId: TENANT_A,
    subject: "Damaged item",
    state: "intake",
    priority: "normal",
    idempotencyKey: "idem_1",
    evidenceIds: [],
    proposalIds: [],
    approvalIds: [],
    executionAttemptIds: [],
    reconciliationIds: [],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("is idempotent on (tenant, idempotencyKey)", async () => {
    const store = makeStore();
    const first = await store.createIfAbsent(caseRecord());
    expect(first.inserted).toBe(true);
    const second = await store.createIfAbsent(caseRecord({ id: "case_2", subject: "other" }));
    expect(second.inserted).toBe(false);
    expect(second.case.id).toBe("case_1");
    expect(second.case.subject).toBe("Damaged item");
  });

  it("refuses an illegal transition", async () => {
    const store = makeStore();
    await store.createIfAbsent(caseRecord());
    await expect(
      store.transition(TENANT_A, "case_1", 1, "resolved", {}, new Date("2026-01-02T00:00:00.000Z")),
    ).rejects.toThrow(/cannot move from "intake" to "resolved"/);
  });

  it("is compare-and-set on version", async () => {
    const store = makeStore();
    await store.createIfAbsent(caseRecord());
    const moved = await store.transition(
      TENANT_A,
      "case_1",
      1,
      "proposed",
      { proposalIds: ["prop_1"] },
      new Date("2026-01-02T00:00:00.000Z"),
    );
    expect(moved.state).toBe("proposed");
    expect(moved.version).toBe(2);
    await expect(
      store.transition(TENANT_A, "case_1", 1, "blocked", {}, new Date("2026-01-03T00:00:00.000Z")),
    ).rejects.toBeInstanceOf(GovernanceConflictError);
  });

  it("stamps closedAt when resolved and keeps reconciliation reachable", async () => {
    const store = makeStore();
    await store.createIfAbsent(caseRecord({ state: "executing", version: 4 }));
    const done = await store.transition(
      TENANT_A,
      "case_1",
      4,
      "resolved",
      {},
      new Date("2026-01-05T00:00:00.000Z"),
    );
    expect(done.closedAt).toBe("2026-01-05T00:00:00.000Z");
    await expect(
      store.transition(TENANT_A, "case_1", done.version, "intake", {}, new Date()),
    ).rejects.toThrow(/cannot move from "resolved"/);

    await store.createIfAbsent(caseRecord({ id: "case_9", idempotencyKey: "idem_9", state: "executing", version: 2 }));
    const uncertain = await store.transition(
      TENANT_A,
      "case_9",
      2,
      "reconciliation_required",
      {},
      new Date("2026-01-05T00:00:00.000Z"),
    );
    expect(uncertain.state).toBe("reconciliation_required");
    const resolved = await store.transition(
      TENANT_A,
      "case_9",
      uncertain.version,
      "resolved",
      {},
      new Date("2026-01-06T00:00:00.000Z"),
    );
    expect(resolved.state).toBe("resolved");
  });
});

describe("control-plane usage metering", () => {
  it("is idempotent on (tenant, idempotencyKey)", async () => {
    const store = new InMemoryGovernanceUsageStore();
    const event = {
      id: "usage_1",
      specVersion: GOVERNANCE_SPEC_VERSION,
      tenantId: TENANT_A,
      kind: "case_intake" as const,
      quantity: 1,
      idempotencyKey: "case_1_intake",
      occurredAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await store.recordIfAbsent(event)).toBe(true);
    expect(await store.recordIfAbsent({ ...event, id: "usage_2" })).toBe(false);
    expect(await store.sum(TENANT_A)).toBe(1);
    expect(await store.sum(TENANT_B)).toBe(0);
  });
});

describe("organization and workspace stores", () => {
  it("keeps a tenant bound to exactly one workspace", async () => {
    const store = new InMemoryWorkspaceStore();
    const base = {
      specVersion: GOVERNANCE_SPEC_VERSION,
      organizationId: "org_1",
      tenantId: TENANT_A,
      name: "Support",
      status: "active" as const,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.createIfAbsent({ id: "ws_1", ...base });
    await expect(store.createIfAbsent({ id: "ws_2", ...base })).rejects.toBeInstanceOf(
      GovernanceConflictError,
    );
  });

  it("is compare-and-set on organization version", async () => {
    const store = new InMemoryOrganizationStore();
    await store.createIfAbsent({
      id: "org_1",
      specVersion: GOVERNANCE_SPEC_VERSION,
      name: "Acme",
      status: "active",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const renamed = await store.update("org_1", { name: "Acme Inc" }, 1);
    expect(renamed.name).toBe("Acme Inc");
    expect(renamed.version).toBe(2);
    await expect(store.update("org_1", { name: "Nope" }, 1)).rejects.toBeInstanceOf(
      GovernanceConflictError,
    );
  });
});
