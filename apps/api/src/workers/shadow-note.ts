import type { ActionProposal, Money, PolicyDecision, ShadowRun } from "@osas/core";

/**
 * Private-note bodies the shadow worker writes into the helpdesk.
 *
 * Plain text on purpose: helpdesks render notes inconsistently, and the note
 * must stay readable in an email digest. Notes carry ids and policy reasons,
 * never customer message content or contact details.
 */

export function formatMoney(m: Money): string {
  try {
    const fmt = new Intl.NumberFormat("en", { style: "currency", currency: m.currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(m.minorUnits / 10 ** digits);
  } catch {
    // Unknown currency code: show the raw minor units rather than guess a scale.
    return `${m.currency} ${m.minorUnits} (minor units)`;
  }
}

const VERDICT: Record<PolicyDecision["decision"], string> = {
  auto_execute: "policy would allow automatic execution",
  require_approval: "needs human approval",
  block: "blocked by policy",
};

export function composeShadowNote(input: {
  proposal: ActionProposal;
  decision: PolicyDecision;
  run: ShadowRun;
  evidenceSummary: string;
  /** True only when an order system was actually read for this proposal. */
  orderChecked?: boolean;
}): string {
  const { proposal, decision, run, evidenceSummary, orderChecked = false } = input;
  const amount = proposal.amount ? ` ${formatMoney(proposal.amount)}` : "";
  const lines = [
    `[OSAS shadow] Suggested: ${proposal.actionType}${amount} (reason: ${proposal.reasonCode})`,
    `Policy v${decision.policyVersion}: ${VERDICT[decision.decision]}`,
    ...decision.reasons.map((r) => `  - ${r.code}: ${r.message}`),
    `Evidence: ${evidenceSummary}`,
    orderChecked
      ? "Order data was read from the order system. Identity and region are still unverified."
      : "Not verified against any order system. Check the order before acting.",
    "Shadow mode: nothing has been executed.",
    `Refs: proposal ${proposal.id} / shadow run ${run.id}`,
  ];
  return lines.join("\n");
}

export function composeInjectionNote(eventId: string): string {
  return [
    "[OSAS shadow] No suggestion generated.",
    "The recent customer messages look like a prompt-injection attempt, so they were not sent to a model.",
    "A human should handle this conversation.",
    `Refs: event ${eventId}`,
  ].join("\n");
}
