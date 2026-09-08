import { describe, expect, it } from "vitest";
import {
  ACTION_TYPES,
  ACTION_TYPE_PROFILE,
  CORE_ACTION_TYPES,
  ECOMMERCE_ACTION_TYPES,
  FINANCIAL_ACTION_TYPES,
  NEVER_AUTO_EXECUTE_ACTION_TYPES,
  PROFILES,
  SAAS_ACTION_TYPES,
  SPEC_VERSION,
} from "./index.js";

describe("action type registry", () => {
  it("ACTION_TYPES is the union of the per-profile lists", () => {
    expect(ACTION_TYPES).toEqual([
      ...CORE_ACTION_TYPES,
      ...ECOMMERCE_ACTION_TYPES,
      ...SAAS_ACTION_TYPES,
    ]);
  });

  it("every actionType maps to a valid profile", () => {
    for (const t of ACTION_TYPES) {
      expect(PROFILES).toContain(ACTION_TYPE_PROFILE[t]);
    }
    expect(Object.keys(ACTION_TYPE_PROFILE).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it("per-profile lists map to their own profile", () => {
    for (const t of CORE_ACTION_TYPES) expect(ACTION_TYPE_PROFILE[t]).toBe("core");
    for (const t of ECOMMERCE_ACTION_TYPES) expect(ACTION_TYPE_PROFILE[t]).toBe("ecommerce");
    for (const t of SAAS_ACTION_TYPES) expect(ACTION_TYPE_PROFILE[t]).toBe("saas");
  });

  it("financial action types are a subset of all action types", () => {
    for (const t of FINANCIAL_ACTION_TYPES) {
      expect(ACTION_TYPES).toContain(t);
    }
    expect(FINANCIAL_ACTION_TYPES).toEqual([
      "refund",
      "reshipment",
      "credit_apply",
      "exchange_request",
    ]);
  });

  it("exchange_request is an ecommerce action type and never auto-executable", () => {
    expect(ECOMMERCE_ACTION_TYPES).toContain("exchange_request");
    expect(ACTION_TYPE_PROFILE.exchange_request).toBe("ecommerce");
    expect(NEVER_AUTO_EXECUTE_ACTION_TYPES).toContain("exchange_request");
    // Only exchange_request is model-execution-forbidden today.
    expect(NEVER_AUTO_EXECUTE_ACTION_TYPES).toEqual(["exchange_request"]);
  });

  it("SPEC_VERSION is 0.1", () => {
    expect(SPEC_VERSION).toBe("0.2");
  });
});
