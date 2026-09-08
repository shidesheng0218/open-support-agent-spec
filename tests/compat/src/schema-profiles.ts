import { describe, expect, test } from "vitest";
import { evaluateProposal } from "@osas/policy-engine";
import { ReportCollector, runCase } from "./report.js";
import { clone, loadFixture, setAtPath, validateAgainst, withoutKey } from "./helpers.js";
import {
  customerById,
  freshEvidence,
  loadDemo,
  makeProposal,
  reasonCodes,
} from "./demo.js";

const SUITE = "schema-profiles";

const S_ORDER = "profiles/ecommerce/order";
const S_SHIPMENT = "profiles/ecommerce/shipment";
const S_SUBSCRIPTION = "profiles/saas/subscription";
const S_INVOICE = "profiles/saas/invoice";
const S_CREDIT_BALANCE = "profiles/saas/credit-balance";
const S_ACTION_PROPOSAL = "core/action-proposal";

type JsonObject = Record<string, unknown>;

function fixture(name: string): JsonObject {
  const f = loadFixture(name);
  if (!f) throw new Error(`missing valid fixture fixtures/valid/${name}.json`);
  return f;
}

export function registerSchemaProfiles(collector: ReportCollector): void {
  describe(SUITE, () => {
    // --- ecommerce: order ---------------------------------------------------
    test("order: valid fixture passes", () =>
      runCase(collector, SUITE, "order: valid fixture passes", () => {
        expect(validateAgainst(S_ORDER, fixture("order"))).toBe(true);
      }));

    test("order: bad status enum rejected", () =>
      runCase(collector, SUITE, "order: bad status enum rejected", () => {
        const bad = { ...clone(fixture("order")), status: "lost_in_space" };
        expect(validateAgainst(S_ORDER, bad)).toBe(false);
      }));

    test("order: missing items rejected", () =>
      runCase(collector, SUITE, "order: missing items rejected", () => {
        expect(validateAgainst(S_ORDER, withoutKey(fixture("order"), "items"))).toBe(false);
      }));

    test("order: float unitPrice.minorUnits rejected", () =>
      runCase(collector, SUITE, "order: float unitPrice.minorUnits rejected", () => {
        const bad = clone(fixture("order"));
        setAtPath(bad, "items[].unitPrice.minorUnits", 25.5);
        expect(validateAgainst(S_ORDER, bad)).toBe(false);
      }));

    // --- ecommerce: shipment --------------------------------------------------
    test("shipment: valid fixture passes", () =>
      runCase(collector, SUITE, "shipment: valid fixture passes", () => {
        expect(validateAgainst(S_SHIPMENT, fixture("shipment"))).toBe(true);
      }));

    test("shipment: bad status enum rejected", () =>
      runCase(collector, SUITE, "shipment: bad status enum rejected", () => {
        const bad = { ...clone(fixture("shipment")), status: "teleported" };
        expect(validateAgainst(S_SHIPMENT, bad)).toBe(false);
      }));

    // --- saas: subscription ---------------------------------------------------
    test("subscription: valid fixture passes", () =>
      runCase(collector, SUITE, "subscription: valid fixture passes", () => {
        expect(validateAgainst(S_SUBSCRIPTION, fixture("subscription"))).toBe(true);
      }));

    test("subscription: missing mrr rejected", () =>
      runCase(collector, SUITE, "subscription: missing mrr rejected", () => {
        expect(validateAgainst(S_SUBSCRIPTION, withoutKey(fixture("subscription"), "mrr"))).toBe(
          false,
        );
      }));

    test("subscription: bad status enum rejected", () =>
      runCase(collector, SUITE, "subscription: bad status enum rejected", () => {
        const bad = { ...clone(fixture("subscription")), status: "zombie" };
        expect(validateAgainst(S_SUBSCRIPTION, bad)).toBe(false);
      }));

    // --- saas: invoice --------------------------------------------------------
    test("invoice: valid fixture passes", () =>
      runCase(collector, SUITE, "invoice: valid fixture passes", () => {
        expect(validateAgainst(S_INVOICE, fixture("invoice"))).toBe(true);
      }));

    test("invoice: float amount.minorUnits rejected", () =>
      runCase(collector, SUITE, "invoice: float amount.minorUnits rejected", () => {
        const bad = clone(fixture("invoice"));
        setAtPath(bad, "amount.minorUnits", 99.99);
        expect(validateAgainst(S_INVOICE, bad)).toBe(false);
      }));

    // --- saas: credit-balance ---------------------------------------------------
    test("credit-balance: valid fixture passes", () =>
      runCase(collector, SUITE, "credit-balance: valid fixture passes", () => {
        expect(validateAgainst(S_CREDIT_BALANCE, fixture("credit-balance"))).toBe(true);
      }));

    test("credit-balance: missing customerId rejected", () =>
      runCase(collector, SUITE, "credit-balance: missing customerId rejected", () => {
        expect(
          validateAgainst(S_CREDIT_BALANCE, withoutKey(fixture("credit-balance"), "customerId")),
        ).toBe(false);
      }));

    // --- ecommerce: after-sales objects (v0.2 Phase 4) ------------------------
    test("shipment-incident: valid fixture passes", () =>
      runCase(collector, SUITE, "shipment-incident: valid fixture passes", () => {
        expect(validateAgainst("profiles/ecommerce/shipment-incident", fixture("shipment-incident"))).toBe(true);
      }));

    test("shipment-incident: bad incidentType enum rejected", () =>
      runCase(collector, SUITE, "shipment-incident: bad incidentType rejected", () => {
        const bad = { ...clone(fixture("shipment-incident")), incidentType: "vanished" };
        expect(validateAgainst("profiles/ecommerce/shipment-incident", bad)).toBe(false);
      }));

    test("refund-transaction: valid fixture passes", () =>
      runCase(collector, SUITE, "refund-transaction: valid fixture passes", () => {
        expect(validateAgainst("profiles/ecommerce/refund-transaction", fixture("refund-transaction"))).toBe(true);
      }));

    test("refund-transaction: bad status enum rejected", () =>
      runCase(collector, SUITE, "refund-transaction: bad status rejected", () => {
        const bad = { ...clone(fixture("refund-transaction")), status: "mysterious" };
        expect(validateAgainst("profiles/ecommerce/refund-transaction", bad)).toBe(false);
      }));

    test("item-claim: valid fixture passes", () =>
      runCase(collector, SUITE, "item-claim: valid fixture passes", () => {
        expect(validateAgainst("profiles/ecommerce/item-claim", fixture("item-claim"))).toBe(true);
      }));

    test("item-claim: quantity 0 rejected", () =>
      runCase(collector, SUITE, "item-claim: quantity 0 rejected", () => {
        const bad = { ...clone(fixture("item-claim")), quantity: 0 };
        expect(validateAgainst("profiles/ecommerce/item-claim", bad)).toBe(false);
      }));

    test("exchange-request: valid fixture passes (negative priceDelta allowed)", () =>
      runCase(collector, SUITE, "exchange-request: valid fixture passes", () => {
        expect(validateAgainst("profiles/ecommerce/exchange-request", fixture("exchange-request"))).toBe(true);
      }));

    test("exchange-request: float priceDelta.minorUnits rejected", () =>
      runCase(collector, SUITE, "exchange-request: float priceDelta rejected", () => {
        const bad = clone(fixture("exchange-request"));
        setAtPath(bad, "priceDelta.minorUnits", 2.5);
        expect(validateAgainst("profiles/ecommerce/exchange-request", bad)).toBe(false);
      }));

    test("exchange_request proposal: require_approval with demo policy, block without evidence", () =>
      runCase(collector, SUITE, "exchange_request policy behavior", () => {
        const demo = loadDemo();
        const proposal = makeProposal({
          profile: "ecommerce",
          actionType: "exchange_request",
          reasonCode: "wrong_item",
          params: { orderId: "ord_small", originalLineId: "line_1", replacementSku: "sku_mug_v2" },
          evidenceIds: [freshEvidence(demo).id],
        });
        const approved = evaluateProposal(proposal as never, {
          customer: customerById(demo, "cus_verified"),
          evidence: [freshEvidence(demo)],
          policy: demo.policy,
          recentProposals: [],
          injectionSuspected: false,
        } as never) as unknown as JsonObject;
        expect(approved.decision).toBe("require_approval");

        const noEvidence = evaluateProposal(
          { ...proposal, evidenceIds: [] } as never,
          {
            customer: customerById(demo, "cus_verified"),
            evidence: [],
            policy: demo.policy,
            recentProposals: [],
            injectionSuspected: false,
          } as never,
        ) as unknown as JsonObject;
        expect(noEvidence.decision).toBe("block");
        expect(reasonCodes(noEvidence)).toContain("INSUFFICIENT_EVIDENCE");
      }));

    // --- cross-profile rule -----------------------------------------------------
    test("cross-profile: ecommerce proposal with saas actionType rejected", () =>
      runCase(
        collector,
        SUITE,
        "cross-profile: profile=ecommerce + actionType=credit_apply rejected",
        () => {
          const demo = loadDemo();
          const proposal = makeProposal({
            profile: "ecommerce",
            actionType: "credit_apply",
            reasonCode: "goodwill",
            amount: { currency: "USD", minorUnits: 1000 },
            evidenceIds: [freshEvidence(demo).id],
          });

          // Prefer schema-level rejection if the schema expresses the rule.
          const rejectedBySchema = !validateAgainst(S_ACTION_PROPOSAL, proposal);

          const decision = evaluateProposal(proposal as never, {
            customer: customerById(demo, "cus_verified"),
            evidence: [freshEvidence(demo)],
            policy: demo.policy,
            recentProposals: [],
            injectionSuspected: false,
          } as never) as unknown as JsonObject;

          const rejectedByPolicy =
            decision.decision === "block" && reasonCodes(decision).includes("PROFILE_MISMATCH");

          expect(
            rejectedBySchema || rejectedByPolicy,
            "cross-profile proposal must be rejected by schema or by policy (PROFILE_MISMATCH)",
          ).toBe(true);
        },
      ));
  });
}
