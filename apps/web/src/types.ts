// Local mirrors of OSAS v0.2 API payloads (CONTRACTS.md §2/§9).
// Intentionally NOT importing workspace packages — the console only sees HTTP JSON.

export type Profile = "core" | "ecommerce" | "saas";
export type Permission = "read" | "draft" | "request-approval" | "execute";

export interface Money {
  currency: string;
  minorUnits: number;
}

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

export interface PolicyDecision {
  decision: "auto_execute" | "require_approval" | "block";
  reasons: { code: string; message: string }[];
  policyVersion: string;
  evaluatedAt: string;
}

export interface ActionProposal {
  id: string;
  specVersion: string;
  tenantId: string;
  caseId: string;
  profile: Profile;
  actionType: string;
  reasonCode: string;
  params: Record<string, unknown>;
  requestedPermission: Permission;
  requestedBy: {
    actorType: "model" | "human" | "system";
    actorId: string;
    model?: { provider: string; model: string };
  };
  amount?: Money;
  evidenceIds: string[];
  idempotencyKey: string;
  status: ProposalStatus;
  policyDecision?: PolicyDecision;
  createdAt: string;
  updatedAt?: string;
}

export interface Approval {
  id: string;
  specVersion: string;
  tenantId: string;
  proposalId: string;
  status: "pending" | "approved" | "rejected";
  approverId?: string;
  comment?: string;
  policyVersion: string;
  requestedAt: string;
  decidedAt?: string;
  createdAt: string;
}

/** GET /v1/approvals embeds the proposal (CONTRACTS §9). */
export interface ApprovalWithProposal extends Approval {
  proposal?: ActionProposal;
}

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

export interface HumanHandoff {
  id: string;
  specVersion: string;
  tenantId: string;
  caseId: string;
  proposalId?: string;
  reason: HandoffReason;
  status: "open" | "claimed" | "resolved";
  assignedTo?: string;
  notes?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface AuditEvent {
  id: string;
  specVersion: string;
  tenantId: string;
  caseId?: string;
  proposalId?: string;
  approvalId?: string;
  eventType: string;
  actorType: "model" | "policy_engine" | "human" | "system" | "adapter";
  actorId: string;
  policyVersion?: string;
  modelInfo?: {
    provider: string;
    model: string;
    tier: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    costUsd: number;
  };
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ToolDefinition {
  name: string;
  profile: Profile;
  description: string;
  inputSchema: Record<string, unknown>;
  adapterMethod: string;
  permissionRequired: Permission;
}

export interface SchemaManifest {
  specVersion: string;
  schemas: { name: string; profile: string; path: string }[];
}

export interface ValidationError {
  instancePath?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[] | null;
}

export interface ExecutionResult {
  status: "succeeded" | "failed" | "uncertain";
  externalRef?: string;
  detail?: string;
}

export interface ChatResponse {
  reply: string;
  proposal?: ActionProposal;
  decision?: PolicyDecision;
  execution?: ExecutionResult;
  handoff?: HumanHandoff;
}

export interface DecideResponse {
  approval: Approval;
  execution?: ExecutionResult;
}

export interface HealthResponse {
  status: string;
  specVersion: string;
  version: string;
}

export interface CompatReport {
  specVersion: string;
  runAt: string;
  suites: {
    name: string;
    passed: number;
    failed: number;
    cases: { name: string; ok: boolean; error?: string }[];
  }[];
  ok: boolean;
}

/* ---------------- Shadow Mode (v0.1.1 Milestone 3) ---------------- */

export type ShadowRunOutcome = "accepted" | "rejected" | "modified" | "pending";

export interface ShadowRun {
  id: string;
  specVersion: string;
  tenantId: string;
  proposalId: string;
  policyDecision: PolicyDecision;
  wouldAutoExecute: boolean;
  suggestedAction: {
    actionType: string;
    reasonCode: string;
    params: Record<string, unknown>;
    amount?: Money;
  };
  humanOutcome: ShadowRunOutcome;
  humanComment?: string;
  externalReference?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface EvidenceRecord {
  id: string;
  kind: string;
  summary: string;
  source: { system: string; recordType: string; recordId: string; url?: string };
}

/** GET /v1/shadow-runs item + POST shadow-run/review responses. */
export interface ShadowRunEnvelope {
  shadowRun: ShadowRun;
  proposal?: ActionProposal;
  evidence: EvidenceRecord[];
}

export interface AuditChainVerification {
  tenantId: string;
  intact: boolean;
  chainLength: number;
  firstError?: { eventId: string; reason: string };
}
