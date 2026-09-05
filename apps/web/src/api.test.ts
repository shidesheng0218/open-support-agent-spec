import { describe, expect, it } from "vitest";
import { ApiError, isCompatReportNotGenerated } from "./api";

describe("isCompatReportNotGenerated", () => {
  it("matches the structured COMPAT_REPORT_NOT_GENERATED error", () => {
    const err = new ApiError(404, "COMPAT_REPORT_NOT_GENERATED", "No compat report has been generated yet.");
    expect(isCompatReportNotGenerated(err)).toBe(true);
  });

  it("does not match a generic 404 or other errors", () => {
    expect(isCompatReportNotGenerated(new ApiError(404, "NOT_FOUND", "Route not found"))).toBe(false);
    expect(isCompatReportNotGenerated(new ApiError(500, "INTERNAL_ERROR", "boom"))).toBe(false);
    expect(isCompatReportNotGenerated(new ApiError(0, "NETWORK_ERROR", "offline"))).toBe(false);
    expect(isCompatReportNotGenerated(new Error("plain"))).toBe(false);
    expect(isCompatReportNotGenerated(undefined)).toBe(false);
  });
});
