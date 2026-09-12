/**
 * OSAS v0.3 Draft after-sales vertical contract.
 *
 * These objects deliberately live beside, rather than inside, the stable v0.2
 * Case contract. The vertical layer coordinates intake/evaluation while the
 * existing Case, ActionProposal, Approval, ExecutionReceipt and AuditEvent
 * objects remain backward compatible.
 */

export type AfterSalesScenario =
  | "wismo"
  | "delivery_delay"
  | "not_received"
  | "damaged_item"
  | "wrong_or_missing_item"
  | "refund_request"
  | "refund_pending"
  | "return_request"
  | "reshipment_request"
  | "exchange_request";

export const AFTER_SALES_SCENARIOS: readonly AfterSalesScenario[] = [
  "wismo",
  "delivery_delay",
  "not_received",
  "damaged_item",
  "wrong_or_missing_item",
  "refund_request",
  "refund_pending",
  "return_request",
  "reshipment_request",
  "exchange_request",
] as const;

export type AfterSalesCaseStatus =
  | "intake"
  | "evidence_required"
  | "evaluated"
  | "pending_approval"
  | "human_handoff"
  | "executing"
  | "resolved"
  | "reconciliation_required"
  | "blocked";

export const AFTER_SALES_CASE_STATUSES: readonly AfterSalesCaseStatus[] = [
  "intake",
  "evidence_required",
  "evaluated",
  "pending_approval",
  "human_handoff",
  "executing",
  "resolved",
  "reconciliation_required",
  "blocked",
] as const;

export type AfterSalesRiskLevel = "low" | "medium" | "high" | "critical";

export const AFTER_SALES_RISK_LEVELS: readonly AfterSalesRiskLevel[] = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export interface AfterSalesCase {
  id: string;
  tenantId: string;
  /** Source v0.2 support Case that originated this vertical case. */
  sourceCaseId: string;
  scenarioCode: AfterSalesScenario;
  orderId?: string;
  customerId?: string;
  /** Requested monetary amount, when the scenario has a financial action. */
  amount?: { currency: string; minorUnits: number };
  status: AfterSalesCaseStatus;
  riskLevel: AfterSalesRiskLevel;
  evidenceIds: string[];
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
  /** Linked v0.2 records, populated as the case moves through the pipeline. */
  proposalId?: string;
  handoffId?: string;
  requestMessage?: string;
  idempotencyKey?: string;
}

export type AfterSalesDecisionOutcome =
  | "answer_only"
  | "proposal_created"
  | "approval_required"
  | "human_handoff"
  | "blocked"
  | "reconciliation_required";

export interface AfterSalesDecision {
  outcome: AfterSalesDecisionOutcome;
  reasonCodes: string[];
  requiredEvidence: string[];
  missingEvidence: string[];
  customerMessage?: string;
  operatorSummary?: string;
}

export interface AfterSalesScenarioContract {
  scenarioCode: AfterSalesScenario;
  defaultActionType?: string;
  requiredEvidence: string[];
  riskLevel: AfterSalesRiskLevel;
  reasonCode: string;
}

export const AFTER_SALES_SCENARIO_CONTRACTS: readonly AfterSalesScenarioContract[] = [
  { scenarioCode: "wismo", requiredEvidence: ["order_or_shipment"], riskLevel: "low", reasonCode: "wismo" },
  { scenarioCode: "delivery_delay", defaultActionType: "create_escalation", requiredEvidence: ["shipment"], riskLevel: "medium", reasonCode: "delivery_delay" },
  { scenarioCode: "not_received", defaultActionType: "reshipment", requiredEvidence: ["order_or_shipment"], riskLevel: "high", reasonCode: "not_received" },
  { scenarioCode: "damaged_item", defaultActionType: "refund", requiredEvidence: ["order", "damage_photo"], riskLevel: "high", reasonCode: "damaged" },
  { scenarioCode: "wrong_or_missing_item", defaultActionType: "reshipment", requiredEvidence: ["order"], riskLevel: "high", reasonCode: "wrong_or_missing_item" },
  { scenarioCode: "refund_request", defaultActionType: "refund", requiredEvidence: ["order"], riskLevel: "high", reasonCode: "other" },
  { scenarioCode: "refund_pending", requiredEvidence: ["refund_status"], riskLevel: "medium", reasonCode: "refund_pending" },
  { scenarioCode: "return_request", defaultActionType: "return_request", requiredEvidence: ["order"], riskLevel: "medium", reasonCode: "return_request" },
  { scenarioCode: "reshipment_request", defaultActionType: "reshipment", requiredEvidence: ["order"], riskLevel: "high", reasonCode: "reshipment_request" },
  { scenarioCode: "exchange_request", defaultActionType: "exchange_request", requiredEvidence: ["order"], riskLevel: "high", reasonCode: "exchange_request" },
] as const;

export function getAfterSalesContract(scenarioCode: AfterSalesScenario): AfterSalesScenarioContract {
  return AFTER_SALES_SCENARIO_CONTRACTS.find((entry) => entry.scenarioCode === scenarioCode)!;
}
