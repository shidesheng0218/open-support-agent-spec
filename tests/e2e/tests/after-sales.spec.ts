import { expect, test } from "@playwright/test";

test("after-sales console shows a resolved WISMO case and its operations envelope", async ({
  page,
  request,
}) => {
  const key = `e2e_after_sales_wismo_${Date.now()}`;
  const intake = await request.post("/v1/after-sales/intake", {
    data: {
      scenarioCode: "wismo",
      caseId: "case_refund",
      orderId: "ord_in_transit",
      evidenceIds: ["ev_ord_small"],
      message: "Where is my order?",
      idempotencyKey: key,
    },
  });
  expect(intake.status()).toBe(201);
  const { case: afterSalesCase } = await intake.json();

  const evaluated = await request.post(`/v1/after-sales/cases/${afterSalesCase.id}/evaluate`);
  expect(evaluated.ok()).toBeTruthy();
  expect((await evaluated.json()).decision.outcome).toBe("answer_only");

  await page.goto("/after-sales");
  await expect(page.getByTestId("after-sales-page")).toBeVisible();
  const detail = page.getByTestId("after-sales-detail");
  await expect(detail).toContainText("订单/物流进度");
  await expect(detail).toContainText("resolved");
  await expect(detail).toContainText("Audit trail");
});

test("after-sales console approves an over-threshold refund through the sandbox", async ({
  page,
  request,
}) => {
  const key = `e2e_after_sales_refund_${Date.now()}`;
  const intake = await request.post("/v1/after-sales/intake", {
    data: {
      scenarioCode: "refund_request",
      caseId: "case_refund",
      orderId: "ord_large",
      amount: { currency: "USD", minorUnits: 7500 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: key,
    },
  });
  expect(intake.status()).toBe(201);
  const { case: afterSalesCase } = await intake.json();
  const evaluated = await request.post(`/v1/after-sales/cases/${afterSalesCase.id}/evaluate`);
  expect(evaluated.ok()).toBeTruthy();
  expect((await evaluated.json()).decision.outcome).toBe("approval_required");

  await page.goto("/after-sales");
  const detail = page.getByTestId("after-sales-detail");
  // The queue contains cases created by other E2E workers. Select the case
  // created by this test instead of relying on the queue's first row.
  await page
    .locator("button.after-sales-row")
    .filter({ hasText: afterSalesCase.id.slice(0, 18) })
    .click();
  await expect(page.getByTestId("after-sales-approval-center")).toBeVisible();
  await page.getByTestId("after-sales-approval-center").getByRole("button", { name: "Approve" }).click();
  await expect(detail).toContainText("resolved");
  await expect(detail.getByTestId("after-sales-approval-center")).toHaveCount(0);
});
