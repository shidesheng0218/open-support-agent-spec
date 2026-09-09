import type {
  ActionType,
  HandoffReason,
  Money,
  OrderStatus,
  PolicyDecisionValue,
  Profile,
  ShipmentStatus,
} from "@osas/core";

/**
 * OSAS eval case format (Milestone 4). All cases are synthetic — ids use the
 * eval_* / cus_eval_* namespaces and messages must never contain real PII.
 */

export type EvalCategory =
  | "refund"
  | "return"
  | "reshipment"
  | "cancel_order"
  | "general"
  | "security";

export type IdentityState = "verified" | "unverified" | "expired" | "missing";
export type EvidenceState = "fresh" | "expired" | "missing";
export type ExecutionOutcome = "succeeded" | "uncertain";

export interface EvalCustomerSpec {
  identity?: IdentityState; // default "verified"
  region?: string; // default "US"
}

export interface EvalInput {
  /** Synthetic customer message (no real PII). */
  message: string;
  caseId?: string;
  orderId?: string;
  customer?: EvalCustomerSpec;
  /** Evidence availability for financial actions; default "fresh". */
  evidence?: EvidenceState;
  amount?: { currency: string; minorUnits: number };
  reasonCode?: string; // default per actionType
  /** An identical active proposal already exists (duplicate-request probe). */
  duplicate?: boolean;
  /** The originating conversation looks injected. */
  injection?: boolean;
  /** External executor outcome when the policy auto-executes. */
  executionOutcome?: ExecutionOutcome;
}

export interface EvalExpected {
  /** Action a correct agent would propose; null = no action. */
  action: ActionType | null;
  /** Expected deterministic policy result ("none" when action is null). */
  policyDecision: PolicyDecisionValue | "none";
  /** Policy reason codes expected on the decision (subset match). */
  reasonCodes?: string[];
  handoffReason?: HandoffReason;
  evidenceRequired: boolean;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  profile: Profile;
  input: EvalInput;
  expected: EvalExpected;
}

export const CATEGORY_FILES: Readonly<Record<EvalCategory, string>> = {
  refund: "refunds.json",
  return: "returns.json",
  reshipment: "reshipments.json",
  cancel_order: "cancellations.json",
  general: "general.json",
  security: "security.json",
};

export const CATEGORY_COUNTS: Readonly<Record<EvalCategory, number>> = {
  refund: 30,
  return: 20,
  reshipment: 15,
  cancel_order: 15,
  general: 20,
  security: 20,
};

/* ---------------- After-sales top-10 eval set (v0.2 Phase 3) ---------------- */

/**
 * The after-sales set uses a NEW case shape (not EvalCase): each case is a
 * realistic after-sales scenario with explicit coverage bookkeeping, so the
 * report can show which of the top-10 flows are genuinely supported end to
 * end and which only reach proposal/shadow/handoff in this repo.
 */

export type AfterSalesScenario =
  | "wismo"
  | "delayed_delivery"
  | "delivered_not_received"
  | "damaged_item_refund"
  | "wrong_item"
  | "size_or_preference"
  | "missing_item"
  | "refund_not_received"
  | "cancel_unshipped"
  | "exchange";

export const AFTER_SALES_SCENARIOS: readonly AfterSalesScenario[] = [
  "wismo",
  "delayed_delivery",
  "delivered_not_received",
  "damaged_item_refund",
  "wrong_item",
  "size_or_preference",
  "missing_item",
  "refund_not_received",
  "cancel_unshipped",
  "exchange",
];

export const AFTER_SALES_FILE = "after-sales-top10.json";
/** 10 scenarios × 10 synthetic cases (normal and boundary/risk variants). */
export const AFTER_SALES_CASE_COUNT = 100;

export type AfterSalesCoverage =
  | "supported"
  | "proposal_only"
  | "shadow_only"
  | "missing_domain_object"
  | "missing_adapter"
  | "unsupported";

export const AFTER_SALES_COVERAGE_STATUSES: readonly AfterSalesCoverage[] = [
  "supported",
  "proposal_only",
  "shadow_only",
  "missing_domain_object",
  "missing_adapter",
  "unsupported",
];

/**
 * Coverage statuses where the scenario can never reach a real execution in
 * this repo — these must never expect (or get) auto_execute.
 */
export const AFTER_SALES_UNSUPPORTED_COVERAGE: readonly AfterSalesCoverage[] = [
  "missing_domain_object",
  "missing_adapter",
  "unsupported",
];

export interface AfterSalesOrderSpec {
  id: string;
  status: OrderStatus;
  totalMinorUnits: number;
  currency: string;
}

export interface AfterSalesShipmentSpec {
  id: string;
  status: ShipmentStatus;
  carrier?: string;
  expectedAt?: string;
  /** Carrier scan shows "delivered" (delivered-not-received probes). */
  deliveredScan?: boolean;
}

export interface AfterSalesCase {
  id: string;
  scenario: AfterSalesScenario;
  /** Synthetic customer message (no real PII). */
  customerMessage: string;
  order: AfterSalesOrderSpec;
  shipment: AfterSalesShipmentSpec | null;
  customerIdentity: IdentityState;
  evidenceState: EvidenceState;
  /** Action a correct agent would propose; null = no action (refuse/handoff). */
  expectedAction: ActionType | null;
  /** Expected deterministic policy result ("none" when expectedAction is null). */
  expectedPolicyDecision: PolicyDecisionValue | "none";
  /** Expected human-handoff reason; null when no handoff. */
  expectedHandoff: HandoffReason | null;
  coverageStatus: AfterSalesCoverage;
  /**
   * Concrete gap note. Empty string or "none" is allowed ONLY when
   * coverageStatus is "supported"; every other case must name its gap.
   */
  missingCapability: string;
  /** Plain-language customer-visible outcome a correct run produces. */
  expectedCustomerOutcome: string;
  /** Proposal amount for financial actions (defaults to the order total). */
  amount?: Money;
  reasonCode?: string;
  /** An identical active proposal already exists (duplicate-request probe). */
  duplicate?: boolean;
  /** The originating conversation looks injected. */
  injection?: boolean;
}
