import { describe, expect, it } from "vitest";
import {
  CASE_STATUSES,
  CASE_TRANSITIONS,
  Case,
  CaseStatus,
  IllegalTransitionError,
  PROPOSAL_STATUSES,
  PROPOSAL_TRANSITIONS,
  ProposalStatus,
  ActionProposal,
  canTransitionCase,
  canTransitionProposal,
  transitionCase,
  transitionProposal,
} from "./index.js";

function makeCase(status: CaseStatus): Case {
  return {
    id: "case_1",
    specVersion: "0.2",
    tenantId: "tenant_demo",
    customerId: "cus_1",
    profile: "core",
    channel: "api",
    subject: "s",
    status,
    priority: "normal",
    assigneeType: "agent",
    tags: [],
    evidenceIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeProposal(status: ProposalStatus): ActionProposal {
  return {
    id: "prop_1",
    specVersion: "0.2",
    tenantId: "tenant_demo",
    caseId: "case_1",
    profile: "ecommerce",
    actionType: "refund",
    reasonCode: "damaged",
    params: {},
    requestedPermission: "request-approval",
    requestedBy: { actorType: "model", actorId: "m1" },
    evidenceIds: ["ev_1"],
    idempotencyKey: "k1",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("case transitions", () => {
  it("allows every edge declared in CASE_TRANSITIONS", () => {
    for (const from of CASE_STATUSES) {
      for (const to of CASE_TRANSITIONS[from]) {
        expect(canTransitionCase(from, to)).toBe(true);
        const next = transitionCase(makeCase(from), to);
        expect(next.status).toBe(to);
      }
    }
  });

  it("rejects every edge not declared in CASE_TRANSITIONS", () => {
    for (const from of CASE_STATUSES) {
      for (const to of CASE_STATUSES) {
        if (!CASE_TRANSITIONS[from].includes(to)) {
          expect(canTransitionCase(from, to)).toBe(false);
          expect(() => transitionCase(makeCase(from), to)).toThrow(IllegalTransitionError);
        }
      }
    }
  });

  it("closed is terminal", () => {
    expect(CASE_TRANSITIONS.closed).toEqual([]);
    expect(() => transitionCase(makeCase("closed"), "open")).toThrow(IllegalTransitionError);
  });

  it("sets closedAt when transitioning to closed", () => {
    const next = transitionCase(makeCase("open"), "closed");
    expect(next.closedAt).toBeDefined();
    expect(next.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("proposal transitions", () => {
  it("allows every edge declared in PROPOSAL_TRANSITIONS", () => {
    for (const from of PROPOSAL_STATUSES) {
      for (const to of PROPOSAL_TRANSITIONS[from]) {
        expect(canTransitionProposal(from, to)).toBe(true);
        expect(transitionProposal(makeProposal(from), to).status).toBe(to);
      }
    }
  });

  it("rejects every edge not declared in PROPOSAL_TRANSITIONS", () => {
    for (const from of PROPOSAL_STATUSES) {
      for (const to of PROPOSAL_STATUSES) {
        if (!PROPOSAL_TRANSITIONS[from].includes(to)) {
          expect(canTransitionProposal(from, to)).toBe(false);
          expect(() => transitionProposal(makeProposal(from), to)).toThrow(IllegalTransitionError);
        }
      }
    }
  });

  it("terminal statuses have no outgoing edges (no blind retry)", () => {
    for (const s of ["policy_rejected", "rejected", "executed", "failed"] as const) {
      expect(PROPOSAL_TRANSITIONS[s]).toEqual([]);
    }
  });

  it("models the happy path proposed -> pending_approval -> approved -> executing -> executed", () => {
    let p = makeProposal("proposed");
    p = transitionProposal(p, "pending_approval");
    p = transitionProposal(p, "approved");
    p = transitionProposal(p, "executing");
    p = transitionProposal(p, "executed");
    expect(p.status).toBe("executed");
  });

  it("only allows reconciliation from reconciliation_required", () => {
    expect(canTransitionProposal("reconciliation_required", "executed")).toBe(true);
    expect(canTransitionProposal("reconciliation_required", "failed")).toBe(true);
    expect(canTransitionProposal("approved", "executed")).toBe(false);
  });
});
