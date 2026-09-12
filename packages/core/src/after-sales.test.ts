import { describe, expect, it } from "vitest";
import * as core from "./index.js";

const TOP_10 = [
  "wismo",
  "delivery_delay",
  "not_received",
  "damaged_item",
  "wrong_or_missing_item",
  "refund_request",
  "refund_pending",
  "return_request",
  "reshipment_request",
  "exchange_request",
] as const;

describe("Top 10 after-sales domain contract", () => {
  it("publishes the canonical scenario codes", () => {
    expect((core as Record<string, unknown>).AFTER_SALES_SCENARIOS).toEqual(TOP_10);
  });

  it("publishes the v0.3 draft case statuses and risk levels", () => {
    expect((core as Record<string, unknown>).AFTER_SALES_CASE_STATUSES).toEqual([
      "intake",
      "evidence_required",
      "evaluated",
      "pending_approval",
      "human_handoff",
      "executing",
      "resolved",
      "reconciliation_required",
      "blocked",
    ]);
    expect((core as Record<string, unknown>).AFTER_SALES_RISK_LEVELS).toEqual([
      "low",
      "medium",
      "high",
      "critical",
    ]);
  });
});
