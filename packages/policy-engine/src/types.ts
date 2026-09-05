/**
 * Policy-engine-local types. All domain types come from `@osas/core`
 * (CONTRACTS.md §2–§4); only symbols core does not define live here.
 */
import type { Customer, Evidence, TenantPolicy, ActionProposal } from "@osas/core";

export type {
  ActionProposal,
  ActionType,
  ActorType,
  Customer,
  Evidence,
  ExecutionResult,
  ExecutionStatus,
  IdentityVerification,
  Money,
  Permission,
  PolicyDecision,
  PolicyDecisionReason,
  PolicyDecisionValue,
  PolicyRule,
  Profile,
  ProposalStatus,
  RequestedBy,
  TenantPolicy,
} from "@osas/core";

export {
  ACTION_TYPE_PROFILE,
  FINANCIAL_ACTION_TYPES,
  PERMISSIONS,
  permissionAtLeast,
} from "@osas/core";

/** §4 reason codes. */
export const POLICY_REASON_CODES = [
  "PERMISSION_OVERREACH",
  "PROMPT_INJECTION_SUSPECTED",
  "PROFILE_MISMATCH",
  "NO_RULE",
  "REASON_CODE_NOT_ALLOWED",
  "DUPLICATE_REQUEST",
  "OVER_THRESHOLD",
  "CURRENCY_MISMATCH",
  "IDENTITY_REQUIRED",
  "IDENTITY_UNVERIFIED",
  "REGION_BLOCKED",
  "REGION_UNLISTED",
  "INSUFFICIENT_EVIDENCE",
  "EVIDENCE_STALE",
] as const;

export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

/** §4 evaluation context. `now` is injectable for deterministic tests. */
export interface EvaluationContext {
  customer?: Customer;
  evidence: Evidence[];
  policy: TenantPolicy;
  recentProposals: ActionProposal[];
  injectionSuspected: boolean;
  now?: Date;
}
