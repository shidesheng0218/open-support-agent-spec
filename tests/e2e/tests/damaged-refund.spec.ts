import { expect, test } from "@playwright/test";
import { auditEventsForProposal, createProposal, getProposal } from "./helpers.js";

// Damaged-item refund (after-sales Phase 7): ord_damaged (Glass Vase, $35) with
// image evidence ev_damaged_photo1/2. The proposal would auto-execute under the
// demo policy, but in Shadow Mode it is simulated (ShadowRun), a human records
// the final outcome, and the audit chain keeps the full trail. Nothing is ever
// executed — the execute route refuses proposals under shadow review.

test("damaged item refund: proposal -> shadow run -> human review -> audit trail", async ({
  page,
  request,
}) => {
  const key = `e2e_damaged_${Date.now()}`;
  const proposal = await createProposal(request, {
    caseId: "case_refund",
    profile: "ecommerce",
    actionType: "refund",
    reasonCode: "damaged",
    params: { orderId: "ord_damaged" },
    amount: { currency: "USD", minorUnits: 3500 },
    evidenceIds: ["ev_damaged_photo1", "ev_damaged_photo2"],
    idempotencyKey: key,
  });

  // Read-back: the shadow-run response embeds the referenced evidence — the
  // two customer photos filed against ord_damaged.
  const created = await request.post(`/v1/proposals/${proposal.id}/shadow-run`);
  expect(created.status()).toBe(201);
  const { shadowRun, evidence } = await created.json();
  expect(shadowRun.wouldAutoExecute).toBe(true);
  expect(shadowRun.humanOutcome).toBe("pending");
  expect(evidence).toHaveLength(2);
  for (const ev of evidence) {
    expect(ev.data.orderId).toBe("ord_damaged");
    expect(ev.data.mediaType).toBe("image/jpeg");
  }

  // Console: policy decision + suggested action shown on the Shadow page.
  await page.goto("/shadow");
  await expect(page.getByTestId("shadow-mode-banner")).toBeVisible();
  const card = page.getByTestId("shadow-run-card").filter({ hasText: shadowRun.id });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("would-auto-execute")).toBeVisible();
  await expect(card.getByTestId("status-auto_execute")).toBeVisible();
  await expect(card).toContainText("No policy violations");
  // Both damage photos are linked from the card.
  await expect(card.getByTestId("evidence-link")).toHaveCount(2);
  await expect(card).toContainText("ord_damaged");
  // The proposal itself stays in "proposed" (shadow is record-only).
  await expect(card.getByTestId("status-proposed")).toBeVisible();

  // Human approval step: review controls are the only action surface.
  await card.getByTestId("shadow-comment").fill("E2E: photos confirm the vase arrived cracked");
  await card.getByTestId("shadow-reference").fill("zd-ticket-damaged-e2e");
  await card.getByTestId("shadow-accept-btn").click();

  const reviewed = page.getByTestId("shadow-run-card").filter({ hasText: shadowRun.id });
  await expect(reviewed.getByTestId("status-accepted")).toBeVisible();
  await expect(reviewed).toContainText("zd-ticket-damaged-e2e");
  await expect(reviewed.getByTestId("shadow-accept-btn")).toHaveCount(0);

  // Audit chain verifies intact after the shadow operations.
  await expect(page.getByTestId("audit-chain-intact")).toBeVisible();

  // The full trail is visible in the Platform audit viewer for this proposal.
  await page.goto("/platform");
  await page.getByTestId("audit-proposal-filter").fill(proposal.id);
  await page.getByTestId("audit-load").click();
  const rows = page.getByTestId("audit-row");
  await expect(rows).toHaveCount(3);
  await expect(rows).toContainText(["proposal_created", "shadow_run_created", "shadow_run_reviewed"]);

  // API: the proposal was never executed, and the execute route refuses it
  // (Shadow Mode: the human outcome is the final record).
  const exec = await request.post(`/v1/proposals/${proposal.id}/execute`);
  expect(exec.status()).toBe(409);
  expect((await getProposal(request, proposal.id)).status).toBe("proposed");

  const events = await auditEventsForProposal(request, proposal.id);
  expect(events.map((e) => e.eventType)).toEqual([
    "proposal_created",
    "shadow_run_created",
    "shadow_run_reviewed",
  ]);
  expect(events.find((e) => e.eventType === "shadow_run_reviewed")?.actorType).toBe("human");
  expect(events.some((e) => e.eventType.startsWith("execution_"))).toBe(false);
});
