import { expect, test } from "@playwright/test";
import { auditEventsForProposal, createProposal, getProposal } from "./helpers.js";

// Exchange flow (after-sales Phase 7): exchange_request is NEVER_AUTO_EXECUTE —
// the policy engine caps its decision at require_approval and executeProposal
// refuses it outright; fulfillment is human-only. In-stock (exr_instock) routes
// to the approval queue; out-of-stock (exr_oos, no inventory/price-delta
// evidence capturable) is blocked and routed to a human handoff. Neither ever
// reaches "executed".

test("exchange_request (in-stock) requires human approval and is never executed", async ({
  page,
  request,
}) => {
  const key = `e2e_exch_instock_${Date.now()}`;
  // Unique reason code so the approval card is unambiguous in the queue.
  const reasonCode = `size_exchange_${Date.now()}`;
  const proposal = await createProposal(request, {
    caseId: "case_refund",
    profile: "ecommerce",
    actionType: "exchange_request",
    reasonCode,
    params: {
      orderId: "ord_exch_instock",
      exchangeRequestId: "exr_instock",
      originalLineId: "sku_shirt_m",
      replacementSku: "sku_shirt_l",
      note: key,
    },
    // Financial actionType: an evidence reference is mandatory (§4 rule 10).
    // The demo fixtures ship no order evidence for ord_exch_instock and there
    // is no HTTP evidence-capture endpoint, so the fresh order-evidence record
    // from the seeded fixtures stands in.
    evidenceIds: ["ev_ord_small"],
    idempotencyKey: key,
  });

  const evaluated = await request.post(`/v1/proposals/${proposal.id}/evaluate`);
  expect(evaluated.ok()).toBeTruthy();
  const { proposal: decided, decision } = await evaluated.json();
  // The demo policy's exchange_request rule is require_approval, so the
  // decision lands there directly. (The engine's NEVER_AUTO_EXECUTE cap only
  // adds a reason when a tenant rule would otherwise allow auto_execute —
  // with this policy it stays invisible but still bars execution, proven
  // below by the refused approve-and-execute attempt.)
  expect(decision.decision).toBe("require_approval");
  expect(decided.status).toBe("pending_approval");

  // A pending approval exists for the proposal.
  const approvalsRes = await request.get("/v1/approvals?status=pending");
  const approvals = (await approvalsRes.json()) as { id: string; proposalId: string }[];
  const approval = approvals.find((a) => a.proposalId === proposal.id);
  expect(approval).toBeDefined();

  // Console: the approval card shows the exchange proposal, its
  // require_approval policy decision, and the human decision controls.
  await page.goto("/agent");
  const card = page.getByTestId("approval-card").filter({ hasText: reasonCode });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("status-pending")).toBeVisible();
  await expect(card.getByTestId("status-require_approval")).toBeVisible();
  await expect(card).toContainText("exchange_request");
  await expect(card.getByTestId("approve-btn")).toBeVisible();
  await expect(card.getByTestId("status-executed")).toHaveCount(0);

  // Direct execution is refused while the proposal awaits approval.
  const direct = await request.post(`/v1/proposals/${proposal.id}/execute`);
  expect(direct.status()).toBe(409);

  // Even with a human approval on record the engine fails closed:
  // executeProposal throws ACTION_NOT_EXECUTABLE for exchange_request, so the
  // decide call errors and the proposal never reaches "executed".
  const decidedRes = await request.post(`/v1/approvals/${approval!.id}/decide`, {
    data: { decision: "approved", approverId: "e2e-human", comment: "approve exchange attempt" },
  });
  expect(decidedRes.status()).toBe(500);

  const after = await getProposal(request, proposal.id);
  expect(after.status).not.toBe("executed");

  const events = await auditEventsForProposal(request, proposal.id);
  expect(events.some((e) => e.eventType === "approval_requested")).toBe(true);
  expect(
    events.some((e) => e.eventType === "approval_decided" && e.actorType === "human"),
  ).toBe(true);
  expect(events.some((e) => e.eventType === "execution_succeeded")).toBe(false);
});

test("exchange_request (out-of-stock) routes to a human handoff and is never executed", async ({
  page,
  request,
}) => {
  const key = `e2e_exch_oos_${Date.now()}`;
  const proposal = await createProposal(request, {
    caseId: "case_refund",
    profile: "ecommerce",
    actionType: "exchange_request",
    reasonCode: "color_exchange",
    params: {
      orderId: "ord_exch_oos",
      exchangeRequestId: "exr_oos",
      originalLineId: "sku_cap",
      replacementSku: "sku_cap_red",
      note: key,
    },
    amount: { currency: "USD", minorUnits: 200 },
    // Replacement SKU is out of stock (exr_oos): no inventory/price-delta
    // evidence can be captured, and a financial action without evidence is
    // blocked, never approved.
    evidenceIds: [],
    idempotencyKey: key,
  });

  const evaluated = await request.post(`/v1/proposals/${proposal.id}/evaluate`);
  expect(evaluated.ok()).toBeTruthy();
  const { proposal: decided, decision } = await evaluated.json();
  expect(decision.decision).toBe("block");
  expect(decision.reasons.map((r: { code: string }) => r.code)).toContain("INSUFFICIENT_EVIDENCE");
  expect(decided.status).toBe("policy_rejected");

  // The block escalated to a human handoff.
  const handoffsRes = await request.get("/v1/handoffs?status=open");
  const handoffs = (await handoffsRes.json()) as {
    id: string;
    proposalId?: string;
    reason: string;
  }[];
  const handoff = handoffs.find((h) => h.proposalId === proposal.id);
  expect(handoff).toBeDefined();
  expect(handoff!.reason).toBe("insufficient_evidence");

  // Console: the handoff is on the agent's desk with its controls; there is
  // no executed badge anywhere on it.
  await page.goto("/agent");
  const card = page.getByTestId("handoff-card").filter({ hasText: proposal.id });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("status-open")).toBeVisible();
  await expect(card).toContainText("insufficient_evidence");
  await expect(card.getByTestId("resolve-btn")).toBeVisible();
  await expect(card.getByTestId("status-executed")).toHaveCount(0);

  // Execution is refused (policy_rejected guard) and the status never
  // becomes "executed" — in the API or the audit stream.
  const exec = await request.post(`/v1/proposals/${proposal.id}/execute`);
  expect(exec.status()).toBe(409);
  expect((await getProposal(request, proposal.id)).status).toBe("policy_rejected");

  const events = await auditEventsForProposal(request, proposal.id);
  expect(events.some((e) => e.eventType === "handoff_created")).toBe(true);
  expect(events.some((e) => e.eventType.startsWith("execution_"))).toBe(false);
});
