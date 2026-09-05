import { expect, test } from "@playwright/test";

// Smoke: assumes the full stack is up (docker compose: web on baseURL, api on :3001).
// Selectors rely on data-testid attributes rendered by apps/web.

test("console loads with nav and health badge", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByTestId("nav");
  await expect(nav).toBeVisible();
  for (const label of ["Overview", "Developer", "Agent", "Platform", "Demo"]) {
    await expect(nav.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("status-ok")).toBeVisible();
});

test("developer page lists all 16 MCP tools", async ({ page }) => {
  await page.goto("/developer");
  await expect(page.getByTestId("tool-row")).toHaveCount(16);
  // expand one row to inspect its input schema
  await page.getByTestId("tool-row").first().click();
  await expect(page.locator("pre.json")).toBeVisible();
});

test("demo scenario 1 auto-executes the refund", async ({ page }) => {
  await page.goto("/demo");
  const card = page.getByTestId("scenario-refund-auto");
  await expect(card).toBeVisible();
  await card.getByTestId("run-refund-auto").click();
  // proposal reaches terminal executed status via policy auto_execute
  await expect(card.getByTestId("status-executed")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("timeline-refund-auto")).toContainText("Execution");
});
