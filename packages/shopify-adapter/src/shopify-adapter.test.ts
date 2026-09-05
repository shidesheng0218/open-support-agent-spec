import { describe, expect, it } from "vitest";
import type { ToolContext } from "@osas/adapter";
import { AdapterCapabilityError, AdapterNotFoundError } from "@osas/adapter";
import { shopifyConfigFromEnv } from "./config.js";
import { ShopifyNotConfiguredError } from "./errors.js";
import type { HttpClient, HttpRequest, HttpResponse } from "./http.js";
import { refundableAmount } from "./mappers.js";
import { ShopifyAdapter } from "./shopify-adapter.js";

const ctx: ToolContext = {
  tenantId: "tenant_demo",
  principal: { actorType: "system", actorId: "test", permission: "execute" },
};

const config = {
  shopDomain: "acme.myshopify.com",
  adminAccessToken: "shpat_test",
  apiVersion: "2025-01",
};

const order = {
  id: 555,
  name: "#1001",
  email: "jane@example.com",
  financial_status: "paid",
  fulfillment_status: "fulfilled",
  cancelled_at: null,
  currency: "USD",
  total_price: "129.99",
  customer: { id: 888, email: "jane@example.com" },
  shipping_address: { country_code: "US" },
  line_items: [{ id: 1, sku: "SKU-1", title: "Mug", quantity: 2, price: "64.995" }],
  refunds: [
    { id: 9, transactions: [{ kind: "refund", amount: "20.00", status: "success" }] },
  ],
  created_at: "2026-01-05T12:00:00Z",
};

const fulfillment = {
  id: 77,
  order_id: 555,
  status: "in_transit",
  tracking_company: "UPS",
  tracking_number: "1Z999",
  created_at: "2026-01-06T12:00:00Z",
};

function mockHttp(
  handler: (req: HttpRequest) => HttpResponse,
): { http: HttpClient; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const http: HttpClient = async (req) => {
    requests.push(req);
    return handler(req);
  };
  return { http, requests };
}

const okHandler = (req: HttpRequest): HttpResponse => {
  if (req.url.endsWith("/orders/555.json")) return { status: 200, body: { order } };
  if (req.url.endsWith("/orders/555/fulfillments.json")) {
    return { status: 200, body: { fulfillments: [fulfillment] } };
  }
  if (req.url.includes("/orders.json")) return { status: 200, body: { orders: [order] } };
  return { status: 404, body: { errors: "Not Found" } };
};

describe("shopifyConfigFromEnv (fail closed)", () => {
  it("throws SHOPIFY_NOT_CONFIGURED when credentials are missing", () => {
    expect(() => shopifyConfigFromEnv({})).toThrow(ShopifyNotConfiguredError);
    expect(() => shopifyConfigFromEnv({ SHOPIFY_SHOP_DOMAIN: "acme.myshopify.com" })).toThrow(
      /SHOPIFY_ADMIN_ACCESS_TOKEN/,
    );
  });

  it("normalizes the domain and pins a default API version", () => {
    const c = shopifyConfigFromEnv({
      SHOPIFY_SHOP_DOMAIN: "https://acme.myshopify.com/",
      SHOPIFY_ADMIN_ACCESS_TOKEN: "t",
    });
    expect(c.shopDomain).toBe("acme.myshopify.com");
    expect(c.apiVersion).toBe("2025-01");
  });
});

describe("ShopifyAdapter reads + mapping", () => {
  it("maps an order to OSAS Order with integer minor units", async () => {
    const { http, requests } = mockHttp(okHandler);
    const adapter = new ShopifyAdapter({ config, http });
    const o = await adapter.getOrder(ctx, "shopify_order_555");
    expect(o.id).toBe("shopify_order_555");
    expect(o.customerId).toBe("shopify_customer_888");
    expect(o.status).toBe("fulfilled");
    expect(o.total).toEqual({ currency: "USD", minorUnits: 12999 });
    expect(o.region).toBe("US");
    expect(o.items[0]).toMatchObject({ sku: "SKU-1", qty: 2 });
    expect(requests[0]?.url).toBe(
      "https://acme.myshopify.com/admin/api/2025-01/orders/555.json",
    );
    expect(requests[0]?.headers?.["x-shopify-access-token"]).toBe("shpat_test");
  });

  it("lists orders for a customer via customer_id query", async () => {
    const { http, requests } = mockHttp(okHandler);
    const adapter = new ShopifyAdapter({ config, http });
    const orders = await adapter.listOrders(ctx, "shopify_customer_888");
    expect(orders).toHaveLength(1);
    expect(requests[0]?.url).toContain("customer_id=888");
    expect(requests[0]?.url).toContain("status=any");
  });

  it("maps fulfillments to OSAS Shipment logistics status", async () => {
    const { http } = mockHttp(okHandler);
    const adapter = new ShopifyAdapter({ config, http });
    const shipment = await adapter.getShipment(ctx, "shopify_ship_555_77");
    expect(shipment).toMatchObject({
      orderId: "shopify_order_555",
      carrier: "UPS",
      trackingNumber: "1Z999",
      status: "in_transit",
    });
  });

  it("maps 404 to AdapterNotFoundError and never leaks the token in errors", async () => {
    const { http } = mockHttp(() => ({ status: 401, body: { errors: "bad" } }));
    const adapter = new ShopifyAdapter({ config, http });
    try {
      await adapter.getOrder(ctx, "shopify_order_555");
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("shpat_test");
    }
    const { http: http404 } = mockHttp(() => ({ status: 404, body: {} }));
    await expect(
      new ShopifyAdapter({ config, http: http404 }).getOrder(ctx, "shopify_order_555"),
    ).rejects.toBeInstanceOf(AdapterNotFoundError);
  });
});

describe("ShopifyAdapter refund proposal data (read-only)", () => {
  it("computes refundable amount minus refunds already recorded", () => {
    expect(refundableAmount(order)).toEqual({ currency: "USD", minorUnits: 10999 });
  });

  it("buildRefundProposalDraft returns amount, currency, status and captured evidence", async () => {
    const { http, requests } = mockHttp(okHandler);
    const adapter = new ShopifyAdapter({ config, http });
    const draft = await adapter.buildRefundProposalDraft(ctx, "shopify_order_555");
    expect(draft.orderStatus).toBe("fulfilled");
    expect(draft.amount).toEqual({ currency: "USD", minorUnits: 10999 });
    expect(draft.currency).toBe("USD");
    expect(draft.params).toEqual({ orderId: "555" });
    const kinds = draft.evidence.map((e) => `${e.kind}:${e.source.recordType}`);
    expect(kinds).toEqual(["order:order", "shipment:fulfillment", "order:refund_eligibility"]);
    for (const ev of draft.evidence) {
      expect(ev.source.system).toBe("shopify");
      expect(ev.source.url).toBe("https://acme.myshopify.com/admin/orders/555");
      expect((await adapter.getEvidence(ctx, ev.id)).id).toBe(ev.id);
    }
    // Only GETs — drafting a proposal never writes to Shopify.
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("ShopifyAdapter: no refund write path, ever", () => {
  it("executeAction always refuses with CAPABILITY_UNSUPPORTED and makes zero HTTP calls", async () => {
    const { http, requests } = mockHttp(okHandler);
    const adapter = new ShopifyAdapter({ config, http });
    await expect(adapter.executeAction()).rejects.toMatchObject({
      name: "AdapterCapabilityError",
      code: "CAPABILITY_UNSUPPORTED",
    });
    expect(requests).toHaveLength(0);
  });

  it("the manifest does not declare ecommerce.refund.execute", async () => {
    const { http } = mockHttp(okHandler);
    const manifest = await new ShopifyAdapter({ config, http }).getCapabilities(ctx);
    const granted = manifest.profiles.flatMap((p) => p.capabilities);
    expect(granted).toEqual(
      expect.arrayContaining([
        "ecommerce.order.read",
        "ecommerce.shipment.read",
        "ecommerce.refund.propose",
      ]),
    );
    expect(granted).not.toContain("ecommerce.refund.execute");
    expect(manifest.executionModes).toEqual(["shadow"]);
  });
});
