/**
 * OSAS v0.1 core domain model (CONTRACTS.md §2, §4, §5).
 * These interfaces mirror the JSON Schemas under schemas/ field-for-field.
 */

export type SpecVersion = "0.1";

export type Profile = "core" | "ecommerce" | "saas";

export type Permission = "read" | "draft" | "request-approval" | "execute";

/** ISO 8601 date-time string. */
export type IsoDateTime = string;

/** ISO 4217 currency, 3 upper-case letters. */
export type CurrencyCode = string;

/** Money is integer minor units only — never floats. */
export interface Money {
  currency: CurrencyCode;
  minorUnits: number;
}

/* ---------------- Case ---------------- */

export type CaseStatus = "open" | "pending_agent" | "pending_customer" | "resolved" | "closed";
export type CaseChannel = "email" | "chat" | "phone" | "social" | "api";
export type CasePriority = "low" | "normal" | "high" | "urgent";
export type AssigneeType = "agent" | "human" | "none";

export interface Case {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  customerId: string;
  profile: Profile;
  channel: CaseChannel;
  subject: string;
  status: CaseStatus;
  priority: CasePriority;
  assigneeType: AssigneeType;
  tags: string[];
  evidenceIds: string[];
  closedAt?: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/* ---------------- Customer ---------------- */

export type IdentityVerificationStatus = "verified" | "unverified" | "expired";

export interface IdentityVerification {
  status: IdentityVerificationStatus;
  method?: string;
  verifiedAt?: IsoDateTime;
  expiresAt?: IsoDateTime;
}

export interface Customer {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  displayName: string;
  email?: string;
  phone?: string;
  locale?: string;
  /** ISO 3166-1 alpha-2. */
  region: string;
  identityVerification: IdentityVerification;
  tags: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/* ---------------- Evidence ---------------- */

export type EvidenceKind =
  | "order"
  | "shipment"
  | "subscription"
  | "invoice"
  | "knowledge"
  | "conversation"
  | "policy"
  | "identity"
  | "other";

export interface EvidenceSource {
  system: string;
  recordType: string;
  recordId: string;
  url?: string;
}

export interface Evidence {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  caseId?: string;
  kind: EvidenceKind;
  source: EvidenceSource;
  summary: string;
  data: Record<string, unknown>;
  retrievedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
  createdAt: IsoDateTime;
}

/* ---------------- ActionProposal ---------------- */

export type CoreActionType = "create_note" | "create_escalation";
export type EcommerceActionType = "refund" | "return_request" | "reshipment" | "cancel_order";
export type SaasActionType = "credit_apply" | "subscription_cancel" | "plan_change";
export type ActionType = CoreActionType | EcommerceActionType | SaasActionType;

export type ProposalStatus =
  | "proposed"
  | "policy_rejected"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed"
  | "reconciliation_required";

export type ActorType = "model" | "human" | "system";

export interface RequestedByModel {
  provider: string;
  model: string;
}

export interface RequestedBy {
  actorType: ActorType;
  actorId: string;
  model?: RequestedByModel;
}

export type PolicyDecisionValue = "auto_execute" | "require_approval" | "block";

export interface PolicyDecisionReason {
  code: string;
  message: string;
}

export interface PolicyDecision {
  decision: PolicyDecisionValue;
  reasons: PolicyDecisionReason[];
  policyVersion: string;
  evaluatedAt: IsoDateTime;
}

export interface ActionProposal {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  caseId: string;
  profile: Profile;
  actionType: ActionType;
  reasonCode: string;
  params: Record<string, unknown>;
  requestedPermission: Permission;
  requestedBy: RequestedBy;
  amount?: Money;
  evidenceIds: string[];
  idempotencyKey: string;
  status: ProposalStatus;
  policyDecision?: PolicyDecision;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Input for createActionProposal (CONTRACTS.md §6). */
export type NewActionProposal = Omit<
  ActionProposal,
  "id" | "specVersion" | "status" | "createdAt" | "updatedAt"
>;

/* ---------------- Approval ---------------- */

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  proposalId: string;
  status: ApprovalStatus;
  approverId?: string;
  comment?: string;
  policyVersion: string;
  requestedAt: IsoDateTime;
  decidedAt?: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/* ---------------- TenantPolicy ---------------- */

export interface PolicyRule {
  actionType: ActionType;
  reasonCodes?: string[];
  decision: PolicyDecisionValue;
  maxAmount?: Money;
  requireVerifiedIdentity?: boolean;
  identityMaxAgeSeconds?: number;
  allowedRegions?: string[];
  blockedRegions?: string[];
}

export interface TenantPolicyBudget {
  dailyUsdCap?: number;
}

export interface TenantPolicy {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  /** semver */
  version: string;
  effectiveFrom: IsoDateTime;
  duplicateWindowSeconds: number;
  maxEvidenceAgeSeconds: number;
  budget?: TenantPolicyBudget;
  rules: PolicyRule[];
  defaultDecision: "block";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/* ---------------- AuditEvent ---------------- */

export type AuditEventType =
  | "proposal_created"
  | "proposal_validated"
  | "proposal_validation_failed"
  | "policy_evaluated"
  | "approval_requested"
  | "approval_decided"
  | "execution_started"
  | "execution_succeeded"
  | "execution_failed"
  | "execution_uncertain"
  | "reconciliation_opened"
  | "reconciliation_resolved"
  | "handoff_created"
  | "handoff_resolved"
  | "prompt_injection_blocked"
  | "permission_overreach_blocked"
  | "budget_exceeded"
  | "model_call_recorded";

export type AuditActorType = "model" | "policy_engine" | "human" | "system" | "adapter";

export type ModelTier = "classify" | "standard" | "reasoning";

export interface AuditModelInfo {
  provider: string;
  model: string;
  tier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
}

export interface AuditEvent {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  caseId?: string;
  proposalId?: string;
  approvalId?: string;
  eventType: AuditEventType;
  actorType: AuditActorType;
  actorId: string;
  policyVersion?: string;
  modelInfo?: AuditModelInfo;
  detail: Record<string, unknown>;
  createdAt: IsoDateTime;
}

/* ---------------- HumanHandoff ---------------- */

export type HandoffReason =
  | "identity_unverified"
  | "insufficient_evidence"
  | "duplicate_request"
  | "over_threshold"
  | "region_blocked"
  | "policy_conflict"
  | "external_uncertain"
  | "prompt_injection_suspected"
  | "customer_requested"
  | "other";

export type HandoffStatus = "open" | "claimed" | "resolved";

export interface HumanHandoff {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  caseId: string;
  proposalId?: string;
  reason: HandoffReason;
  status: HandoffStatus;
  assignedTo?: string;
  notes?: string;
  resolvedAt?: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/* ---------------- Extension objects: ecommerce profile ---------------- */

export type OrderStatus =
  | "pending"
  | "paid"
  | "fulfilled"
  | "shipped"
  | "delivered"
  | "refunded"
  | "cancelled";

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  unitPrice: Money;
}

export interface Order {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItem[];
  total: Money;
  region: string;
  createdAt: IsoDateTime;
}

export type ShipmentStatus =
  | "label_created"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception";

export interface Shipment {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  orderId: string;
  carrier: string;
  trackingNumber?: string;
  status: ShipmentStatus;
  eta?: IsoDateTime;
  createdAt: IsoDateTime;
}

/* ---------------- Extension objects: saas profile ---------------- */

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";

export interface Subscription {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  customerId: string;
  plan: string;
  status: SubscriptionStatus;
  mrr: Money;
  renewsAt: IsoDateTime;
  createdAt: IsoDateTime;
}

export type InvoiceStatus = "open" | "paid" | "void";

export interface Invoice {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  customerId: string;
  subscriptionId?: string;
  amount: Money;
  status: InvoiceStatus;
  issuedAt: IsoDateTime;
  dueAt?: IsoDateTime;
  createdAt: IsoDateTime;
}

export interface CreditBalance {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  customerId: string;
  balance: Money;
  createdAt: IsoDateTime;
}

/* ---------------- Knowledge / notes / escalation ---------------- */

export interface KnowledgeArticle {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CaseNote {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  caseId: string;
  body: string;
  createdAt: IsoDateTime;
}

export interface Escalation {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  caseId: string;
  reason: string;
  createdAt: IsoDateTime;
}

/* ---------------- Execution (CONTRACTS.md §5) ---------------- */

export type ExecutionStatus = "succeeded" | "failed" | "uncertain";

export interface ExecutionResult {
  status: ExecutionStatus;
  externalRef?: string;
  detail?: string;
}
