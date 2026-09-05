import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENT_TYPES,
  CAPABILITIES,
  EXECUTION_MODES,
  POLICY_VERSION_STATUSES,
  TRANSPORTS,
  canTransitionPolicyVersion,
} from "./index.js";

describe("policy version lifecycle (v0.1.1)", () => {
  it("models draft -> simulated -> approved -> active -> retired", () => {
    expect(canTransitionPolicyVersion("draft", "simulated")).toBe(true);
    expect(canTransitionPolicyVersion("simulated", "approved")).toBe(true);
    expect(canTransitionPolicyVersion("approved", "active")).toBe(true);
    expect(canTransitionPolicyVersion("active", "retired")).toBe(true);
    expect(canTransitionPolicyVersion("approved", "retired")).toBe(true);
  });

  it("rejects skipping simulation/approval and mutating retired versions", () => {
    expect(canTransitionPolicyVersion("draft", "approved")).toBe(false);
    expect(canTransitionPolicyVersion("draft", "active")).toBe(false);
    expect(canTransitionPolicyVersion("simulated", "active")).toBe(false);
    expect(canTransitionPolicyVersion("active", "active")).toBe(false);
    expect(canTransitionPolicyVersion("retired", "draft")).toBe(false);
    for (const s of POLICY_VERSION_STATUSES) {
      expect(canTransitionPolicyVersion("retired", s)).toBe(false);
    }
  });
});

describe("capability manifest enums (v0.1.1)", () => {
  it("defines the 16 spec capabilities", () => {
    expect(CAPABILITIES).toHaveLength(16);
    expect(new Set(CAPABILITIES).size).toBe(16);
    expect(CAPABILITIES).toContain("ecommerce.refund.execute");
    expect(CAPABILITIES).toContain("saas.credit.propose");
  });

  it("defines transports and execution modes", () => {
    expect(TRANSPORTS).toEqual(["http", "mcp"]);
    expect(EXECUTION_MODES).toEqual(["proposal_only", "shadow", "live"]);
  });

  it("extends audit event types with policy lifecycle events", () => {
    for (const t of [
      "policy_draft_created",
      "policy_simulated",
      "policy_approved",
      "policy_activated",
      "policy_retired",
    ]) {
      expect(AUDIT_EVENT_TYPES).toContain(t);
    }
  });
});
