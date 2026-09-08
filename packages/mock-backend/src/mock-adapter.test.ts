import { describe, expect, it } from "vitest";
import {
  AdapterNotFoundError,
  AdapterPermissionError,
  type Principal,
  type ToolContext,
} from "@osas/adapter";
import type { ActionProposal } from "@osas/core";
import { createDemoFixtures, DEMO_TENANT_ID } from "./fixtures.js";
import { MockSupportAdapter } from "./mock-adapter.js";

const principal = (permission: Principal["permission"]): Principal => ({
  actorType: "model",
  actorId: "test-model",
  permission,
});

const ctx = (permission: Principal["permission"] = "execute"): ToolContext => ({
  tenantId: DEMO_TENANT_ID,
  principal: principal(permission),
});

const proposalInput = (
  overrides: Partial<Record<string, unknown>> = {},
): Parameters<MockSupportAdapter["createActionProposal"]>[1] => ({
  tenantId: DEMO_TENANT_ID,
  caseId: "case_refund",
  profile: "ecommerce",
  actionType: "refund",
  reasonCode: "damaged",
  params: { orderId: "ord_small" },
  requestedPermission: "request-approval",
  requestedBy: { actorType: "model", actorId: "test-model" },
  amount: { currency: "USD", minorUnits: 2500 },
  evidenceIds: ["ev_ord_small"],
  idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
  ...overrides,
} as Parameters<MockSupportAdapter["createActionProposal"]>[1]);

describe("MockSupportAdapter reads", () => {
  it("returns fixture cases, customers, orders, subscriptions", async () => {
    const adapter = new MockSupportAdapter();
    expect((await adapter.getCase(ctx("read"), "case_refund")).subject).toContain("ord_small");
    expect((await adapter.getCustomer(ctx("read"), "cus_verified")).region).toBe("US");
    expect((await adapter.getOrder(ctx("read"), "ord_small")).total.minorUnits).toBe(2500);
    expect((await adapter.listOrders(ctx("read"), "cus_verified")).map((o) => o.id).sort()).toEqual(
      [
        "ord_damaged",
        "ord_delayed",
        "ord_exch_instock",
        "ord_exch_oos",
        "ord_in_transit",
        "ord_large",
        "ord_multiline",
        "ord_refund_failed",
        "ord_refund_processing",
        "ord_refunded",
        "ord_shipped_window",
        "ord_small",
        "ord_unshipped",
        "ord_wrong_sku",
      ],
    );
    expect((await adapter.getShipment(ctx("read"), "shp_small")).status).toBe("delivered");
    expect((await adapter.getSubscription(ctx("read"), "sub_active")).status).toBe("active");
    expect((await adapter.listInvoices(ctx("read"), "cus_verified"))[0]?.id).toBe("inv_001");
    expect(
      (await adapter.getCreditBalance(ctx("read"), "cus_verified")).balance.minorUnits,
    ).toBe(0);
  });

  it("searches cases and knowledge", async () => {
    const adapter = new MockSupportAdapter();
    const byCustomer = await adapter.searchCases(ctx("read"), { customerId: "cus_unverified" });
    expect(byCustomer.map((c) => c.id)).toEqual(["case_unverified"]);
    const kb = await adapter.searchKnowledge(ctx("read"), { q: "refund", limit: 5 });
    expect(kb.map((k) => k.id)).toContain("kb_refund_policy");
  });

  it("throws AdapterNotFoundError for unknown ids and foreign tenants", async () => {
    const adapter = new MockSupportAdapter();
    await expect(adapter.getCase(ctx("read"), "case_nope")).rejects.toBeInstanceOf(
      AdapterNotFoundError,
    );
    await expect(
      adapter.getCase({ tenantId: "tenant_other", principal: principal("read") }, "case_refund"),
    ).rejects.toBeInstanceOf(AdapterNotFoundError);
  });

  it("returns deep copies: mutating results does not corrupt adapter state", async () => {
    const adapter = new MockSupportAdapter();
    const first = await adapter.getCase(ctx("read"), "case_refund");
    first.tags.push("hacked");
    first.subject = "hacked";
    const second = await adapter.getCase(ctx("read"), "case_refund");
    expect(second.tags).toEqual(["refund"]);
    expect(second.subject).toContain("ord_small");
  });

  it("two adapters seeded with fresh fixtures do not share state", async () => {
    const a = new MockSupportAdapter(createDemoFixtures());
    const b = new MockSupportAdapter(createDemoFixtures());
    const execCtx = ctx("execute");
    const proposal = await a.getProposal(execCtx, "prop_dup_refund");
    await a.executeAction(execCtx, proposal);
    expect((await a.getOrder(execCtx, "ord_small")).status).toBe("refunded");
    expect((await b.getOrder(execCtx, "ord_small")).status).toBe("delivered");
  });
});

describe("MockSupportAdapter permissions", () => {
  it("enforces the permission ladder", async () => {
    const adapter = new MockSupportAdapter();
    // reads allowed at "read"
    await expect(adapter.getCase(ctx("read"), "case_refund")).resolves.toBeDefined();
    // writes rejected below "draft"
    await expect(
      adapter.createCaseNote(ctx("read"), {
        caseId: "case_refund",
        body: "hi",
        idempotencyKey: "k1",
      }),
    ).rejects.toBeInstanceOf(AdapterPermissionError);
    // executeAction requires "execute"
    const proposal = await adapter.createActionProposal(ctx("draft"), proposalInput());
    await expect(
      adapter.executeAction(ctx("request-approval"), proposal),
    ).rejects.toBeInstanceOf(AdapterPermissionError);
    // putPolicy requires "execute"
    const policy = await adapter.getPolicy(ctx("read"), DEMO_TENANT_ID);
    await expect(adapter.putPolicy(ctx("request-approval"), policy)).rejects.toBeInstanceOf(
      AdapterPermissionError,
    );
    await expect(adapter.putPolicy(ctx("execute"), policy)).resolves.toBeDefined();
  });

  it("error codes match the contract (NOT_FOUND / PERMISSION_DENIED)", async () => {
    const adapter = new MockSupportAdapter();
    const notFound = await adapter.getCase(ctx("read"), "nope").catch((e: unknown) => e);
    expect((notFound as AdapterNotFoundError).code).toBe("NOT_FOUND");
    const denied = await adapter
      .getPolicy({ tenantId: DEMO_TENANT_ID, principal: { actorType: "model", actorId: "x", permission: "read" } }, DEMO_TENANT_ID)
      .then(() => adapter.putPolicy(ctx("draft"), {} as never))
      .catch((e: unknown) => e);
    expect((denied as AdapterPermissionError).code).toBe("PERMISSION_DENIED");
  });
});

describe("MockSupportAdapter.executeAction", () => {
  it("refund marks the order refunded and returns an externalRef", async () => {
    const adapter = new MockSupportAdapter();
    const proposal = await adapter.createActionProposal(ctx("draft"), proposalInput());
    const result = await adapter.executeAction(ctx("execute"), proposal);
    expect(result.status).toBe("succeeded");
    expect(result.externalRef).toMatch(/^rfnd_/);
    expect((await adapter.getOrder(ctx(), "ord_small")).status).toBe("refunded");
  });

  it("credit_apply increases the credit balance", async () => {
    const adapter = new MockSupportAdapter();
    const proposal = await adapter.createActionProposal(
      ctx("draft"),
      proposalInput({
        caseId: "case_credit",
        profile: "saas",
        actionType: "credit_apply",
        reasonCode: "service_outage",
        params: { customerId: "cus_verified" },
        amount: { currency: "USD", minorUnits: 1500 },
        evidenceIds: [],
      }),
    );
    const result = await adapter.executeAction(ctx("execute"), proposal);
    expect(result.status).toBe("succeeded");
    expect(result.externalRef).toMatch(/^cr_/);
    expect((await adapter.getCreditBalance(ctx(), "cus_verified")).balance.minorUnits).toBe(1500);
  });

  it("subscription_cancel cancels the subscription", async () => {
    const adapter = new MockSupportAdapter();
    const proposal = await adapter.createActionProposal(
      ctx("draft"),
      proposalInput({
        caseId: "case_credit",
        profile: "saas",
        actionType: "subscription_cancel",
        reasonCode: "other",
        params: { subscriptionId: "sub_active" },
        amount: undefined,
        evidenceIds: [],
      }),
    );
    const result = await adapter.executeAction(ctx("execute"), proposal);
    expect(result.status).toBe("succeeded");
    expect((await adapter.getSubscription(ctx(), "sub_active")).status).toBe("cancelled");
  });

  it("create_note / create_escalation proposals store records", async () => {
    const adapter = new MockSupportAdapter();
    const noteProposal = await adapter.createActionProposal(
      ctx("draft"),
      proposalInput({
        profile: "core",
        actionType: "create_note",
        reasonCode: "other",
        params: { body: "called the customer" },
        amount: undefined,
        evidenceIds: [],
      }),
    );
    const noteResult = await adapter.executeAction(ctx("execute"), noteProposal);
    expect(noteResult.status).toBe("succeeded");
    expect(noteResult.externalRef).toMatch(/^note_/);
  });

  it('returns uncertain without side effects when params.simulate === "timeout"', async () => {
    const adapter = new MockSupportAdapter();
    const proposal = await adapter.createActionProposal(
      ctx("draft"),
      proposalInput({ params: { orderId: "ord_small", simulate: "timeout" } }),
    );
    const result = await adapter.executeAction(ctx("execute"), proposal);
    expect(result.status).toBe("uncertain");
    expect((await adapter.getOrder(ctx(), "ord_small")).status).toBe("delivered");
  });

  it("fails cleanly for unknown orders", async () => {
    const adapter = new MockSupportAdapter();
    const proposal = await adapter.createActionProposal(
      ctx("draft"),
      proposalInput({ params: { orderId: "ord_missing" } }),
    );
    const result = await adapter.executeAction(ctx("execute"), proposal);
    expect(result.status).toBe("failed");
  });
});

describe("MockSupportAdapter CRUD round-trips", () => {
  it("proposal create/get/list/update round-trip", async () => {
    const adapter = new MockSupportAdapter();
    const p = await adapter.createActionProposal(ctx("draft"), proposalInput());
    expect(p.id).toMatch(/^prop_\d+$/);
    expect(p.status).toBe("proposed");
    expect((await adapter.getProposal(ctx(), p.id)).idempotencyKey).toBe(p.idempotencyKey);
    const listed = await adapter.listProposals(ctx(), { caseId: "case_refund" });
    expect(listed.map((x) => x.id)).toContain(p.id);
    const updated = await adapter.updateProposalStatus(ctx(), p.id, "pending_approval");
    expect(updated.status).toBe("pending_approval");
    expect(
      (await adapter.listProposals(ctx(), { status: "pending_approval" })).map((x) => x.id),
    ).toContain(p.id);
    // fixture proposal still queryable
    const dup = await adapter.listProposals(ctx(), { caseId: "case_dup" });
    expect(dup.map((x) => x.id)).toEqual(["prop_dup_refund"]);
  });

  it("approval create/get/list/decide round-trip", async () => {
    const adapter = new MockSupportAdapter();
    const p = await adapter.createActionProposal(ctx("draft"), proposalInput());
    const a = await adapter.createApproval(ctx("draft"), {
      tenantId: DEMO_TENANT_ID,
      proposalId: p.id,
      status: "pending",
      policyVersion: "1.0.0",
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(a.id).toMatch(/^appr_\d+$/);
    expect((await adapter.listApprovals(ctx(), { status: "pending" })).map((x) => x.id)).toContain(
      a.id,
    );
    const decided = await adapter.decideApproval(ctx(), a.id, "approved", "agent_1", "looks fine");
    expect(decided.status).toBe("approved");
    expect(decided.approverId).toBe("agent_1");
    expect(decided.comment).toBe("looks fine");
    expect(decided.decidedAt).toBeTruthy();
    expect((await adapter.getApproval(ctx(), a.id)).status).toBe("approved");
  });

  it("handoff create/list/update round-trip", async () => {
    const adapter = new MockSupportAdapter();
    const h = await adapter.createHandoff(ctx("draft"), {
      tenantId: DEMO_TENANT_ID,
      caseId: "case_unverified",
      reason: "identity_unverified",
    });
    expect(h.status).toBe("open");
    const claimed = await adapter.updateHandoff(ctx(), h.id, {
      status: "claimed",
      assignedTo: "agent_2",
    });
    expect(claimed.assignedTo).toBe("agent_2");
    const resolved = await adapter.updateHandoff(ctx(), h.id, {
      status: "resolved",
      notes: "verified by phone",
      resolvedAt: new Date().toISOString(),
    });
    expect(resolved.status).toBe("resolved");
    expect((await adapter.listHandoffs(ctx(), { status: "resolved" })).map((x) => x.id)).toContain(
      h.id,
    );
  });

  it("audit append/list round-trip and deterministic id counters", async () => {
    const adapter = new MockSupportAdapter();
    const e1 = await adapter.appendAuditEvent(ctx("draft"), {
      tenantId: DEMO_TENANT_ID,
      caseId: "case_refund",
      eventType: "proposal_created",
      actorType: "model",
      actorId: "test-model",
      detail: { note: "first" },
    });
    const e2 = await adapter.appendAuditEvent(ctx("draft"), {
      tenantId: DEMO_TENANT_ID,
      caseId: "case_refund",
      proposalId: "prop_dup_refund",
      eventType: "policy_evaluated",
      actorType: "policy_engine",
      actorId: "engine",
      policyVersion: "1.0.0",
      detail: { decision: "auto_execute" },
    });
    expect([e1.id, e2.id]).toEqual(["audit_1", "audit_2"]);
    expect((await adapter.listAuditEvents(ctx(), { caseId: "case_refund" })).length).toBe(2);
    expect(
      (await adapter.listAuditEvents(ctx(), { proposalId: "prop_dup_refund" })).map((e) => e.id),
    ).toEqual(["audit_2"]);
  });

  it("notes/escalations and evidence capture round-trip; policy get/put", async () => {
    const adapter = new MockSupportAdapter();
    const note = await adapter.createCaseNote(ctx("draft"), {
      caseId: "case_refund",
      body: "Customer sent photos",
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: "note-key-1",
    });
    expect(note.id).toBe("note_1");
    const esc = await adapter.createEscalation(ctx("draft"), {
      caseId: "case_refund",
      reason: "VIP customer",
      idempotencyKey: "esc-key-1",
    });
    expect(esc.id).toBe("esc_1");
    const ev = await adapter.captureEvidence(ctx("draft"), {
      tenantId: DEMO_TENANT_ID,
      caseId: "case_refund",
      kind: "conversation",
      source: { system: "mock-tickets", recordType: "message", recordId: "msg_1" },
      summary: "Customer confirms damage",
      data: { excerpt: "the mug arrived broken" },
      retrievedAt: new Date().toISOString(),
    });
    expect(ev.id).toBe("ev_1");
    const policy = await adapter.getPolicy(ctx(), DEMO_TENANT_ID);
    await adapter.putPolicy(ctx(), { ...policy, version: "1.0.1" });
    expect((await adapter.getPolicy(ctx(), DEMO_TENANT_ID)).version).toBe("1.0.1");
  });

  it("fixture proposals are visible as ActionProposal objects", async () => {
    const adapter = new MockSupportAdapter();
    const dup: ActionProposal = await adapter.getProposal(ctx(), "prop_dup_refund");
    expect(dup.status).toBe("executed");
    expect(dup.actionType).toBe("refund");
  });
});

describe("MockSupportAdapter evidence reads", () => {
  it("getEvidence returns seeded evidence; unknown ids and foreign tenants throw NOT_FOUND", async () => {
    const adapter = new MockSupportAdapter();
    const ev = await adapter.getEvidence(ctx("read"), "ev_expired");
    expect(ev.caseId).toBe("case_refund");
    expect(ev.expiresAt).toBeDefined();
    await expect(adapter.getEvidence(ctx("read"), "ev_nope")).rejects.toBeInstanceOf(
      AdapterNotFoundError,
    );
    await expect(
      adapter.getEvidence(
        { tenantId: "tenant_other", principal: principal("read") },
        "ev_ord_small",
      ),
    ).rejects.toBeInstanceOf(AdapterNotFoundError);
  });

  it("listEvidence returns tenant-scoped evidence, optionally filtered by caseId", async () => {
    const adapter = new MockSupportAdapter();
    const all = await adapter.listEvidence(ctx("read"), {});
    expect(all.map((e) => e.id).sort()).toEqual([
      "ev_damaged_photo1",
      "ev_damaged_photo2",
      "ev_expired",
      "ev_ord_small",
    ]);
    const byCase = await adapter.listEvidence(ctx("read"), { caseId: "case_refund" });
    expect(byCase.map((e) => e.id).sort()).toEqual(["ev_expired", "ev_ord_small"]);
    expect(await adapter.listEvidence(ctx("read"), { caseId: "case_credit" })).toEqual([]);
    expect(
      await adapter.listEvidence(
        { tenantId: "tenant_other", principal: principal("read") },
        {},
      ),
    ).toEqual([]);
  });

  it("captured evidence is retrievable via getEvidence/listEvidence", async () => {
    const adapter = new MockSupportAdapter();
    const ev = await adapter.captureEvidence(ctx("draft"), {
      tenantId: DEMO_TENANT_ID,
      caseId: "case_credit",
      kind: "conversation",
      source: { system: "mock-tickets", recordType: "message", recordId: "msg_9" },
      summary: "Customer reports outage window",
      data: { excerpt: "service was down" },
      retrievedAt: new Date().toISOString(),
    });
    expect((await adapter.getEvidence(ctx("read"), ev.id)).summary).toContain("outage");
    expect(
      (await adapter.listEvidence(ctx("read"), { caseId: "case_credit" })).map((e) => e.id),
    ).toEqual([ev.id]);
  });
});
