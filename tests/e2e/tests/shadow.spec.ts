import { expect, test, type APIRequestContext } from "@playwright/test";

// Shadow Mode E2E (Milestone 3): assumes the full stack is up (docker compose,
// or local API on :3001 + web dev server proxying /v1). Creates a refund
// proposal + ShadowRun through the API, then reviews it in the console.

async function createProposal(request: APIRequestContext, key: string): Promise<{ id: string }> {
  const res = await request.post("/v1/proposals", {
    data: {
      caseId: "case_refund",
      profile: "ecommerce",
      actionType: "refund",
      reasonCode: "damaged",
      params: { orderId: "ord_small" },
      requestedPermission: "request-approval",
      requestedBy: { actorType: "model", actorId: "mock-local" },
      amount: { currency: "USD", minorUnits: 2500 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: key,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test("shadow run creation + human review + audit verification, no live-execute UI", async ({
  page,
  request,
}) => {
  const key = `e2e_shadow_${Date.now()}`;
  const proposal = await createProposal(request, key);
  const created = await request.post(`/v1/proposals/${proposal.id}/shadow-run`);
  expect(created.status()).toBe(201);
  const { shadowRun } = await created.json();
  expect(shadowRun.wouldAutoExecute).toBe(true);
  expect(shadowRun.humanOutcome).toBe("pending");

  await page.goto("/shadow");
  await expect(page.getByTestId("shadow-mode-banner")).toBeVisible();

  const card = page
    .getByTestId("shadow-run-card")
    .filter({ hasText: shadowRun.id });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("would-auto-execute")).toBeVisible();
  await expect(card.getByTestId("evidence-link").first()).toBeVisible();

  // No live-execute affordance anywhere on the Shadow page.
  await expect(page.getByRole("button", { name: /execute/i })).toHaveCount(0);
  await expect(page.getByTestId("shadow-page")).not.toContainText(/execute now/i);

  // Human review: accept with a comment + external reference.
  await card.getByTestId("shadow-comment").fill("E2E human review");
  await card.getByTestId("shadow-reference").fill("zd-ticket-e2e");
  await card.getByTestId("shadow-accept-btn").click();

  const reviewedCard = page
    .getByTestId("shadow-run-card")
    .filter({ hasText: shadowRun.id });
  await expect(reviewedCard.getByTestId("status-accepted")).toBeVisible();
  await expect(reviewedCard).toContainText("E2E human review");
  await expect(reviewedCard).toContainText("zd-ticket-e2e");
  // Reviewed runs no longer offer review controls.
  await expect(reviewedCard.getByTestId("shadow-accept-btn")).toHaveCount(0);

  // Audit hash chain verifies intact after the shadow operations.
  await expect(page.getByTestId("audit-chain-intact")).toBeVisible();

  // The proposal was never executed (Shadow Mode is record-only).
  const after = await request.get(`/v1/proposals/${proposal.id}`);
  expect((await after.json()).status).toBe("proposed");

  // The review landed on the audit stream as a human decision.
  const audit = await request.get(`/v1/audit?proposalId=${proposal.id}`);
  const events = (await audit.json()) as { eventType: string; actorType: string }[];
  expect(events.some((e) => e.eventType === "shadow_run_created")).toBe(true);
  expect(
    events.some((e) => e.eventType === "shadow_run_reviewed" && e.actorType === "human"),
  ).toBe(true);
});

test("policy-blocked shadow runs show no-auto-execute and their policy reasons", async ({
  page,
  request,
}) => {
  // Over-threshold refund ($999 > $50 rule cap) can never auto-execute.
  const res = await request.post("/v1/proposals", {
    data: {
      caseId: "case_refund",
      profile: "ecommerce",
      actionType: "refund",
      reasonCode: "damaged",
      params: { orderId: "ord_small" },
      requestedPermission: "request-approval",
      requestedBy: { actorType: "model", actorId: "mock-local" },
      amount: { currency: "USD", minorUnits: 99900 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: `e2e_shadow_block_${Date.now()}`,
    },
  });
  const proposal = await res.json();
  const created = await request.post(`/v1/proposals/${proposal.id}/shadow-run`);
  const { shadowRun } = await created.json();
  expect(shadowRun.wouldAutoExecute).toBe(false);

  await page.goto("/shadow");
  const card = page.getByTestId("shadow-run-card").filter({ hasText: shadowRun.id });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("no-auto-execute")).toBeVisible();
  await expect(card).toContainText("OVER_THRESHOLD");
});
