import { describe, expect, it } from "vitest";
import { AFTER_SALES_SCENARIOS, statusTone } from "./pages/AfterSales";

describe("after-sales operations console contracts", () => {
  it("exposes all ten canonical scenarios", () => {
    expect(AFTER_SALES_SCENARIOS).toHaveLength(10);
    expect(AFTER_SALES_SCENARIOS).toContain("exchange_request");
  });

  it("uses a warning tone for cases waiting on approval or reconciliation", () => {
    expect(statusTone("pending_approval")).toBe("warn");
    expect(statusTone("reconciliation_required")).toBe("warn");
    expect(statusTone("resolved")).toBe("ok");
  });
});
