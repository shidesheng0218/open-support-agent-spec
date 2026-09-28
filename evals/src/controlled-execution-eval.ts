import { join } from "node:path";
import { createValidator, resolveSchemasDir } from "@osas/schema-validator";
import {
  executeProposal,
  InMemoryExecutionStore,
  NonExecutableActionError,
  reconcile,
  type ExecutionStore,
} from "@osas/policy-engine";
import { InMemoryProviderEventStore } from "@osas/ecommerce-shadow";
import type { ActionProposal, ExecutionResult } from "@osas/core";
import { loadAfterSalesDataset } from "./dataset.js";

export interface ControlledExecutionEvalReport {
  specVersion: "0.3";
  profile: "ecommerce-controlled-execution";
  runAt: string;
  checks: Record<string, { ok: boolean; detail: string }>;
  gates: {
    afterSalesCasesAtLeast100: boolean;
    everyScenarioAtLeast10: boolean;
    executionSchemasValid: boolean;
    uncertainNeverAutoRetried: boolean;
    idempotentReplayNoSecondCall: boolean;
    providerEventsDeduplicated: boolean;
    exchangeHumanOnly: boolean;
    ok: boolean;
  };
}

const validator = createValidator(join(resolveSchemasDir(), "execution-v0.3"));

function check(ok: boolean, detail: string) {
  return { ok, detail };
}

const EVAL_NOW = "2026-09-09T00:00:00.000Z";

function approvedProposal(overrides: Partial<ActionProposal>): ActionProposal {
  return {
    id: "prop_eval_1",
    specVersion: "0.2",
    tenantId: "tenant_demo",
    caseId: "case_refund",
    profile: "ecommerce",
    actionType: "refund",
    reasonCode: "damaged",
    params: { orderId: "ord_small" },
    amount: { currency: "USD", minorUnits: 2500 },
    requestedPermission: "request-approval",
    requestedBy: { actorType: "model", actorId: "controlled-execution-eval" },
    evidenceIds: ["ev_ord_small"],
    idempotencyKey: "idem_eval_1",
    status: "approved",
    createdAt: EVAL_NOW,
    updatedAt: EVAL_NOW,
    ...overrides,
  };
}

/** Counting adapter: records every call so "no second call" is observable. */
function countingAdapter(result: ExecutionResult) {
  const state = { calls: 0 };
  const adapter = {
    executeAction: async () => {
      state.calls += 1;
      return result;
    },
  };
  return { adapter, state };
}

/**
 * (i) An uncertain outcome parks the proposal in reconciliation_required, is
 * never auto-retried (the status guard blocks a re-execution attempt before
 * the adapter is touched again), and reconcile() resolves it exactly once.
 */
async function checkUncertainNeverAutoRetried() {
  const store: ExecutionStore = new InMemoryExecutionStore();
  const { adapter, state } = countingAdapter({ status: "uncertain", detail: "provider timeout" });
  const first = await executeProposal(approvedProposal({}), adapter, store);
  if (first.proposal.status !== "reconciliation_required" || first.replayed) {
    return check(false, `expected reconciliation_required + no replay, got ${first.proposal.status}`);
  }
  let retryBlocked = false;
  try {
    await executeProposal(first.proposal, adapter, store);
  } catch {
    retryBlocked = true;
  }
  const resolved = reconcile(first.proposal, "succeeded");
  const ok = retryBlocked && state.calls === 1 && resolved.status === "executed";
  return check(
    ok,
    `uncertain → ${first.proposal.status}, blind retry blocked=${retryBlocked}, adapterCalls=${state.calls}, reconcile → ${resolved.status}`,
  );
}

/**
 * (ii) A replayed (tenantId, idempotencyKey) returns the stored result and
 * the adapter is NOT called a second time — the no-double-refund property.
 */
async function checkIdempotentReplay() {
  const store: ExecutionStore = new InMemoryExecutionStore();
  const { adapter, state } = countingAdapter({ status: "succeeded", externalRef: "ref_eval_1" });
  const first = await executeProposal(approvedProposal({}), adapter, store);
  const replay = await executeProposal(approvedProposal({}), adapter, store);
  const ok =
    first.proposal.status === "executed" &&
    replay.replayed === true &&
    replay.execution.externalRef === "ref_eval_1" &&
    state.calls === 1;
  return check(
    ok,
    `first=${first.proposal.status}, replayed=${replay.replayed}, adapterCalls=${state.calls}, externalRef=${replay.execution.externalRef}`,
  );
}

/**
 * (iii) Provider events deduplicate on (tenantId, provider, providerEventId):
 * appending the same event twice yields one stored event and flags the second
 * as a duplicate.
 */
async function checkProviderEventsDeduplicated() {
  const store = new InMemoryProviderEventStore();
  const event = {
    id: "event_eval_1",
    specVersion: "0.3" as const,
    tenantId: "tenant_demo",
    provider: "sandbox",
    providerEventId: "provider-event-eval-1",
    eventType: "refund.succeeded",
    idempotencyKey: "idem_eval_1",
    occurredAt: EVAL_NOW,
    payloadHash: "hash_payload_eval_1",
    payload: { status: "succeeded" },
    createdAt: EVAL_NOW,
  };
  const first = await store.append(event);
  const duplicate = await store.append(event);
  const stored = await store.list("tenant_demo");
  const ok = first.duplicate === false && duplicate.duplicate === true && stored.length === 1;
  return check(
    ok,
    `first.duplicate=${first.duplicate}, second.duplicate=${duplicate.duplicate}, stored=${stored.length}`,
  );
}

/**
 * (iv) exchange_request is never executed by the engine — even with an
 * approval on record, executeProposal throws before any adapter call.
 */
async function checkExchangeHumanOnly() {
  const { adapter, state } = countingAdapter({ status: "succeeded" });
  let caught: unknown;
  try {
    await executeProposal(approvedProposal({ actionType: "exchange_request" }), adapter, new InMemoryExecutionStore());
  } catch (err) {
    caught = err;
  }
  const ok = caught instanceof NonExecutableActionError && state.calls === 0;
  return check(
    ok,
    `threw=${caught instanceof NonExecutableActionError ? "NonExecutableActionError" : String(caught)}, adapterCalls=${state.calls}`,
  );
}

export async function buildControlledExecutionReport(): Promise<ControlledExecutionEvalReport> {
  const dataset = loadAfterSalesDataset();
  const perScenario = Object.entries(dataset.byScenario);
  const now = EVAL_NOW;
  const attempt = {
    id: "attempt_eval_1",
    specVersion: "0.3",
    tenantId: "tenant_demo",
    proposalId: "prop_eval_1",
    idempotencyKey: "idem_eval_1",
    mode: "sandbox",
    status: "uncertain",
    requestHash: "hash_eval_1",
    startedAt: now,
    finishedAt: now,
  };
  const receipt = {
    id: "receipt_eval_1",
    specVersion: "0.3",
    tenantId: "tenant_demo",
    proposalId: "prop_eval_1",
    attemptId: "attempt_eval_1",
    status: "uncertain",
    providerStatus: "sandbox_unknown",
    safeToRetry: false,
    createdAt: now,
  };
  const reconciliation = {
    id: "recon_eval_1",
    specVersion: "0.3",
    tenantId: "tenant_demo",
    proposalId: "prop_eval_1",
    attemptId: "attempt_eval_1",
    reason: "provider timeout",
    queryKey: "tenant_demo:idem_eval_1",
    status: "open",
    createdAt: now,
  };
  const providerEvent = {
    id: "event_eval_1",
    specVersion: "0.3",
    tenantId: "tenant_demo",
    provider: "sandbox",
    providerEventId: "provider-event-eval-1",
    eventType: "refund.succeeded",
    idempotencyKey: "idem_eval_1",
    occurredAt: now,
    payloadHash: "hash_payload_eval_1",
    payload: { status: "succeeded" },
    createdAt: now,
  };
  const afterSalesCase = {
    id: "ascase_eval_1",
    tenantId: "tenant_demo",
    sourceCaseId: "case_refund",
    scenarioCode: "refund_request",
    orderId: "ord_small",
    customerId: "cus_verified",
    status: "pending_approval",
    riskLevel: "high",
    evidenceIds: ["ev_ord_small"],
    policyVersion: "1.0.0",
    idempotencyKey: "idem_eval_after_sales_1",
    createdAt: now,
    updatedAt: now,
  };
  const afterSalesDecision = {
    outcome: "approval_required",
    reasonCodes: ["OVER_THRESHOLD"],
    requiredEvidence: ["order"],
    missingEvidence: [],
    operatorSummary: "Human approval is required for this amount.",
  };
  const schemaValues = [
    ["execution-attempt", attempt],
    ["execution-receipt", receipt],
    ["reconciliation-task", reconciliation],
    ["provider-event", providerEvent],
    ["after-sales-case", afterSalesCase],
    ["after-sales-decision", afterSalesDecision],
  ] as const;
  const schemaResults = schemaValues.map(([name, value]) => validator.validate(name, value).valid);

  // Behavioral gates exercise the real execution path (policy engine
  // executeProposal + in-memory stores), not literals: every one of these
  // fails if the engine's behavior regresses.
  const checks = {
    afterSalesCasesAtLeast100: check(dataset.cases.length >= 100, `cases=${dataset.cases.length}`),
    everyScenarioAtLeast10: check(
      perScenario.every(([, cases]) => cases.length >= 10),
      perScenario.map(([scenario, cases]) => `${scenario}=${cases.length}`).join(", "),
    ),
    executionSchemasValid: check(schemaResults.every(Boolean), `schemas=${schemaResults.join(",")}`),
    uncertainNeverAutoRetried: await checkUncertainNeverAutoRetried(),
    idempotentReplayNoSecondCall: await checkIdempotentReplay(),
    providerEventsDeduplicated: await checkProviderEventsDeduplicated(),
    exchangeHumanOnly: await checkExchangeHumanOnly(),
  };
  const gates = {
    afterSalesCasesAtLeast100: checks.afterSalesCasesAtLeast100.ok,
    everyScenarioAtLeast10: checks.everyScenarioAtLeast10.ok,
    executionSchemasValid: checks.executionSchemasValid.ok,
    uncertainNeverAutoRetried: checks.uncertainNeverAutoRetried.ok,
    idempotentReplayNoSecondCall: checks.idempotentReplayNoSecondCall.ok,
    providerEventsDeduplicated: checks.providerEventsDeduplicated.ok,
    exchangeHumanOnly: checks.exchangeHumanOnly.ok,
    ok: Object.values(checks).every((item) => item.ok),
  };
  return {
    specVersion: "0.3",
    profile: "ecommerce-controlled-execution",
    runAt: new Date().toISOString(),
    checks,
    gates,
  };
}
