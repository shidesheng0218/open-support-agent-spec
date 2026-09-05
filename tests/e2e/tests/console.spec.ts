import { expect, test } from "@playwright/test";

// Smoke: assumes the full stack is up (docker compose: web on baseURL, api on :3001).
// Selectors rely on data-testid attributes rendered by apps/web.

test("console loads with nav and health badge", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByTestId("nav");
  await expect(nav).toBeVisible();
  const routes = [
    ["Overview", "/"],
    ["Developer", "/developer"],
    ["Agent", "/agent"],
    ["Platform", "/platform"],
    ["Demo", "/demo"],
  ] as const;
  for (const [label, href] of routes) {
    const link = nav.getByRole("link", { name: new RegExp(`^${label}`) });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", href);
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

test("platform page renders the compat report generated at image build", async ({ page }) => {
  await page.goto("/platform");
  // The API image generates tests/compat/report/latest.json during docker build,
  // so the console must show the suite table — never the "not generated" hint.
  await expect(page.getByTestId("compat-table")).toBeVisible();
  await expect(page.getByTestId("compat-suite-row").first()).toBeVisible();
  await expect(page.getByTestId("compat-empty")).toHaveCount(0);
});

test("demo scenario 1 auto-executes the refund", async ({ page }) => {
  await page.goto("/demo");
  const card = page.getByTestId("scenario-refund-auto");
  await expect(card).toBeVisible();
  await card.getByTestId("run-refund-auto").click();
  // proposal reaches terminal executed status via policy auto_execute
  await expect(
    card.getByTestId("scenario-status-refund-auto").getByTestId("status-executed"),
  ).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("timeline-refund-auto")).toContainText("Execution");
});
