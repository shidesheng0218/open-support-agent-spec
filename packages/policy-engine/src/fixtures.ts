import type {
  ActionProposal,
  Customer,
  Evidence,
  TenantPolicy,
} from "@osas/core";

/** Shared test fixtures (CONTRACTS.md §11 demo data). Not a test file. */

export const FIXTURE_NOW = new Date("2026-09-05T12:00:00.000Z");

export const daysAgo = (d: number): string =>
  new Date(FIXTURE_NOW.getTime() - d * 86400_000).toISOString();

export function makePolicy(): TenantPolicy {
  return {
    id: "pol_demo",
    specVersion: "0.1",
    tenantId: "tenant_demo",
    version: "1.0.0",
    effectiveFrom: daysAgo(30),
    duplicateWindowSeconds: 86400,
    maxEvidenceAgeSeconds: 604800,
    rules: [
      {
        actionType: "refund",
        decision: "auto_execute",
        maxAmount: { currency: "USD", minorUnits: 5000 },
        reasonCodes: ["damaged", "wrong_item", "not_received", "other"],
        requireVerifiedIdentity: true,
        identityMaxAgeSeconds: 7776000,
        allowedRegions: ["US", "CA", "GB", "DE", "FR", "JP", "AU"],
        blockedRegions: ["IR", "KP", "CU"],
      },
      {
        actionType: "reshipment",
        decision: "auto_execute",
        maxAmount: { currency: "USD", minorUnits: 3000 },
        requireVerifiedIdentity: true,
      },
      { actionType: "return_request", decision: "require_approval" },
      { actionType: "cancel_order", decision: "require_approval" },
      {
        actionType: "credit_apply",
        decision: "require_approval",
        maxAmount: { currency: "USD", minorUnits: 10000 },
        reasonCodes: ["service_outage", "goodwill", "billing_error"],
      },
      { actionType: "subscription_cancel", decision: "require_approval" },
      { actionType: "plan_change", decision: "require_approval" },
      { actionType: "create_note", decision: "auto_execute" },
      { actionType: "create_escalation", decision: "auto_execute" },
    ],
    defaultDecision: "block",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(30),
  };
}

export function makeCustomer(over: Partial<Customer> = {}): Customer {
  return {
    id: "cus_verified",
    specVersion: "0.1",
    tenantId: "tenant_demo",
    displayName: "Verified Customer",
    region: "US",
    identityVerification: {
      status: "verified",
      method: "doc",
      verifiedAt: daysAgo(30),
    },
    tags: [],
    createdAt: daysAgo(60),
    updatedAt: daysAgo(60),
    ...over,
  };
}

export function makeEvidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: "ev_order",
    specVersion: "0.1",
    tenantId: "tenant_demo",
    caseId: "case_refund",
    kind: "order",
    source: { system: "shopify", recordType: "order", recordId: "ord_small" },
    summary: "ord_small delivered, $25.00 USD",
    data: {},
    retrievedAt: daysAgo(1),
    createdAt: daysAgo(1),
    ...over,
  };
}

export function makeProposal(
  over: Partial<ActionProposal> = {},
): ActionProposal {
  return {
    id: "prop_1",
    specVersion: "0.1",
    tenantId: "tenant_demo",
    caseId: "case_refund",
    profile: "ecommerce",
    actionType: "refund",
    reasonCode: "damaged",
    params: { orderId: "ord_small", reason: "damaged" },
    requestedPermission: "request-approval",
    requestedBy: { actorType: "model", actorId: "mock-local" },
    amount: { currency: "USD", minorUnits: 2500 },
    evidenceIds: ["ev_order"],
    idempotencyKey: "idem_1",
    status: "proposed",
    createdAt: FIXTURE_NOW.toISOString(),
    updatedAt: FIXTURE_NOW.toISOString(),
    ...over,
  };
}
