import { describe, expect, it } from "vitest";
import { ChatwootAdapter } from "@osas/chatwoot-adapter";
import type { HttpClient as ChatwootHttp, HttpRequest as ChatwootReq } from "@osas/chatwoot-adapter";
import { ShopifyAdapter } from "@osas/shopify-adapter";
import type { HttpClient as ShopifyHttp, HttpRequest as ShopifyReq } from "@osas/shopify-adapter";
import { buildApp } from "./app.js";
import { normalizeShopifyOrderId } from "./workers/shopify-evidence.js";

const TENANT = "tenant_demo";
const ADMIN = { "x-osas-role": "policy_admin", "x-tenant-id": TENANT };
const CW = "https://chat.acme.example/api/v1/accounts/1";
const SHOP = "acme.myshopify.com";

function fakeChatwoot(message: string, contactEmail: string | undefined) {
  const requests: ChatwootReq[] = [];
  const http: ChatwootHttp = async (req) => {
    requests.push(req);
    if (req.method === "GET" && req.url === `${CW}/conversations/42`) {
      return {
        status: 200,
        body: {
          id: 42,
          status: "open",
          meta: { channel: "Channel::Email", sender: { id: 888, name: "Jane" } },
          messages: [{ id: 1, content: message, message_type: 0, private: false }],
          created_at: 1768035600,
        },
      };
    }
    if (req.method === "GET" && req.url === `${CW}/contacts/888`) {
      return { status: 200, body: { id: 888, name: "Jane", ...(contactEmail ? { email: contactEmail } : {}) } };
    }
    if (req.method === "POST" && req.url === `${CW}/conversations/42/messages`) return { status: 200, body: { id: 9001 } };
    return { status: 404, body: {} };
  };
  const notes = () =>
    requests
      .filter((r) => r.method === "POST" && r.url.endsWith("/conversations/42/messages"))
      .map((r) => (r.body as { content: string }).content);
  return {
    client: new ChatwootAdapter({
      config: { baseUrl: "https://chat.acme.example", accountId: "1", apiToken: "test-token-xyz" },
      http,
    }),
    notes,
  };
}

const shopifyOrder = {
  id: 1,
  name: "#1001",
  email: "Jane@Example.com",
  financial_status: "paid",
  fulfillment_status: "fulfilled",
  currency: "USD",
  total_price: "49.00",
  customer: { id: 7, email: "jane@example.com" },
  shipping_address: { country_code: "US" },
  line_items: [{ id: 1, sku: "SKU-1", title: "Mug", quantity: 1, price: "49.00" }],
  refunds: [],
  created_at: "2026-01-05T12:00:00Z",
};

function fakeShopify(opts: { status?: number; order?: Record<string, unknown> } = {}) {
  const requests: ShopifyReq[] = [];
  const http: ShopifyHttp = async (req) => {
    requests.push(req);
    if (opts.status && opts.status !== 200) return { status: opts.status, body: {} };
    if (req.url.endsWith("/orders/1.json")) return { status: 200, body: { order: opts.order ?? shopifyOrder } };
    if (req.url.endsWith("/orders/1/fulfillments.json")) return { status: 200, body: { fulfillments: [] } };
    return { status: 404, body: {} };
  };
  return {
    client: new ShopifyAdapter({
      config: { shopDomain: SHOP, adminAccessToken: "shpat_test", apiVersion: "2025-01" },
      http,
    }),
    requests,
  };
}

async function setup(opts: {
  message?: string;
  contactEmail?: string | undefined;
  shopify?: ReturnType<typeof fakeShopify>;
  shopifyConnection?: boolean;
}) {
  const chatwoot = fakeChatwoot(
    opts.message ?? "I want a refund for ord_1 please, $20",
    "contactEmail" in opts ? opts.contactEmail : "jane@example.com",
  );
  const shopify = opts.shopify ?? fakeShopify();
  const app = await buildApp({
    logger: false,
    env: { OSAS_GOVERNANCE_EVENT_CONSUMER: "chatwoot-shadow" },
    chatwoot: { client: chatwoot.client, accountId: "1" },
    shopify: { client: shopify.client, shopDomain: SHOP },
  });
  const admin = { actorId: "t-admin", roles: ["admin"], tenantId: TENANT, authenticated: true } as const;
  const activate = async (provider: string, externalAccountId: string) => {
    const c = await app.governance.connections.create(admin, {
      tenantId: TENANT,
      provider,
      externalAccountId,
      capabilities: ["ticket.read"],
    });
    await app.governance.stores.connections.update(
      TENANT,
      c.id,
      { status: "active", lastVerifiedAt: new Date().toISOString() },
      c.version,
    );
    return c;
  };
  const cwConn = await activate("chatwoot", "1");
  if (opts.shopifyConnection !== false) await activate("shopify", SHOP);
  await app.governance.intake.accept(
    { actorId: "chatwoot-webhook", roles: ["operator"], tenantId: TENANT, authenticated: true },
    TENANT,
    {
      connectionId: cwConn.id,
      topic: "chatwoot.message_created",
      externalEventId: "evt-1",
      occurredAt: new Date().toISOString(),
      payload: { event: "message_created", conversationId: "42", accountId: "1" },
      signatureVerified: true,
    },
  );
  const res = await app.inject({ method: "POST", url: "/v1/governance/jobs/drain", headers: ADMIN, payload: { limit: 10 } });
  expect(res.statusCode).toBe(200);
  const report = res.json() as { succeeded: Array<{ result?: Record<string, unknown> }>; deadLettered: unknown[] };
  return { app, chatwoot, shopify, report };
}

describe("shopify order evidence for the chatwoot shadow worker", () => {
  it("attaches evidence when the order email matches the contact, so INSUFFICIENT_EVIDENCE disappears but identity/region still gate", async () => {
    const { chatwoot, shopify, report } = await setup({});
    expect(report.deadLettered).toHaveLength(0);
    const note = chatwoot.notes()[0]!;
    expect(note).not.toContain("INSUFFICIENT_EVIDENCE");
    expect(note).toContain("Shopify order shopify_order_1 read");
    expect(note).toContain("Order data was read from the order system");
    expect(note).toContain("IDENTITY_UNVERIFIED");
    expect(report.succeeded[0]!.result).toMatchObject({ outcome: "suggested" });
    expect(report.succeeded[0]!.result).not.toMatchObject({ decision: "auto_execute" });
    // Read-only: only GETs, only the token header, nothing else.
    expect(shopify.requests.length).toBeGreaterThan(0);
    expect(shopify.requests.every((r) => r.method === "GET")).toBe(true);
    // Customer text and email stay out of the note.
    expect(note).not.toContain("jane@example.com");
    expect(note).not.toContain("please");
  });

  it("does not attach evidence for an order that belongs to someone else", async () => {
    const other = { ...shopifyOrder, email: "victim@example.com", customer: { id: 9, email: "victim@example.com" } };
    const { chatwoot, report } = await setup({ shopify: fakeShopify({ order: other }) });
    const note = chatwoot.notes()[0]!;
    expect(note).toContain("INSUFFICIENT_EVIDENCE");
    expect(note).toContain("does not belong to this contact");
    expect(note).not.toContain("victim@example.com");
    expect(note).not.toContain("49.00");
    expect(note).toContain("Not verified against any order system");
    expect(report.deadLettered).toHaveLength(0);
  });

  it("does not call Shopify when the tenant has no active shopify connection", async () => {
    const { chatwoot, shopify } = await setup({ shopifyConnection: false });
    expect(shopify.requests).toHaveLength(0);
    expect(chatwoot.notes()[0]).toContain("no active Shopify connection");
  });

  it("does not call Shopify when the contact has no email", async () => {
    const { chatwoot, shopify } = await setup({ contactEmail: undefined });
    expect(shopify.requests).toHaveLength(0);
    expect(chatwoot.notes()[0]).toContain("no email to match");
  });

  it("degrades to no evidence when Shopify errors, without failing the job", async () => {
    const { chatwoot, report } = await setup({ shopify: fakeShopify({ status: 500 }) });
    expect(report.deadLettered).toHaveLength(0);
    expect(report.succeeded).toHaveLength(1);
    expect(chatwoot.notes()[0]).toContain("Shopify lookup failed");
    expect(chatwoot.notes()[0]).toContain("INSUFFICIENT_EVIDENCE");
  });

  it("reports order-not-found when Shopify returns 404", async () => {
    const { chatwoot } = await setup({ shopify: fakeShopify({ status: 404 }) });
    expect(chatwoot.notes()[0]).toContain("order not found in Shopify");
  });

  it("makes no Shopify call when the request has no usable order number", async () => {
    const { chatwoot, shopify } = await setup({ message: "I want a refund for $20" });
    expect(shopify.requests).toHaveLength(0);
    expect(chatwoot.notes()[0]).toContain("no usable order number");
  });
});

describe("normalizeShopifyOrderId", () => {
  it("accepts digits with the known prefixes only", () => {
    expect(normalizeShopifyOrderId("1")).toBe("1");
    expect(normalizeShopifyOrderId("ord_1234")).toBe("1234");
    expect(normalizeShopifyOrderId("#1001")).toBe("1001");
    expect(normalizeShopifyOrderId("shopify_order_55")).toBe("55");
    expect(normalizeShopifyOrderId(77)).toBe("77");
  });
  it("rejects anything that could change the request path", () => {
    for (const v of ["ord_unknown", "1/../../shop", "1.json?x=1", "1 2", "", "ord_", null, undefined, {}, "9".repeat(21)]) {
      expect(normalizeShopifyOrderId(v)).toBeUndefined();
    }
  });
});
