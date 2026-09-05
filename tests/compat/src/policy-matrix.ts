import { describe, expect, test } from "vitest";
import { evaluateProposal } from "@osas/policy-engine";
import { ReportCollector, runCase } from "./report.js";
import {
  customerById,
  expiredEvidence,
  freshEvidence,
  loadDemo,
  makeProposal,
  reasonCodes,
  type DemoData,
} from "./demo.js";

const SUITE = "policy-matrix";

type Any = Record<string, unknown>;

interface CtxOverrides {
  customer?: Any;
  evidence?: Any[];
  recentProposals?: Any[];
  injectionSuspected?: boolean;
}

function evaluate(demo: DemoData, proposal: Any, over: CtxOverrides = {}): Any {
  return evaluateProposal(proposal as never, {
    customer: over.customer ?? customerById(demo, "cus_verified"),
    evidence: over.evidence ?? [freshEvidence(demo)],
    policy: demo.policy,
    recentProposals: over.recentProposals ?? [],
    injectionSuspected: over.injectionSuspected ?? false,
  } as never) as unknown as Any;
}

function baseRefund(demo: DemoData, overrides: Any = {}): Any {
  return makeProposal({
    evidenceIds: [freshEvidence(demo).id as string],
    ...overrides,
  });
}

export function registerPolicyMatrix(collector: ReportCollector): void {
  describe(SUITE, () => {
    const demo = loadDemo();

    test("small refund under threshold -> auto_execute", () =>
      runCase(collector, SUITE, "auto: small refund ($25 <= $50) auto_execute", () => {
        const d = evaluate(demo, baseRefund(demo));
        expect(d.decision).toBe("auto_execute");
      }));

    test("over-threshold refund -> require_approval (OVER_THRESHOLD)", () =>
      runCase(collector, SUITE, "over-threshold $900 refund -> require_approval", () => {
        const d = evaluate(
          demo,
          baseRefund(demo, {
            params: { orderId: "ord_large" },
            amount: { currency: "USD", minorUnits: 90000 },
          }),
        );
        expect(d.decision).toBe("require_approval");
        expect(reasonCodes(d)).toContain("OVER_THRESHOLD");
      }));

    test("unverified identity -> block", () =>
      runCase(collector, SUITE, "unverified identity -> block", () => {
        const d = evaluate(demo, baseRefund(demo), {
          customer: customerById(demo, "cus_unverified"),
        });
        expect(d.decision).toBe("block");
        expect(reasonCodes(d)).toSatisfy((codes: string[]) =>
          codes.some((c) => c === "IDENTITY_UNVERIFIED" || c === "IDENTITY_REQUIRED"),
        );
      }));

    test("expired identity -> block", () =>
      runCase(collector, SUITE, "expired identity -> block", () => {
        const d = evaluate(demo, baseRefund(demo), {
          customer: customerById(demo, "cus_expired"),
        });
        expect(d.decision).toBe("block");
        expect(reasonCodes(d)).toSatisfy((codes: string[]) =>
          codes.some((c) => c === "IDENTITY_UNVERIFIED" || c === "IDENTITY_REQUIRED"),
        );
      }));

    test("stale evidence -> require_approval (EVIDENCE_STALE)", () =>
      runCase(collector, SUITE, "stale evidence -> require_approval", () => {
        const stale = expiredEvidence(demo);
        const d = evaluate(demo, baseRefund(demo, { evidenceIds: [stale.id as string] }), {
          evidence: [stale],
        });
        expect(d.decision).toBe("require_approval");
        expect(reasonCodes(d)).toContain("EVIDENCE_STALE");
      }));

    test("blocked region (IR) -> block (REGION_BLOCKED)", () =>
      runCase(collector, SUITE, "blocked region IR -> block", () => {
        const d = evaluate(demo, baseRefund(demo), {
          customer: customerById(demo, "cus_blocked"),
        });
        expect(d.decision).toBe("block");
        expect(reasonCodes(d)).toContain("REGION_BLOCKED");
      }));

    test("model execute overreach -> block (PERMISSION_OVERREACH)", () =>
      runCase(collector, SUITE, "model requestedPermission=execute -> block", () => {
        const d = evaluate(demo, baseRefund(demo, { requestedPermission: "execute" }));
        expect(d.decision).toBe("block");
        expect(reasonCodes(d)).toContain("PERMISSION_OVERREACH");
      }));

    test("prompt injection suspected -> block (PROMPT_INJECTION_SUSPECTED)", () =>
      runCase(collector, SUITE, "injection suspected -> block", () => {
        const d = evaluate(demo, baseRefund(demo), { injectionSuspected: true });
        expect(d.decision).toBe("block");
        expect(reasonCodes(d)).toContain("PROMPT_INJECTION_SUSPECTED");
      }));

    test("duplicate request -> block (DUPLICATE_REQUEST)", () =>
      runCase(collector, SUITE, "duplicate refund -> block", () => {
        const prior = makeProposal({ status: "executed" });
        const d = evaluate(demo, baseRefund(demo), { recentProposals: [prior] });
        expect(d.decision).toBe("block");
        expect(reasonCodes(d)).toContain("DUPLICATE_REQUEST");
      }));

    test("reason code not allowed -> block (REASON_CODE_NOT_ALLOWED)", () =>
      runCase(collector, SUITE, "reasonCode not in rule -> block", () => {
        const d = evaluate(demo, baseRefund(demo, { reasonCode: "because_i_said_so" }));
        expect(d.decision).toBe("block");
        expect(reasonCodes(d)).toContain("REASON_CODE_NOT_ALLOWED");
      }));

    test("currency mismatch vs rule maxAmount -> require_approval (CURRENCY_MISMATCH)", () =>
      runCase(collector, SUITE, "currency mismatch -> require_approval", () => {
        const d = evaluate(
          demo,
          baseRefund(demo, { amount: { currency: "EUR", minorUnits: 2500 } }),
        );
        expect(d.decision).toBe("require_approval");
        expect(reasonCodes(d)).toContain("CURRENCY_MISMATCH");
      }));
  });
}
