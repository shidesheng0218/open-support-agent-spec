import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENT_TYPES,
  CAPABILITIES,
  EXECUTION_MODES,
  EXCHANGE_REQUEST_STATUSES,
  ITEM_CLAIM_STATUSES,
  POLICY_VERSION_STATUSES,
  REFUND_TRANSACTION_STATUSES,
  SHIPMENT_INCIDENT_STATUSES,
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
  it("defines the 20 spec capabilities", () => {
    expect(CAPABILITIES).toHaveLength(20);
    expect(new Set(CAPABILITIES).size).toBe(20);
    expect(CAPABILITIES).toContain("ecommerce.refund.execute");
    expect(CAPABILITIES).toContain("saas.credit.propose");
  });

  it("includes the four after-sales capabilities", () => {
    expect(CAPABILITIES).toContain("ecommerce.shipment_incident.read");
    expect(CAPABILITIES).toContain("ecommerce.refund_status.read");
    expect(CAPABILITIES).toContain("ecommerce.item_claim.propose");
    expect(CAPABILITIES).toContain("ecommerce.exchange.propose");
  });

  it("defines the after-sales status enums", () => {
    expect(SHIPMENT_INCIDENT_STATUSES).toEqual(["open", "investigating", "resolved", "closed"]);
    expect(REFUND_TRANSACTION_STATUSES).toEqual([
      "requested",
      "processing",
      "succeeded",
      "failed",
      "reversed",
    ]);
    expect(ITEM_CLAIM_STATUSES).toEqual([
      "submitted",
      "under_review",
      "approved",
      "rejected",
      "resolved",
    ]);
    expect(EXCHANGE_REQUEST_STATUSES).toEqual([
      "proposed",
      "pending_approval",
      "approved",
      "rejected",
      "fulfilled",
      "cancelled",
    ]);
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
