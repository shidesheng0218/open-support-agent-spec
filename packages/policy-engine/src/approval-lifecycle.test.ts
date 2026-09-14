import { describe, expect, it } from "vitest";
import type { Approval } from "@osas/core";
import {
  APPROVAL_TIMED_OUT,
  evaluateApprovalExpiry,
  resolveApprovalDeadline,
} from "./approval-lifecycle.js";
import { FIXTURE_NOW, makePolicy } from "./fixtures.js";

function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: "ap_1",
    specVersion: "0.2",
    tenantId: "tenant_demo",
    proposalId: "prop_1",
    status: "pending",
    policyVersion: "1.0.0",
    requestedAt: FIXTURE_NOW.toISOString(),
    createdAt: FIXTURE_NOW.toISOString(),
    updatedAt: FIXTURE_NOW.toISOString(),
    ...over,
  };
}

const LATER = new Date(FIXTURE_NOW.getTime() + 400_000);

describe("resolveApprovalDeadline", () => {
  it("returns undefined when neither approval nor policy configures a deadline", () => {
    expect(resolveApprovalDeadline(makeApproval(), makePolicy())).toBeUndefined();
  });

  it("derives expiresAt from requestedAt + policy.approval.timeoutSeconds", () => {
    const policy = makePolicy();
    policy.approval = { timeoutSeconds: 300, onTimeout: "deny" };
    expect(resolveApprovalDeadline(makeApproval(), policy)).toBe(
      new Date(FIXTURE_NOW.getTime() + 300_000).toISOString(),
    );
  });

  it("prefers an explicit expiresAt over the policy timeout", () => {
    const policy = makePolicy();
    policy.approval = { timeoutSeconds: 300 };
    const explicit = new Date(FIXTURE_NOW.getTime() + 60_000).toISOString();
    expect(
      resolveApprovalDeadline(makeApproval({ expiresAt: explicit }), policy),
    ).toBe(explicit);
  });
});

describe("evaluateApprovalExpiry — fail-safe timeout", () => {
  it("keeps a pending approval without a deadline pending", () => {
    const result = evaluateApprovalExpiry(makeApproval(), makePolicy(), LATER);
    expect(result).toEqual({ status: "pending" });
  });

  it("keeps a pending approval within its timeout pending", () => {
    const policy = makePolicy();
    policy.approval = { timeoutSeconds: 600 };
    const result = evaluateApprovalExpiry(makeApproval(), policy, LATER);
    expect(result).toEqual({ status: "pending" });
  });

  it("a deadline exactly at `now` has not lapsed (strictly greater)", () => {
    const policy = makePolicy();
    policy.approval = { timeoutSeconds: 400 };
    const atDeadline = new Date(FIXTURE_NOW.getTime() + 400_000);
    expect(evaluateApprovalExpiry(makeApproval(), policy, atDeadline)).toEqual({
      status: "pending",
    });
  });

  it("expires a pending approval past its policy timeout (fail-safe deny)", () => {
    const policy = makePolicy();
    policy.approval = { timeoutSeconds: 300, onTimeout: "deny" };
    const result = evaluateApprovalExpiry(makeApproval(), policy, LATER);
    expect(result.status).toBe("expired");
    expect(result.reason?.code).toBe(APPROVAL_TIMED_OUT);
    expect(result.reason?.message).toMatch(/expired/);
  });

  it("expires against an explicit expiresAt even without policy config", () => {
    const expiredAt = new Date(FIXTURE_NOW.getTime() + 60_000).toISOString();
    const result = evaluateApprovalExpiry(
      makeApproval({ expiresAt: expiredAt }),
      makePolicy(),
      LATER,
    );
    expect(result.status).toBe("expired");
    expect(result.reason?.code).toBe(APPROVAL_TIMED_OUT);
  });

  it("never re-judges a decided approval, even past the deadline", () => {
    const policy = makePolicy();
    policy.approval = { timeoutSeconds: 300 };
    expect(
      evaluateApprovalExpiry(
        makeApproval({ status: "approved", decidedAt: FIXTURE_NOW.toISOString() }),
        policy,
        LATER,
      ),
    ).toEqual({ status: "approved" });
    expect(
      evaluateApprovalExpiry(
        makeApproval({ status: "rejected", decidedAt: FIXTURE_NOW.toISOString() }),
        policy,
        LATER,
      ),
    ).toEqual({ status: "rejected" });
  });

  it("passes an already-expired approval through unchanged", () => {
    const policy = makePolicy();
    policy.approval = { timeoutSeconds: 300 };
    const past = new Date(FIXTURE_NOW.getTime() - 10_000).toISOString();
    expect(
      evaluateApprovalExpiry(
        makeApproval({ status: "expired", expiresAt: past }),
        policy,
        LATER,
      ),
    ).toEqual({ status: "expired" });
  });
});
