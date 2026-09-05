import { describe, expect, test } from "vitest";
import {
  canTransitionCase,
  canTransitionProposal,
  transitionCase,
  transitionProposal,
} from "@osas/core";
import { ReportCollector, runCase } from "./report.js";
import { clone, loadFixture } from "./helpers.js";
import { makeProposal } from "./demo.js";

const SUITE = "state-machines";

const CASE_TRANSITIONS: Record<string, string[]> = {
  open: ["pending_agent", "pending_customer", "closed"],
  pending_agent: ["pending_customer", "resolved", "closed"],
  pending_customer: ["pending_agent", "resolved", "closed"],
  resolved: ["pending_agent", "closed"],
  closed: [],
};

const PROPOSAL_TRANSITIONS: Record<string, string[]> = {
  proposed: ["policy_rejected", "pending_approval", "approved"],
  pending_approval: ["approved", "rejected"],
  approved: ["executing"],
  executing: ["executed", "failed", "reconciliation_required"],
  reconciliation_required: ["executed", "failed"],
  policy_rejected: [],
  rejected: [],
  executed: [],
  failed: [],
};

function caseWith(status: string): Record<string, unknown> {
  const base = loadFixture("case");
  if (!base) throw new Error("missing fixtures/valid/case.json");
  return { ...clone(base), status };
}

function proposalWith(status: string): Record<string, unknown> {
  return makeProposal({ status });
}

export function registerStateMachines(collector: ReportCollector): void {
  describe(SUITE, () => {
    for (const [from, targets] of Object.entries(CASE_TRANSITIONS)) {
      for (const to of targets) {
        test(`case ${from} -> ${to} is legal`, () =>
          runCase(collector, SUITE, `case ${from} -> ${to} legal`, () => {
            expect(canTransitionCase(from as never, to as never)).toBe(true);
            const next = transitionCase(caseWith(from) as never, to as never) as unknown as Record<
              string,
              unknown
            >;
            expect(next.status).toBe(to);
          }));
      }
      const illegal = Object.keys(CASE_TRANSITIONS).filter((s) => !targets.includes(s));
      test(`case ${from} -> {${illegal.join(",")}} illegal`, () =>
        runCase(collector, SUITE, `case ${from}: ${illegal.length} illegal transitions throw`, () => {
          for (const to of illegal) {
            expect(canTransitionCase(from as never, to as never), `${from}->${to}`).toBe(false);
            expect(() => transitionCase(caseWith(from) as never, to as never)).toThrow();
          }
        }));
    }

    for (const [from, targets] of Object.entries(PROPOSAL_TRANSITIONS)) {
      for (const to of targets) {
        test(`proposal ${from} -> ${to} is legal`, () =>
          runCase(collector, SUITE, `proposal ${from} -> ${to} legal`, () => {
            expect(canTransitionProposal(from as never, to as never)).toBe(true);
            const next = transitionProposal(proposalWith(from) as never, to as never) as unknown as Record<
              string,
              unknown
            >;
            expect(next.status).toBe(to);
          }));
      }
      const illegal = Object.keys(PROPOSAL_TRANSITIONS).filter((s) => !targets.includes(s));
      test(`proposal ${from} -> {${illegal.join(",")}} illegal`, () =>
        runCase(
          collector,
          SUITE,
          `proposal ${from}: ${illegal.length} illegal transitions throw`,
          () => {
            for (const to of illegal) {
              expect(canTransitionProposal(from as never, to as never), `${from}->${to}`).toBe(
                false,
              );
              expect(() =>
                transitionProposal(proposalWith(from) as never, to as never),
              ).toThrow();
            }
          },
        ));
    }
  });
}
