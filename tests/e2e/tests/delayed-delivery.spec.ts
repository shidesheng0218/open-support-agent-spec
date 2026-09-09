import { expect, test } from "@playwright/test";
import { auditEventsForProposal, createProposal, getProposal } from "./helpers.js";

// Delayed delivery (after-sales Phase 7): ord_delayed / shipment shp_delayed is
// past its ETA with carrier incident inc_delayed open. The only automated
// outcome is an internal escalation (create_escalation auto-executes under the
// demo policy) — never a refund or reshipment.

test("delayed delivery: escalation only, no refund/reshipment execution", async ({
  page,
  request,
}) => {
  const key = `e2e_delayed_${Date.now()}`;

  // The console's read surface for the delay context: the Developer page lists
  // the shipment / shipment-incident read tools the agent uses to recognize it.
  await page.goto("/developer");
  await expect(
    page.getByTestId("tool-row").filter({ has: page.getByText("osas_ecom_get_shipment", { exact: true }) }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("tool-row")
      .filter({ has: page.getByText("osas_ecom_get_shipment_incident", { exact: true }) }),
  ).toBeVisible();

  // The recognized delay is recorded as an escalation referencing the delayed
  // order, its shipment, and the open carrier incident. create_escalation is
  // auto-executable (internal, non-financial); the unique note keeps the
  // params distinct so re-runs never trip the duplicate-request guard.
  const proposal = await createProposal(request, {
    caseId: "case_refund",
    profile: "core",
    actionType: "create_escalation",
    reasonCode: "delivery_delay",
    params: {
      orderId: "ord_delayed",
      shipmentId: "shp_delayed",
      incidentId: "inc_delayed",
      reason: `ord_delayed (shp_delayed) is past ETA; carrier incident inc_delayed open (${key})`,
    },
    evidenceIds: [],
    idempotencyKey: key,
  });

  const evaluated = await request.post(`/v1/proposals/${proposal.id}/evaluate`);
  expect(evaluated.ok()).toBeTruthy();
  const { proposal: decided, decision } = await evaluated.json();
  expect(decision.decision).toBe("auto_execute");
  expect(decided.status).toBe("approved");

  const executed = await request.post(`/v1/proposals/${proposal.id}/execute`);
  expect(executed.ok()).toBeTruthy();
  const { proposal: terminal, execution } = await executed.json();
  expect(execution.status).toBe("succeeded");
  // The mock backend records an internal Escalation and returns its id.
  expect(execution.externalRef).toMatch(/^esc_/);
  expect(terminal.status).toBe("executed");

  // The delay context travelled with the executed escalation.
  const stored = await getProposal(request, proposal.id);
  expect(stored.status).toBe("executed");
  expect(stored.params.incidentId).toBe("inc_delayed");
  expect(stored.params.shipmentId).toBe("shp_delayed");

  // Audit trail for the escalation is visible in the Platform audit viewer.
  await page.goto("/platform");
  await page.getByTestId("audit-proposal-filter").fill(proposal.id);
  await page.getByTestId("audit-load").click();
  const rows = page.getByTestId("audit-row");
  await expect(rows).toHaveCount(5);
  await expect(rows).toContainText([
    "proposal_created",
    "policy_evaluated",
    "execution_attempt_created",
    "execution_started",
    "execution_succeeded",
  ]);

  // No refund or reshipment was proposed or executed for the delayed order —
  // anywhere. Scope the check to proposals referencing ord_delayed so other
  // specs' fixtures on the shared case cannot pollute the assertion.
  const forCase = await request.get("/v1/proposals?caseId=case_refund");
  const proposals = (await forCase.json()) as {
    actionType: string;
    status: string;
    params: Record<string, unknown>;
  }[];
  const forDelayedOrder = proposals.filter((p) => p.params?.orderId === "ord_delayed");
  expect(forDelayedOrder.length).toBeGreaterThan(0);
  expect(
    forDelayedOrder.every((p) => p.actionType === "create_escalation" || p.actionType === "create_note"),
  ).toBe(true);

  const events = await auditEventsForProposal(request, proposal.id);
  expect(events.map((e) => e.eventType)).toEqual([
    "proposal_created",
    "policy_evaluated",
    "execution_attempt_created",
    "execution_started",
    "execution_succeeded",
  ]);
  // The only succeeded execution in this flow is the escalation itself.
  const succeeded = events.filter((e) => e.eventType === "execution_succeeded");
  expect(succeeded).toHaveLength(1);
  expect(String(succeeded[0]?.detail?.externalRef)).toMatch(/^esc_/);

  const verify = await request.get("/v1/audit/verify");
  expect((await verify.json()).intact).toBe(true);
});
