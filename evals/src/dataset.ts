import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_TYPES as SPEC_ACTION_TYPES,
  ORDER_STATUSES,
  SHIPMENT_STATUSES,
} from "@osas/core";
import type { ActionType, HandoffReason, Profile } from "@osas/core";
import {
  AFTER_SALES_CASE_COUNT,
  AFTER_SALES_COVERAGE_STATUSES,
  AFTER_SALES_FILE,
  AFTER_SALES_SCENARIOS,
  AFTER_SALES_UNSUPPORTED_COVERAGE,
  CATEGORY_FILES,
  type AfterSalesCase,
  type EvalCase,
  type EvalCategory,
} from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function casesDir(): string {
  for (const candidate of [resolve(here, "../cases"), resolve(here, "../../cases")]) {
    try {
      readFileSync(join(candidate, CATEGORY_FILES.refund), "utf8");
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error("evals: could not locate the cases/ directory");
}

const PROFILES: readonly string[] = ["core", "ecommerce", "saas"];
const ACTION_TYPES: readonly string[] = [
  "create_note",
  "create_escalation",
  "refund",
  "return_request",
  "reshipment",
  "cancel_order",
  "credit_apply",
  "subscription_cancel",
  "plan_change",
];
const DECISIONS: readonly string[] = ["auto_execute", "require_approval", "block", "none"];
const HANDOFF_REASONS: readonly string[] = [
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
const CATEGORIES: readonly string[] = Object.keys(CATEGORY_FILES);

/** Structural validation of one case. Returns a list of problems (empty = valid). */
export function validateCase(raw: unknown, file: string): string[] {
  const problems: string[] = [];
  const bad = (msg: string) => problems.push(`${file}: ${msg}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${file}: not an object`];
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || !c.id.trim()) bad("missing id");
  if (typeof c.category !== "string" || !CATEGORIES.includes(c.category)) bad(`bad category ${String(c.category)}`);
  if (typeof c.profile !== "string" || !PROFILES.includes(c.profile)) bad(`bad profile ${String(c.profile)}`);
  const input = c.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") {
    bad("missing input");
    return problems;
  }
  if (typeof input.message !== "string" || !input.message.trim()) bad("input.message missing");
  if (input.customer !== undefined && (typeof input.customer !== "object" || input.customer === null)) {
    bad("input.customer must be an object");
  }
  if (input.evidence !== undefined && !["fresh", "expired", "missing"].includes(String(input.evidence))) {
    bad(`bad evidence state ${String(input.evidence)}`);
  }
  const expected = c.expected as Record<string, unknown> | undefined;
  if (!expected || typeof expected !== "object") {
    bad("missing expected");
    return problems;
  }
  if (expected.action !== null && !ACTION_TYPES.includes(String(expected.action))) {
    bad(`bad expected.action ${String(expected.action)}`);
  }
  if (!DECISIONS.includes(String(expected.policyDecision))) {
    bad(`bad expected.policyDecision ${String(expected.policyDecision)}`);
  }
  if (expected.action === null && expected.policyDecision !== "none") {
    bad("action null requires policyDecision 'none'");
  }
  if (expected.action !== null && expected.policyDecision === "none") {
    bad("an expected action requires a real policyDecision");
  }
  if (
    expected.handoffReason !== undefined &&
    expected.handoffReason !== null &&
    !HANDOFF_REASONS.includes(String(expected.handoffReason))
  ) {
    bad(`bad handoffReason ${String(expected.handoffReason)}`);
  }
  if (typeof expected.evidenceRequired !== "boolean") bad("expected.evidenceRequired must be boolean");
  if (expected.reasonCodes !== undefined && !Array.isArray(expected.reasonCodes)) {
    bad("expected.reasonCodes must be an array of policy reason codes");
  }
  // No real PII: synthetic ids only, no email/phone patterns in messages.
  const msg = String(input.message);
  if (/@[a-z0-9.-]+\.(com|net|org|cn|io)/i.test(msg) && !/example\.com/i.test(msg)) {
    bad("message appears to contain a real email address");
  }
  if (/\b\d{3}[- ]?\d{3}[- ]?\d{4}\b/.test(msg)) bad("message appears to contain a phone number");
  return problems;
}

export interface Dataset {
  cases: EvalCase[];
  byCategory: Record<EvalCategory, EvalCase[]>;
}

export function loadDataset(dir = casesDir()): Dataset {
  const cases: EvalCase[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [category, file] of Object.entries(CATEGORY_FILES)) {
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      problems.push(`${file}: top level must be an array`);
      continue;
    }
    for (const entry of raw) {
      problems.push(...validateCase(entry, file));
      const c = entry as EvalCase;
      if (c.category !== category) problems.push(`${file}: case ${c.id} has category ${c.category}`);
      if (seen.has(c.id)) problems.push(`duplicate case id ${c.id}`);
      seen.add(c.id);
      cases.push(c);
    }
  }
  if (problems.length > 0) {
    throw new Error(`eval dataset is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const byCategory = Object.fromEntries(
    (Object.keys(CATEGORY_FILES) as EvalCategory[]).map((cat) => [
      cat,
      cases.filter((c) => c.category === cat),
    ]),
  ) as Record<EvalCategory, EvalCase[]>;
  return { cases, byCategory };
}

export type { ActionType, HandoffReason, Profile };

/* ---------------- After-sales top-10 dataset (new case shape) ---------------- */

const IDENTITY_STATES: readonly string[] = ["verified", "unverified", "expired", "missing"];
const EVIDENCE_STATES: readonly string[] = ["fresh", "expired", "missing"];

function hasPiiMarker(msg: string): string | undefined {
  if (/@[a-z0-9.-]+\.(com|net|org|cn|io)/i.test(msg) && !/example\.com/i.test(msg)) {
    return "message appears to contain a real email address";
  }
  if (/\b\d{3}[- ]?\d{3}[- ]?\d{4}\b/.test(msg)) {
    return "message appears to contain a phone number";
  }
  return undefined;
}

/**
 * Structural validation of one after-sales case (after-sales-top10.json).
 * Returns a list of problems (empty = valid). This is a NEW case shape and is
 * intentionally validated separately from validateCase().
 */
export function validateAfterSalesCase(raw: unknown, file: string): string[] {
  const problems: string[] = [];
  const bad = (msg: string) => problems.push(`${file}: ${msg}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${file}: not an object`];
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || !c.id.trim()) bad("missing id");
  if (typeof c.scenario !== "string" || !AFTER_SALES_SCENARIOS.includes(c.scenario as never)) {
    bad(`bad scenario ${String(c.scenario)}`);
  }
  if (typeof c.customerMessage !== "string" || !c.customerMessage.trim()) {
    bad("customerMessage missing");
  } else {
    const pii = hasPiiMarker(c.customerMessage);
    if (pii) bad(pii);
  }
  const order = c.order as Record<string, unknown> | undefined;
  if (!order || typeof order !== "object") {
    bad("order missing");
  } else {
    if (typeof order.id !== "string" || !order.id.trim()) bad("order.id missing");
    if (!ORDER_STATUSES.includes(order.status as never)) bad(`bad order.status ${String(order.status)}`);
    if (typeof order.totalMinorUnits !== "number" || !Number.isInteger(order.totalMinorUnits)) {
      bad("order.totalMinorUnits must be an integer");
    }
    if (typeof order.currency !== "string" || !order.currency.trim()) bad("order.currency missing");
  }
  if (c.shipment !== null && (typeof c.shipment !== "object" || c.shipment === undefined)) {
    bad("shipment must be an object or null");
  } else if (c.shipment !== null) {
    const s = c.shipment as Record<string, unknown>;
    if (typeof s.id !== "string" || !s.id.trim()) bad("shipment.id missing");
    if (!SHIPMENT_STATUSES.includes(s.status as never)) bad(`bad shipment.status ${String(s.status)}`);
  }
  if (!IDENTITY_STATES.includes(String(c.customerIdentity))) {
    bad(`bad customerIdentity ${String(c.customerIdentity)}`);
  }
  if (!EVIDENCE_STATES.includes(String(c.evidenceState))) {
    bad(`bad evidenceState ${String(c.evidenceState)}`);
  }
  if (c.expectedAction !== null && !SPEC_ACTION_TYPES.includes(c.expectedAction as never)) {
    bad(`bad expectedAction ${String(c.expectedAction)}`);
  }
  if (!DECISIONS.includes(String(c.expectedPolicyDecision))) {
    bad(`bad expectedPolicyDecision ${String(c.expectedPolicyDecision)}`);
  }
  if (c.expectedAction === null && c.expectedPolicyDecision !== "none") {
    bad("expectedAction null requires expectedPolicyDecision 'none'");
  }
  if (c.expectedAction !== null && c.expectedPolicyDecision === "none") {
    bad("an expectedAction requires a real expectedPolicyDecision");
  }
  if (c.expectedHandoff !== null && !HANDOFF_REASONS.includes(String(c.expectedHandoff))) {
    bad(`bad expectedHandoff ${String(c.expectedHandoff)}`);
  }
  if (!AFTER_SALES_COVERAGE_STATUSES.includes(c.coverageStatus as never)) {
    bad(`bad coverageStatus ${String(c.coverageStatus)}`);
  }
  if (typeof c.missingCapability !== "string") {
    bad("missingCapability must be a string (empty/'none' only when coverageStatus is 'supported')");
  } else {
    const gap = c.missingCapability.trim();
    if (c.coverageStatus === "supported" && gap !== "" && gap !== "none") {
      bad("coverageStatus 'supported' requires missingCapability '' or 'none'");
    }
    if (c.coverageStatus !== "supported" && (gap === "" || gap === "none")) {
      bad(`coverageStatus '${String(c.coverageStatus)}' requires a concrete missingCapability gap note`);
    }
  }
  if (
    AFTER_SALES_UNSUPPORTED_COVERAGE.includes(c.coverageStatus as never) &&
    c.expectedPolicyDecision === "auto_execute"
  ) {
    bad(`coverageStatus '${String(c.coverageStatus)}' must never expect auto_execute`);
  }
  if (typeof c.expectedCustomerOutcome !== "string" || !c.expectedCustomerOutcome.trim()) {
    bad("expectedCustomerOutcome missing");
  }
  return problems;
}

export interface AfterSalesDataset {
  cases: AfterSalesCase[];
  byScenario: Record<string, AfterSalesCase[]>;
}

export function loadAfterSalesDataset(dir = casesDir()): AfterSalesDataset {
  const problems: string[] = [];
  const raw = JSON.parse(readFileSync(join(dir, AFTER_SALES_FILE), "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`eval dataset is invalid:\n  - ${AFTER_SALES_FILE}: top level must be an array`);
  }
  const cases: AfterSalesCase[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    problems.push(...validateAfterSalesCase(entry, AFTER_SALES_FILE));
    const c = entry as AfterSalesCase;
    if (seen.has(c.id)) problems.push(`${AFTER_SALES_FILE}: duplicate case id ${c.id}`);
    seen.add(c.id);
    cases.push(c);
  }
  if (cases.length !== AFTER_SALES_CASE_COUNT) {
    problems.push(`${AFTER_SALES_FILE}: expected ${AFTER_SALES_CASE_COUNT} cases, got ${cases.length}`);
  }
  for (const scenario of AFTER_SALES_SCENARIOS) {
    if (!cases.some((c) => c.scenario === scenario)) {
      problems.push(`${AFTER_SALES_FILE}: scenario '${scenario}' has no cases`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`eval dataset is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const byScenario: Record<string, AfterSalesCase[]> = {};
  for (const c of cases) {
    (byScenario[c.scenario] ??= []).push(c);
  }
  return { cases, byScenario };
}
