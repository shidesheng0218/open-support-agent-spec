import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

const TENANT = "tenant_demo";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ logger: false });
});

afterEach(async () => {
  await app.close();
});

const intake = (payload: Record<string, unknown>, headers?: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: "/v1/after-sales/intake",
    headers,
    payload,
  });

describe("after-sales intake and evaluation", () => {
  it("accepts a canonical WISMO intake and evaluates it as answer-only", async () => {
    const created = await intake({
      scenarioCode: "wismo",
      caseId: "case_refund",
      orderId: "ord_in_transit",
      evidenceIds: ["ev_ord_small"],
      message: "Where is my order?",
      idempotencyKey: "after_wismo_1",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().case.scenarioCode).toBe("wismo");

    const evaluated = await app.inject({
      method: "POST",
      url: `/v1/after-sales/cases/${created.json().case.id}/evaluate`,
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().decision.outcome).toBe("answer_only");
    expect(evaluated.json().case.status).toBe("resolved");
  });

  it("blocks an unverified identity before creating a refund proposal", async () => {
    const created = await intake({
      scenarioCode: "refund_request",
      caseId: "case_unverified",
      orderId: "ord_small",
      amount: { currency: "USD", minorUnits: 2500 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: "after_unverified_1",
    });
    const evaluated = await app.inject({
      method: "POST",
      url: `/v1/after-sales/cases/${created.json().case.id}/evaluate`,
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().decision.outcome).toBe("blocked");
    expect(evaluated.json().decision.reasonCodes).toContain("IDENTITY_UNVERIFIED");
    expect(evaluated.json().proposal).toBeUndefined();
  });

  it("rejects a cross-tenant case without exposing adapter records", async () => {
    const created = await intake(
      {
        scenarioCode: "refund_request",
        caseId: "case_refund",
        orderId: "ord_small",
        evidenceIds: ["ev_ord_small"],
        idempotencyKey: "after_cross_tenant_1",
      },
      { "x-tenant-id": "tenant_other" },
    );
    expect(created.statusCode).toBe(404);
  });

  it("parks a damage case in evidence_required when photo evidence is missing", async () => {
    const created = await intake({
      scenarioCode: "damaged_item",
      caseId: "case_refund",
      orderId: "ord_damaged",
      idempotencyKey: "after_damage_missing_evidence_1",
    });
    const evaluated = await app.inject({
      method: "POST",
      url: `/v1/after-sales/cases/${created.json().case.id}/evaluate`,
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().decision.outcome).toBe("blocked");
    expect(evaluated.json().case.status).toBe("evidence_required");
    expect(evaluated.json().decision.requiredEvidence).toContain("damage_photo");
  });

  it("requires approval for a refund above the tenant threshold", async () => {
    const created = await intake({
      scenarioCode: "refund_request",
      caseId: "case_refund",
      orderId: "ord_large",
      amount: { currency: "USD", minorUnits: 7500 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: "after_refund_over_limit_1",
    });
    const evaluated = await app.inject({
      method: "POST",
      url: `/v1/after-sales/cases/${created.json().case.id}/evaluate`,
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().decision.outcome).toBe("approval_required");
    expect(evaluated.json().case.status).toBe("pending_approval");
    expect(evaluated.json().proposal.actionType).toBe("refund");
  });

  it("routes exchange requests to human fulfillment and never executes them", async () => {
    const created = await intake({
      scenarioCode: "exchange_request",
      caseId: "case_refund",
      orderId: "ord_exch_instock",
      idempotencyKey: "after_exchange_1",
    });
    const evaluated = await app.inject({
      method: "POST",
      url: `/v1/after-sales/cases/${created.json().case.id}/evaluate`,
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().decision.outcome).toBe("human_handoff");
    expect(evaluated.json().case.status).toBe("human_handoff");
    expect(evaluated.json().proposal.actionType).toBe("exchange_request");
    expect(evaluated.json().handoff.reason).toBe("other");
  });

  it("replays the original intake for a duplicate tenant idempotency key", async () => {
    const payload = {
      scenarioCode: "wismo",
      caseId: "case_refund",
      orderId: "ord_in_transit",
      idempotencyKey: "after_replay_1",
    };
    const first = await intake(payload);
    const second = await intake(payload);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().case.id).toBe(first.json().case.id);
  });

  it("lists cases and returns operational metrics", async () => {
    await intake({
      scenarioCode: "wismo",
      caseId: "case_refund",
      orderId: "ord_in_transit",
      idempotencyKey: "after_metrics_1",
    });
    const list = await app.inject({ method: "GET", url: "/v1/after-sales/cases?scenarioCode=wismo" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    const metrics = await app.inject({ method: "GET", url: "/v1/after-sales/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().totalCases).toBe(1);
  });

  it("does not create a second proposal when evaluation is retried", async () => {
    const created = await intake({
      scenarioCode: "refund_request",
      caseId: "case_refund",
      orderId: "ord_small",
      amount: { currency: "USD", minorUnits: 2500 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: "after_evaluate_replay_1",
    });
    const id = created.json().case.id as string;
    const first = await app.inject({ method: "POST", url: `/v1/after-sales/cases/${id}/evaluate` });
    const second = await app.inject({ method: "POST", url: `/v1/after-sales/cases/${id}/evaluate` });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().proposal.id).toBe(first.json().proposal.id);
    const proposals = await app.inject({ method: "GET", url: "/v1/proposals?caseId=case_refund" });
    expect(proposals.json().filter((p: { id: string }) => p.id === first.json().proposal.id)).toHaveLength(1);
  });

  it("returns a complete case detail envelope for operations", async () => {
    const created = await intake({
      scenarioCode: "refund_request",
      caseId: "case_refund",
      orderId: "ord_small",
      amount: { currency: "USD", minorUnits: 2500 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: "after_detail_1",
    });
    const id = created.json().case.id as string;
    await app.inject({ method: "POST", url: `/v1/after-sales/cases/${id}/evaluate` });
    const detail = await app.inject({ method: "GET", url: `/v1/after-sales/cases/${id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      case: { id, sourceCaseId: "case_refund", proposalId: expect.any(String) },
      sourceCase: { id: "case_refund" },
      customer: { id: "cus_verified" },
      proposal: { actionType: "refund" },
      audit: expect.arrayContaining([
        expect.objectContaining({ eventType: "policy_evaluated" }),
      ]),
    });
  });

  it("requires order or shipment evidence before answering WISMO", async () => {
    const created = await intake({
      scenarioCode: "wismo",
      caseId: "case_refund",
      orderId: "ord_in_transit",
      idempotencyKey: "after_wismo_missing_evidence_1",
    });
    const evaluated = await app.inject({
      method: "POST",
      url: `/v1/after-sales/cases/${created.json().case.id}/evaluate`,
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json().decision.outcome).toBe("blocked");
    expect(evaluated.json().case.status).toBe("evidence_required");
  });
});

describe("after-sales sandbox lifecycle", () => {
  it("keeps exchange fulfillment in human_handoff when approval cannot execute it", async () => {
    await app.close();
    app = await buildApp({ logger: false, env: { OSAS_EXECUTION_MODE: "sandbox" } });
    const created = await intake({
      scenarioCode: "exchange_request",
      caseId: "case_refund",
      orderId: "ord_exch_instock",
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: "after_exchange_approval_guard_1",
    });
    const caseId = created.json().case.id as string;
    const evaluated = await app.inject({ method: "POST", url: `/v1/after-sales/cases/${caseId}/evaluate` });
    expect(evaluated.json().decision.outcome).toBe("human_handoff");
    const proposalId = evaluated.json().proposal.id as string;
    const approvalId = evaluated.json().approval.id as string;

    const decided = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved", approverId: "after-sales-test" },
    });
    expect(decided.statusCode).toBe(500);
    const detail = await app.inject({ method: "GET", url: `/v1/after-sales/cases/${caseId}` });
    expect(detail.json().case.status).toBe("human_handoff");
    expect((await app.inject({ method: "GET", url: `/v1/proposals/${proposalId}` })).json().status).toBe("approved");
  });

  it("moves the vertical case to resolved after sandbox execution", async () => {
    await app.close();
    app = await buildApp({ logger: false, env: { OSAS_EXECUTION_MODE: "sandbox" } });
    const created = await intake({
      scenarioCode: "refund_request",
      caseId: "case_refund",
      orderId: "ord_small",
      amount: { currency: "USD", minorUnits: 2500 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: "after_sandbox_success_1",
    });
    const caseId = created.json().case.id as string;
    const evaluated = await app.inject({ method: "POST", url: `/v1/after-sales/cases/${caseId}/evaluate` });
    const proposalId = evaluated.json().proposal.id as string;
    const executed = await app.inject({ method: "POST", url: `/v1/proposals/${proposalId}/execute` });
    expect(executed.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/v1/after-sales/cases/${caseId}` });
    expect(detail.json().case.status).toBe("resolved");
    expect(detail.json().receipt.status).toBe("succeeded");
  });

  it("moves an uncertain sandbox result to reconciliation_required and resolves it from a provider event", async () => {
    await app.close();
    app = await buildApp({
      logger: false,
      env: { OSAS_EXECUTION_MODE: "sandbox", OSAS_PROVIDER_EVENT_KEY: "after-sales-provider-key" },
    });
    const created = await intake({
      scenarioCode: "refund_request",
      caseId: "case_refund",
      orderId: "ord_small",
      amount: { currency: "USD", minorUnits: 2500 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: "after_sandbox_uncertain_1",
    });
    const caseId = created.json().case.id as string;
    const evaluated = await app.inject({ method: "POST", url: `/v1/after-sales/cases/${caseId}/evaluate` });
    const proposalId = evaluated.json().proposal.id as string;
    const proposal = await app.inject({ method: "GET", url: `/v1/proposals/${proposalId}` });
    await app.inject({
      method: "POST",
      url: `/v1/proposals/${proposalId}/execute`,
      payload: {},
    });
    // The first execution is deterministic success; create an uncertain case
    // through the normal proposal path to prove the vertical status sync.
    const uncertain = await intake({
      scenarioCode: "refund_request",
      caseId: "case_refund",
      orderId: "ord_small",
      amount: { currency: "USD", minorUnits: 2500 },
      evidenceIds: ["ev_ord_small"],
      message: "timeout simulation",
      idempotencyKey: "after_sandbox_uncertain_2",
    });
    const uncertainCaseId = uncertain.json().case.id as string;
    const uncertainEval = await app.inject({
      method: "POST",
      url: `/v1/after-sales/cases/${uncertainCaseId}/evaluate`,
    });
    const uncertainProposalId = uncertainEval.json().proposal.id as string;
    await app.adapter.updateProposalStatus(
      { tenantId: TENANT, principal: { actorType: "system", actorId: "test", permission: "execute" } },
      uncertainProposalId,
      "approved",
      { params: { orderId: "ord_small", simulate: "timeout" } },
    );
    const uncertainExec = await app.inject({ method: "POST", url: `/v1/proposals/${uncertainProposalId}/execute` });
    expect(uncertainExec.json().proposal.status).toBe("reconciliation_required");
    const before = await app.inject({ method: "GET", url: `/v1/after-sales/cases/${uncertainCaseId}` });
    expect(before.json().case.status).toBe("reconciliation_required");
    const event = await app.inject({
      method: "POST",
      url: "/v1/provider-events",
      headers: { "x-osas-provider-key": "after-sales-provider-key" },
      payload: {
        provider: "sandbox",
        providerEventId: "after-sales-event-1",
        eventType: "refund.succeeded",
        idempotencyKey: "after_sandbox_uncertain_2",
        occurredAt: new Date().toISOString(),
        payload: { status: "succeeded" },
      },
    });
    expect(event.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/v1/after-sales/cases/${uncertainCaseId}` });
    expect(after.json().case.status).toBe("resolved");
    expect(proposal.statusCode).toBe(200);
  });
});
