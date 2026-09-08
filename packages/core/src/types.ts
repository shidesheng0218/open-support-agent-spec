/**
 * OSAS v0.2 core domain model (CONTRACTS.md §2, §4, §5).
 * These interfaces mirror the JSON Schemas under schemas/ field-for-field.
 */

export type SpecVersion = "0.2";

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
export type EcommerceActionType =
  | "refund"
  | "return_request"
  | "reshipment"
  | "cancel_order"
  | "exchange_request";
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
  | "budget_warning"
  | "model_call_recorded"
  | "policy_draft_created"
  | "policy_simulated"
  | "policy_approved"
  | "policy_activated"
  | "policy_retired"
  | "shadow_run_created"
  | "shadow_run_reviewed";

export type AuditActorType = "model" | "policy_engine" | "human" | "system" | "adapter";

export type ModelTier = "classify" | "standard" | "reasoning";

export interface AuditModelInfo {
  provider: string;
  model: string;
  tier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** USD cost; absent = unknown (no price configured) — never fabricated. */
  costUsd?: number;
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
  /**
   * Hash-chain extension (v0.1.1, optional for backward compatibility).
   * Per-tenant append-only chain: `sequence` is 1-based per tenant,
   * `previousHash` is the prior event's `eventHash` (genesis uses the
   * all-zero hash), `eventHash` is SHA-256 over the stable JSON of the
   * event with `eventHash` itself excluded. Tamper-evidence only — this
   * does not replace WORM storage.
   */
  sequence?: number;
  previousHash?: string;
  eventHash?: string;
}

/* ---------------- Capability manifest (v0.1.1) ---------------- */

/** Spec-defined capability identifiers (schemas/core/capability-manifest.json). */
export type Capability =
  | "case.read"
  | "customer.read"
  | "knowledge.read"
  | "evidence.read"
  | "note.write"
  | "escalation.write"
  | "proposal.write"
  | "approval.read"
  | "approval.decide"
  | "audit.read"
  | "ecommerce.order.read"
  | "ecommerce.shipment.read"
  | "ecommerce.refund.propose"
  | "ecommerce.refund.execute"
  | "ecommerce.shipment_incident.read"
  | "ecommerce.refund_status.read"
  | "ecommerce.item_claim.propose"
  | "ecommerce.exchange.propose"
  | "saas.subscription.read"
  | "saas.credit.propose";

export type Transport = "http" | "mcp";

export type ExecutionMode = "proposal_only" | "shadow" | "live";

export interface CapabilityProfileGrant {
  name: Profile;
  capabilities: Capability[];
}

/**
 * CapabilityManifest — what an implementation actually supports. Served at
 * GET /.well-known/osas and GET /v1/capabilities; operations needing an
 * undeclared capability fail with CAPABILITY_UNSUPPORTED.
 */
export interface CapabilityManifest {
  specVersion: SpecVersion;
  implementationId: string;
  implementationVersion: string;
  profiles: CapabilityProfileGrant[];
  transports: Transport[];
  executionModes: ExecutionMode[];
  adapterVersion: string;
}

/* ---------------- Policy version lifecycle (v0.1.1) ---------------- */

/**
 * Lifecycle of an immutable TenantPolicy version:
 * draft -> simulated -> approved -> active -> retired.
 * The active version is never modified in place; changes are new versions.
 */
export type PolicyVersionStatus = "draft" | "simulated" | "approved" | "active" | "retired";

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

/* ----- After-sales domain objects (schemas/profiles/ecommerce/) ----- */

export type ShipmentIncidentType =
  | "delayed"
  | "lost"
  | "delivered_not_received"
  | "damaged_in_transit";

export type ShipmentIncidentStatus = "open" | "investigating" | "resolved" | "closed";

/** A logistics exception detected on a Shipment (delay, loss, damage, DNR). */
export interface ShipmentIncident {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  orderId: string;
  shipmentId: string;
  incidentType: ShipmentIncidentType;
  carrier?: string;
  status: ShipmentIncidentStatus;
  expectedAt?: IsoDateTime;
  detectedAt: IsoDateTime;
  evidenceIds?: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type RefundTransactionStatus =
  | "requested"
  | "processing"
  | "succeeded"
  | "failed"
  | "reversed";

/**
 * Record of an actual refund transaction at a payment provider. Read-only for
 * the model: it reflects execution outcomes, it never triggers them.
 */
export interface RefundTransaction {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  orderId: string;
  proposalId?: string;
  provider?: string;
  externalTransactionId?: string;
  status: RefundTransactionStatus;
  amount: Money;
  requestedAt: IsoDateTime;
  completedAt?: IsoDateTime;
  failureCode?: string;
  evidenceIds?: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type ItemClaimType = "damaged" | "wrong_item" | "missing_item" | "defective";

export type ItemClaimStatus =
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected"
  | "resolved";

/** A per-line after-sales claim. Reviewed by humans; never auto-resolved. */
export interface ItemClaim {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  orderId: string;
  lineId: string;
  claimType: ItemClaimType;
  quantity: number;
  evidenceIds?: string[];
  status: ItemClaimStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type ExchangeInventoryStatus = "unknown" | "in_stock" | "out_of_stock" | "backordered";

export type ExchangeRequestStatus =
  | "proposed"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "fulfilled"
  | "cancelled";

/**
 * A request to exchange one order line for a replacement SKU. The model may
 * only ever PROPOSE an exchange (ActionType "exchange_request",
 * require_approval by default); fulfillment is always human.
 */
export interface ExchangeRequest {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  orderId: string;
  originalLineId: string;
  replacementSku: string;
  replacementVariant?: string;
  inventoryStatus?: ExchangeInventoryStatus;
  /** Replacement price minus original price; may be negative. Integer minor units, never a float. */
  priceDelta?: Money;
  returnRequired: boolean;
  status: ExchangeRequestStatus;
  evidenceIds?: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
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

/* ---------------- ShadowRun (v0.1.1 Milestone 3) ---------------- */

export type ShadowRunOutcome = "accepted" | "rejected" | "modified" | "pending";

/**
 * What the agent WOULD have executed if live execution were allowed.
 * Record-only — Shadow Mode never executes it and never transitions the
 * proposal to "executed".
 */
export interface SuggestedAction {
  actionType: ActionType;
  reasonCode: string;
  params: Record<string, unknown>;
  amount?: Money;
}

/**
 * ShadowRun — the Shadow Mode record of a simulated policy decision for one
 * proposal: what the policy engine decided, whether it would have
 * auto-executed, and the eventual human outcome. Human accept/reject/modify
 * all land on the audit stream (shadow_run_created / shadow_run_reviewed).
 */
export interface ShadowRun {
  id: string;
  specVersion: SpecVersion;
  tenantId: string;
  proposalId: string;
  policyDecision: PolicyDecision;
  /** True only when policyDecision.decision === "auto_execute". */
  wouldAutoExecute: boolean;
  suggestedAction: SuggestedAction;
  humanOutcome: ShadowRunOutcome;
  humanComment?: string;
  /** External ticket/_ref link recorded by the human reviewer. */
  externalReference?: string;
  createdAt: IsoDateTime;
  reviewedAt?: IsoDateTime;
}

/* ---------------- Execution (CONTRACTS.md §5) ---------------- */

export type ExecutionStatus = "succeeded" | "failed" | "uncertain";

export interface ExecutionResult {
  status: ExecutionStatus;
  externalRef?: string;
  detail?: string;
}
