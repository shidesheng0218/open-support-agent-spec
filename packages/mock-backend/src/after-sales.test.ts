import { describe, expect, it } from "vitest";
import {
  AdapterNotFoundError,
  type Principal,
  type ToolContext,
} from "@osas/adapter";
import type { ActionProposal } from "@osas/core";
import { createDemoFixtures, DEMO_TENANT_ID } from "./fixtures.js";
import { MockSupportAdapter } from "./mock-adapter.js";

/**
 * After-sales top-10 fixture coverage (v0.2 Phase 6): every scenario in
 * evals/cases/after-sales-top10.json must resolve to the right fixture
 * object/status, and exchange_request execution must fail closed.
 */

const ctx = (permission: Principal["permission"] = "execute"): ToolContext => ({
  tenantId: DEMO_TENANT_ID,
  principal: { actorType: "model", actorId: "test-model", permission },
});

describe("after-sales fixtures resolve via MockSupportAdapter", () => {
  it("WISMO: in-transit order with a future ETA", async () => {
    const adapter = new MockSupportAdapter();
    const order = await adapter.getOrder(ctx("read"), "ord_in_transit");
    const shipment = await adapter.getShipment(ctx("read"), "shp_in_transit");
    expect(order.status).toBe("shipped");
    expect(shipment.status).toBe("in_transit");
    expect(shipment.orderId).toBe(order.id);
    expect(Date.parse(shipment.eta!)).toBeGreaterThan(Date.now());
  });

  it("delayed delivery: shipment past its ETA with an open 'delayed' incident", async () => {
    const adapter = new MockSupportAdapter();
    const shipment = await adapter.getShipment(ctx("read"), "shp_delayed");
    expect(shipment.status).toBe("in_transit");
    expect(Date.parse(shipment.eta!)).toBeLessThan(Date.now());
    const incident = await adapter.getShipmentIncident(ctx("read"), "inc_delayed");
    expect(incident).toMatchObject({
      orderId: "ord_delayed",
      shipmentId: "shp_delayed",
      incidentType: "delayed",
    });
    expect(Date.parse(incident.expectedAt!)).toBeLessThan(Date.now());
  });

  it("delivered-not-received: delivered carrier scan + delivered_not_received incident", async () => {
    const adapter = new MockSupportAdapter();
    const shipment = await adapter.getShipment(ctx("read"), "shp_large");
    expect(shipment.status).toBe("delivered");
    expect(shipment.orderId).toBe("ord_large");
    const incident = await adapter.getShipmentIncident(ctx("read"), "inc_dnr_large");
    expect(incident).toMatchObject({
      orderId: "ord_large",
      shipmentId: "shp_large",
      incidentType: "delivered_not_received",
      status: "investigating",
    });
  });

  it("missing item: multi-line order with exactly one missing line", async () => {
    const adapter = new MockSupportAdapter();
    const order = await adapter.getOrder(ctx("read"), "ord_multiline");
    expect(order.items).toHaveLength(3);
    // The seeded claim targets exactly one line of the order.
    const f = createDemoFixtures();
    const claim = f.itemClaims.find((c) => c.id === "claim_missing_cable");
    expect(claim).toMatchObject({
      orderId: "ord_multiline",
      lineId: "sku_cable",
      claimType: "missing_item",
      quantity: 1,
      status: "submitted",
    });
    expect(order.items.some((i) => i.sku === claim!.lineId)).toBe(true);
  });

  it("damaged item with image evidence resolvable via getOrderLineClaimEvidence", async () => {
    const adapter = new MockSupportAdapter();
    const evidence = await adapter.getOrderLineClaimEvidence!(ctx("read"), {
      orderId: "ord_damaged",
      lineId: "sku_vase",
    });
    expect(evidence.map((e) => e.id).sort()).toEqual(["ev_damaged_photo1", "ev_damaged_photo2"]);
    for (const e of evidence) {
      expect(e.data.mediaType).toBe("image/jpeg");
      expect(String(e.data.imageUrl)).toContain("example.com");
    }
    const f = createDemoFixtures();
    const claim = f.itemClaims.find((c) => c.id === "claim_damaged_vase");
    expect(claim).toMatchObject({ claimType: "damaged", orderId: "ord_damaged" });
    expect(claim?.evidenceIds?.sort()).toEqual(["ev_damaged_photo1", "ev_damaged_photo2"]);
  });

  it("wrong SKU shipped: wrong_item claim on the ordered line", async () => {
    const f = createDemoFixtures();
    const claim = f.itemClaims.find((c) => c.id === "claim_wrong_sku");
    expect(claim).toMatchObject({
      orderId: "ord_wrong_sku",
      lineId: "sku_mug",
      claimType: "wrong_item",
      status: "submitted",
    });
    const adapter = new MockSupportAdapter();
    const order = await adapter.getOrder(ctx("read"), "ord_wrong_sku");
    expect(order.items[0]?.sku).toBe("sku_mug");
  });

  it("proposeItemClaim records a submitted claim for human review (never resolves)", async () => {
    const adapter = new MockSupportAdapter();
    const claim = await adapter.proposeItemClaim!(ctx("draft"), {
      caseId: "case_refund",
      orderId: "ord_multiline",
      lineId: "sku_cable",
      claimType: "missing_item",
      quantity: 1,
      evidenceIds: [],
      idempotencyKey: "idem_claim_test_1",
    });
    expect(claim.id).toMatch(/^claim_\d+$/);
    expect(claim.status).toBe("submitted");
    expect(claim.orderId).toBe("ord_multiline");
    await expect(
      adapter.proposeItemClaim!(ctx("draft"), {
        caseId: "case_refund",
        orderId: "ord_missing",
        lineId: "sku_x",
        claimType: "damaged",
        quantity: 1,
        idempotencyKey: "idem_claim_test_2",
      }),
    ).rejects.toBeInstanceOf(AdapterNotFoundError);
  });

  it("refund status: processing refund for ord_refund_processing", async () => {
    const adapter = new MockSupportAdapter();
    const refunds = await adapter.getRefundStatus!(ctx("read"), "ord_refund_processing");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ id: "rft_processing", status: "processing" });
  });

  it("refund status: failed refund carries a failureCode", async () => {
    const adapter = new MockSupportAdapter();
    const refunds = await adapter.getRefundStatus!(ctx("read"), "ord_refund_failed");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      id: "rft_failed",
      status: "failed",
      failureCode: "card_expired",
    });
  });

  it("cancellable window: unshipped paid order vs already-shipped order", async () => {
    const adapter = new MockSupportAdapter();
    expect((await adapter.getOrder(ctx("read"), "ord_unshipped")).status).toBe("paid");
    expect((await adapter.getOrder(ctx("read"), "ord_shipped_window")).status).toBe("shipped");
    const shipment = await adapter.getShipment(ctx("read"), "shp_window");
    expect(shipment.orderId).toBe("ord_shipped_window");
    expect(shipment.status).toBe("in_transit");
  });

  it("exchange eligibility: in-stock replacement is eligible, out-of-stock is not, unknown fails closed", async () => {
    const adapter = new MockSupportAdapter();
    const inStock = await adapter.getExchangeEligibility!(ctx("read"), {
      orderId: "ord_exch_instock",
      originalLineId: "sku_shirt_m",
      replacementSku: "sku_shirt_l",
    });
    expect(inStock).toMatchObject({
      eligible: true,
      inventoryStatus: "in_stock",
      priceDelta: { currency: "USD", minorUnits: 0 },
    });
    const oos = await adapter.getExchangeEligibility!(ctx("read"), {
      orderId: "ord_exch_oos",
      originalLineId: "sku_cap",
      replacementSku: "sku_cap_red",
    });
    expect(oos.eligible).toBe(false);
    expect(oos.inventoryStatus).toBe("out_of_stock");
    expect(oos.reason).toContain("out_of_stock");
    const unknown = await adapter.getExchangeEligibility!(ctx("read"), {
      orderId: "ord_exch_instock",
      originalLineId: "sku_shirt_m",
      replacementSku: "sku_nonexistent",
    });
    expect(unknown).toMatchObject({ eligible: false, inventoryStatus: "unknown" });
  });

  it("exchange requests are readable; exchange_request execution fails closed", async () => {
    const adapter = new MockSupportAdapter();
    const exr = await adapter.getExchangeRequest!(ctx("read"), "exr_oos");
    expect(exr).toMatchObject({ inventoryStatus: "out_of_stock", status: "proposed" });

    const ts = new Date().toISOString();
    const exchangeProposal: ActionProposal = {
      id: "prop_exch_test",
      specVersion: "0.2",
      tenantId: DEMO_TENANT_ID,
      caseId: "case_refund",
      profile: "ecommerce",
      actionType: "exchange_request",
      reasonCode: "size_exchange",
      params: {
        orderId: "ord_exch_instock",
        originalLineId: "sku_shirt_m",
        replacementSku: "sku_shirt_l",
      },
      requestedPermission: "request-approval",
      requestedBy: { actorType: "model", actorId: "test-model" },
      amount: { currency: "USD", minorUnits: 0 },
      evidenceIds: ["ev_ord_small"],
      idempotencyKey: "idem_exch_test",
      status: "approved",
      createdAt: ts,
      updatedAt: ts,
    };
    // Even with an approved proposal, the adapter never executes an exchange.
    const result = await adapter.executeAction(ctx("execute"), exchangeProposal);
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("never adapter-executed");
    // And the original order is untouched.
    expect((await adapter.getOrder(ctx("read"), "ord_exch_instock")).status).toBe("delivered");
  });
});
