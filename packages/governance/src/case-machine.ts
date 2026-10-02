import { GovernanceTransitionError } from "./errors.js";
import type { GovernedCaseState } from "./types.js";

/**
 * Deterministic governed-case state machine (M0).
 *
 * It mirrors the OSAS proposal lifecycle rather than replacing it: "proposed"
 * and "pending_approval" exist here only to make the case timeline visible in
 * one place, while the authoritative proposal/approval records stay in the
 * v0.2 runtime.
 *
 * Terminal states have no outgoing edges. "reconciliation_required" is NOT
 * terminal: an uncertain outcome must stay reachable by a human.
 */
export const GOVERNED_CASE_TRANSITIONS: Readonly<
  Record<GovernedCaseState, readonly GovernedCaseState[]>
> = {
  intake: ["evidence_required", "proposed", "blocked"],
  evidence_required: ["proposed", "blocked"],
  proposed: ["pending_approval", "executing", "blocked"],
  pending_approval: ["executing", "blocked", "proposed"],
  executing: ["resolved", "reconciliation_required", "blocked"],
  reconciliation_required: ["resolved", "executing", "blocked"],
  resolved: [],
  blocked: ["intake", "evidence_required"],
};

export const TERMINAL_CASE_STATES: readonly GovernedCaseState[] = ["resolved"];

export function canTransition(from: GovernedCaseState, to: GovernedCaseState): boolean {
  return GOVERNED_CASE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: GovernedCaseState, to: GovernedCaseState): void {
  if (!canTransition(from, to)) throw new GovernanceTransitionError(from, to);
}

export function isTerminal(state: GovernedCaseState): boolean {
  return GOVERNED_CASE_TRANSITIONS[state].length === 0;
}
