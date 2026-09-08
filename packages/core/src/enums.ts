/**
 * OSAS v0.2 enums, constants, permission ladder, and state machines
 * (CONTRACTS.md §2, §3).
 */
import { nowIso } from "./ids.js";
import type {
  ActionProposal,
  ActionType,
  ApprovalStatus,
  AuditActorType,
  AuditEventType,
  Capability,
  Case,
  CaseChannel,
  CasePriority,
  CaseStatus,
  AssigneeType,
  CoreActionType,
  EcommerceActionType,
  EvidenceKind,
  ExchangeInventoryStatus,
  ExchangeRequestStatus,
  ExecutionMode,
  ExecutionStatus,
  HandoffReason,
  HandoffStatus,
  InvoiceStatus,
  ItemClaimStatus,
  ItemClaimType,
  ModelTier,
  OrderStatus,
  Permission,
  PolicyDecisionValue,
  PolicyVersionStatus,
  Profile,
  ProposalStatus,
  RefundTransactionStatus,
  SaasActionType,
  ShadowRunOutcome,
  ShipmentIncidentStatus,
  ShipmentIncidentType,
  ShipmentStatus,
  SubscriptionStatus,
  Transport,
} from "./types.js";

export const SPEC_VERSION = "0.2" as const;

/* ---------------- Profiles ---------------- */

export const PROFILES: readonly Profile[] = ["core", "ecommerce", "saas"];
/** Alias kept for contract wording (`PROFILE` list). */
export const PROFILE = PROFILES;

/* ---------------- Permission ladder (§3) ---------------- */

export const PERMISSIONS: readonly Permission[] = ["read", "draft", "request-approval", "execute"];

export function permissionAtLeast(a: Permission, b: Permission): boolean {
  return PERMISSIONS.indexOf(a) >= PERMISSIONS.indexOf(b);
}

/* ---------------- Status enums ---------------- */

export const CASE_STATUSES: readonly CaseStatus[] = [
  "open",
  "pending_agent",
  "pending_customer",
  "resolved",
  "closed",
];
export const CASE_CHANNELS: readonly CaseChannel[] = ["email", "chat", "phone", "social", "api"];
export const CASE_PRIORITIES: readonly CasePriority[] = ["low", "normal", "high", "urgent"];
export const ASSIGNEE_TYPES: readonly AssigneeType[] = ["agent", "human", "none"];

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  "proposed",
  "policy_rejected",
  "pending_approval",
  "approved",
  "rejected",
  "executing",
  "executed",
  "failed",
  "reconciliation_required",
];

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ["pending", "approved", "rejected"];

export const POLICY_DECISIONS: readonly PolicyDecisionValue[] = [
  "auto_execute",
  "require_approval",
  "block",
];

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "order",
  "shipment",
  "subscription",
  "invoice",
  "knowledge",
  "conversation",
  "policy",
  "identity",
  "other",
];

export const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  "proposal_created",
  "proposal_validated",
  "proposal_validation_failed",
  "policy_evaluated",
  "approval_requested",
  "approval_decided",
  "execution_started",
  "execution_succeeded",
  "execution_failed",
  "execution_uncertain",
  "reconciliation_opened",
  "reconciliation_resolved",
  "handoff_created",
  "handoff_resolved",
  "prompt_injection_blocked",
  "permission_overreach_blocked",
  "budget_exceeded",
  "model_call_recorded",
  "policy_draft_created",
  "policy_simulated",
  "policy_approved",
  "policy_activated",
  "policy_retired",
  "shadow_run_created",
  "shadow_run_reviewed",
];

export const SHADOW_RUN_OUTCOMES: readonly ShadowRunOutcome[] = [
  "accepted",
  "rejected",
  "modified",
  "pending",
];

export const AUDIT_ACTOR_TYPES: readonly AuditActorType[] = [
  "model",
  "policy_engine",
  "human",
  "system",
  "adapter",
];

export const MODEL_TIERS: readonly ModelTier[] = ["classify", "standard", "reasoning"];

export const HANDOFF_REASONS: readonly HandoffReason[] = [
  "identity_unverified",
  "insufficient_evidence",
  "duplicate_request",
  "over_threshold",
  "region_blocked",
  "policy_conflict",
  "external_uncertain",
  "prompt_injection_suspected",
  "customer_requested",
  "other",
];

export const HANDOFF_STATUSES: readonly HandoffStatus[] = ["open", "claimed", "resolved"];

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "pending",
  "paid",
  "fulfilled",
  "shipped",
  "delivered",
  "refunded",
  "cancelled",
];

export const SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  "label_created",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "exception",
];

export const SHIPMENT_INCIDENT_TYPES: readonly ShipmentIncidentType[] = [
  "delayed",
  "lost",
  "delivered_not_received",
  "damaged_in_transit",
];

export const SHIPMENT_INCIDENT_STATUSES: readonly ShipmentIncidentStatus[] = [
  "open",
  "investigating",
  "resolved",
  "closed",
];

export const REFUND_TRANSACTION_STATUSES: readonly RefundTransactionStatus[] = [
  "requested",
  "processing",
  "succeeded",
  "failed",
  "reversed",
];

export const ITEM_CLAIM_TYPES: readonly ItemClaimType[] = [
  "damaged",
  "wrong_item",
  "missing_item",
  "defective",
];

export const ITEM_CLAIM_STATUSES: readonly ItemClaimStatus[] = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "resolved",
];

export const EXCHANGE_INVENTORY_STATUSES: readonly ExchangeInventoryStatus[] = [
  "unknown",
  "in_stock",
  "out_of_stock",
  "backordered",
];

export const EXCHANGE_REQUEST_STATUSES: readonly ExchangeRequestStatus[] = [
  "proposed",
  "pending_approval",
  "approved",
  "rejected",
  "fulfilled",
  "cancelled",
];

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "cancelled",
];

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ["open", "paid", "void"];

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = ["succeeded", "failed", "uncertain"];

/* ---------------- Action types by profile (§2) ---------------- */

export const CORE_ACTION_TYPES: readonly CoreActionType[] = ["create_note", "create_escalation"];
export const ECOMMERCE_ACTION_TYPES: readonly EcommerceActionType[] = [
  "refund",
  "return_request",
  "reshipment",
  "cancel_order",
  "exchange_request",
];
export const SAAS_ACTION_TYPES: readonly SaasActionType[] = [
  "credit_apply",
  "subscription_cancel",
  "plan_change",
];

export const ACTION_TYPES: readonly ActionType[] = [
  ...CORE_ACTION_TYPES,
  ...ECOMMERCE_ACTION_TYPES,
  ...SAAS_ACTION_TYPES,
];

export const ACTION_TYPE_PROFILE: Readonly<Record<ActionType, Profile>> = {
  create_note: "core",
  create_escalation: "core",
  refund: "ecommerce",
  return_request: "ecommerce",
  reshipment: "ecommerce",
  cancel_order: "ecommerce",
  exchange_request: "ecommerce",
  credit_apply: "saas",
  subscription_cancel: "saas",
  plan_change: "saas",
};

/** Financial actionTypes need amount + >=1 evidence (§2). exchange_request is
 * included because a price delta may apply and the original-order evidence is
 * mandatory — a missing-evidence exchange is blocked, never auto-approved. */
export const FINANCIAL_ACTION_TYPES: readonly ActionType[] = [
  "refund",
  "reshipment",
  "credit_apply",
  "exchange_request",
];

/**
 * ActionTypes the model must NEVER execute, even with an approval on record
 * (§4/§5): the policy engine caps their decision at require_approval and
 * executeProposal refuses them outright. Fulfillment is human-only.
 */
export const NEVER_AUTO_EXECUTE_ACTION_TYPES: readonly ActionType[] = ["exchange_request"];

/* ---------------- State machines (§2) ---------------- */

export class IllegalTransitionError extends Error {
  readonly from: string;
  readonly to: string;
  constructor(kind: string, from: string, to: string) {
    super(`Illegal ${kind} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  open: ["pending_agent", "pending_customer", "closed"],
  pending_agent: ["pending_customer", "resolved", "closed"],
  pending_customer: ["pending_agent", "resolved", "closed"],
  resolved: ["pending_agent", "closed"],
  closed: [],
};

export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  proposed: ["policy_rejected", "pending_approval", "approved"],
  pending_approval: ["approved", "rejected"],
  approved: ["executing"],
  executing: ["executed", "failed", "reconciliation_required"],
  reconciliation_required: ["executed", "failed"],
  policy_rejected: [],
  rejected: [],
  executed: [],
  failed: [],
};

export function canTransitionCase(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}

export function canTransitionProposal(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

/** Returns a new Case with the target status; throws IllegalTransitionError when illegal. */
export function transitionCase(c: Case, to: CaseStatus): Case {
  if (!canTransitionCase(c.status, to)) {
    throw new IllegalTransitionError("case", c.status, to);
  }
  const now = nowIso();
  return {
    ...c,
    status: to,
    updatedAt: now,
    ...(to === "closed" ? { closedAt: now } : {}),
  };
}

/** Returns a new ActionProposal with the target status; throws IllegalTransitionError when illegal. */
export function transitionProposal(p: ActionProposal, to: ProposalStatus): ActionProposal {
  if (!canTransitionProposal(p.status, to)) {
    throw new IllegalTransitionError("proposal", p.status, to);
  }
  return { ...p, status: to, updatedAt: nowIso() };
}

/* ---------------- Capability manifest (introduced in v0.1.1) ---------------- */

export const CAPABILITIES: readonly Capability[] = [
  "case.read",
  "customer.read",
  "knowledge.read",
  "evidence.read",
  "note.write",
  "escalation.write",
  "proposal.write",
  "approval.read",
  "approval.decide",
  "audit.read",
  "ecommerce.order.read",
  "ecommerce.shipment.read",
  "ecommerce.refund.propose",
  "ecommerce.refund.execute",
  "ecommerce.shipment_incident.read",
  "ecommerce.refund_status.read",
  "ecommerce.item_claim.propose",
  "ecommerce.exchange.propose",
  "saas.subscription.read",
  "saas.credit.propose",
];

export const TRANSPORTS: readonly Transport[] = ["http", "mcp"];

export const EXECUTION_MODES: readonly ExecutionMode[] = ["proposal_only", "shadow", "live"];

/* ---------------- Policy version lifecycle (introduced in v0.1.1) ---------------- */

export const POLICY_VERSION_STATUSES: readonly PolicyVersionStatus[] = [
  "draft",
  "simulated",
  "approved",
  "active",
  "retired",
];

/**
 * draft -> simulated -> approved -> active -> retired. `active -> retired`
 * also covers supersession (activating a new version retires the old one).
 */
export const POLICY_VERSION_TRANSITIONS: Readonly<
  Record<PolicyVersionStatus, readonly PolicyVersionStatus[]>
> = {
  draft: ["simulated"],
  simulated: ["approved", "simulated"],
  approved: ["active", "retired"],
  active: ["retired"],
  retired: [],
};

export function canTransitionPolicyVersion(
  from: PolicyVersionStatus,
  to: PolicyVersionStatus,
): boolean {
  return POLICY_VERSION_TRANSITIONS[from].includes(to);
}
