import type {
  ActionType,
  HandoffReason,
  PolicyDecisionValue,
  Profile,
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
