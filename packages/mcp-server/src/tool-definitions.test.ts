import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "./tool-definitions.js";

const EXPECTED_NAMES = [
  "osas_core_get_case",
  "osas_core_search_cases",
  "osas_core_get_customer",
  "osas_core_search_knowledge",
  "osas_core_create_case_note",
  "osas_core_create_escalation",
  "osas_core_create_action_proposal",
  "osas_ecom_get_order",
  "osas_ecom_list_orders",
  "osas_ecom_get_shipment",
  "osas_ecom_get_shipment_incident",
  "osas_ecom_get_refund_status",
  "osas_ecom_create_item_claim_request",
  "osas_ecom_create_exchange_request",
  "osas_saas_get_subscription",
  "osas_saas_list_invoices",
  "osas_saas_get_credit_balance",
  "osas_saas_create_credit_request",
  "osas_saas_create_cancellation_request",
  "osas_saas_create_plan_change_request",
];

describe("TOOL_DEFINITIONS", () => {
  it("has exactly the 20 contract tool names (§7)", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(20);
    expect(TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it("names are unique and osas_-prefixed", () => {
    const names = TOOL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^osas_(core|ecom|saas)_/);
  });

  it("every entry has profile, description, object inputSchema, adapterMethod, permissionRequired", () => {
    for (const d of TOOL_DEFINITIONS) {
      expect(["core", "ecommerce", "saas"]).toContain(d.profile);
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.inputSchema.type).toBe("object");
      expect(d.inputSchema.additionalProperties).toBe(false);
      expect(typeof d.adapterMethod).toBe("string");
      expect(["read", "draft", "request-approval", "execute"]).toContain(d.permissionRequired);
    }
  });

  it("never exposes executeAction as a tool", () => {
    expect(TOOL_DEFINITIONS.some((d) => d.adapterMethod === "executeAction")).toBe(false);
  });

  it("proposal shortcuts route through createActionProposal", () => {
    for (const name of [
      "osas_core_create_action_proposal",
      "osas_saas_create_credit_request",
      "osas_saas_create_cancellation_request",
      "osas_saas_create_plan_change_request",
      "osas_ecom_create_exchange_request",
    ]) {
      const def = TOOL_DEFINITIONS.find((d) => d.name === name);
      expect(def?.adapterMethod).toBe("createActionProposal");
      expect(def?.permissionRequired).toBe("request-approval");
    }
  });

  it("the item-claim shortcut records a draft-level claim, never an executable proposal", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "osas_ecom_create_item_claim_request");
    expect(def?.adapterMethod).toBe("proposeItemClaim");
    expect(def?.permissionRequired).toBe("draft");
    expect(def?.capabilityRequired).toBe("ecommerce.item_claim.propose");
  });

  it("read tools require only read permission", () => {
    const reads = TOOL_DEFINITIONS.filter((d) =>
      ["getCase", "searchCases", "getCustomer", "searchKnowledge", "getOrder", "listOrders", "getShipment", "getShipmentIncident", "getRefundStatus", "getSubscription", "listInvoices", "getCreditBalance"].includes(
        d.adapterMethod,
      ),
    );
    expect(reads).toHaveLength(12);
    for (const d of reads) expect(d.permissionRequired).toBe("read");
  });
});
