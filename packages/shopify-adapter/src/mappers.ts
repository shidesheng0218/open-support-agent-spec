import type {
  Evidence,
  Money,
  Order,
  OrderStatus,
  RefundTransaction,
  RefundTransactionStatus,
  Shipment,
  ShipmentIncident,
  ShipmentIncidentType,
  ShipmentStatus,
} from "@osas/core";
import { SPEC_VERSION } from "@osas/core";

/** Shopify order JSON (subset of GET /admin/api/{v}/orders/{id}.json). */
export interface ShopifyOrder {
  id: number;
  name?: string;
  email?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  currency?: string;
  total_price?: string;
  customer?: { id?: number; email?: string };
  shipping_address?: { country_code?: string };
  line_items?: Array<{
    id: number;
    sku?: string | null;
    title?: string;
    quantity?: number;
    price?: string;
  }>;
  refunds?: Array<{
    id: number;
    created_at?: string;
    transactions?: Array<{
      id?: number;
      kind?: string;
      amount?: string;
      status?: string;
      gateway?: string;
    }>;
  }>;
  created_at?: string;
}

/** Shopify fulfillment JSON (subset of GET /admin/api/{v}/orders/{id}/fulfillments.json). */
export interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status?: string;
  tracking_company?: string | null;
  tracking_number?: string | null;
  created_at?: string;
  updated_at?: string;
}

export const orderIdForShopify = (orderId: number | string): string => `shopify_order_${orderId}`;
export const customerIdForShopify = (customerId: number | string): string =>
  `shopify_customer_${customerId}`;
export const shipmentIdFor = (orderId: number | string, fulfillmentId: number | string): string =>
  `shopify_ship_${orderId}_${fulfillmentId}`;

export function shopifyOrderIdFromOsas(id: string): string {
  const m = /^(?:shopify_order_)?(\d+)$/.exec(id);
  if (!m) throw new Error(`not a Shopify order id: ${id}`);
  return m[1] as string;
}

export function shopifyCustomerIdFromOsas(id: string): string {
  const m = /^(?:shopify_customer_)?(\d+)$/.exec(id);
  if (!m) throw new Error(`not a Shopify customer id: ${id}`);
  return m[1] as string;
}

/** "shopify_ship_{orderId}_{fulfillmentId}" → both ids. */
export function parseShipmentId(id: string): { orderId: string; fulfillmentId: string } {
  const m = /^shopify_ship_(\d+)_(\d+)$/.exec(id);
  if (!m) throw new Error(`not a Shopify shipment id: ${id}`);
  return { orderId: m[1] as string, fulfillmentId: m[2] as string };
}

/** Decimal string ("129.99") → integer minor units. Never floats in OSAS Money. */
export function toMinorUnits(amount: string | number | undefined): number {
  if (amount === undefined) return 0;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function orderStatus(o: ShopifyOrder): OrderStatus {
  if (o.cancelled_at) return "cancelled";
  if (o.financial_status === "refunded") return "refunded";
  if (o.fulfillment_status === "fulfilled") return "fulfilled";
  if (o.financial_status === "paid" || o.financial_status === "partially_paid") return "paid";
  return "pending";
}

export function mapShopifyOrder(o: ShopifyOrder, tenantId: string): Order {
  const currency = (o.currency ?? "USD").toUpperCase();
  return {
    id: orderIdForShopify(o.id),
    specVersion: SPEC_VERSION,
    tenantId,
    customerId: o.customer?.id
      ? customerIdForShopify(o.customer.id)
      : customerIdForShopify(o.email ?? "unknown"),
    status: orderStatus(o),
    items: (o.line_items ?? []).map((li) => ({
      sku: li.sku ?? String(li.id),
      name: li.title ?? `line item ${li.id}`,
      qty: li.quantity ?? 1,
      unitPrice: { currency, minorUnits: toMinorUnits(li.price) },
    })),
    total: { currency, minorUnits: toMinorUnits(o.total_price) },
    region: (o.shipping_address?.country_code ?? "ZZ").toUpperCase(),
    createdAt: o.created_at ?? new Date().toISOString(),
  };
}

const FULFILLMENT_STATUS_MAP: Record<string, ShipmentStatus> = {
  pending: "label_created",
  open: "label_created",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  success: "delivered",
  delivered: "delivered",
  failure: "exception",
  cancelled: "exception",
  error: "exception",
};

export function mapShopifyFulfillment(f: ShopifyFulfillment, tenantId: string): Shipment {
  return {
    id: shipmentIdFor(f.order_id, f.id),
    specVersion: SPEC_VERSION,
    tenantId,
    orderId: orderIdForShopify(f.order_id),
    carrier: f.tracking_company ?? "unknown",
    ...(f.tracking_number ? { trackingNumber: f.tracking_number } : {}),
    status: (f.status ? FULFILLMENT_STATUS_MAP[f.status] : undefined) ?? "label_created",
    createdAt: f.created_at ?? new Date().toISOString(),
  };
}

/**
 * Amount still refundable for an order: total minus successful refund
 * transactions already recorded by Shopify. Integer minor units only.
 */
export function refundableAmount(o: ShopifyOrder): Money {
  const currency = (o.currency ?? "USD").toUpperCase();
  const refunded = (o.refunds ?? [])
    .flatMap((r) => r.transactions ?? [])
    .filter((t) => t.kind === "refund" && t.status !== "failure")
    .reduce((sum, t) => sum + toMinorUnits(t.amount), 0);
  return {
    currency,
    minorUnits: Math.max(0, toMinorUnits(o.total_price) - refunded),
  };
}

export function orderAdminUrl(shopDomain: string, orderId: number | string): string {
  return `https://${shopDomain}/admin/orders/${orderId}`;
}

export function orderEvidenceInput(
  o: ShopifyOrder,
  tenantId: string,
  shopDomain: string,
): Omit<Evidence, "id" | "specVersion" | "createdAt"> {
  const order = mapShopifyOrder(o, tenantId);
  return {
    tenantId,
    kind: "order",
    source: {
      system: "shopify",
      recordType: "order",
      recordId: String(o.id),
      url: orderAdminUrl(shopDomain, o.id),
    },
    summary: `Shopify order ${o.name ?? o.id}: ${order.status}, total ${order.total.minorUnits} ${order.total.currency} minor units`,
    data: {
      financialStatus: o.financial_status,
      fulfillmentStatus: o.fulfillment_status ?? null,
      cancelledAt: o.cancelled_at ?? null,
      total: order.total,
      items: order.items,
    },
    retrievedAt: new Date().toISOString(),
  };
}

export function fulfillmentEvidenceInput(
  f: ShopifyFulfillment,
  tenantId: string,
  shopDomain: string,
): Omit<Evidence, "id" | "specVersion" | "createdAt"> {
  const shipment = mapShopifyFulfillment(f, tenantId);
  return {
    tenantId,
    kind: "shipment",
    source: {
      system: "shopify",
      recordType: "fulfillment",
      recordId: `${f.order_id}/${f.id}`,
      url: orderAdminUrl(shopDomain, f.order_id),
    },
    summary: `Shopify fulfillment ${f.id} for order ${f.order_id}: ${shipment.status}`,
    data: {
      status: shipment.status,
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber ?? null,
    },
    retrievedAt: new Date().toISOString(),
  };
}

/** Refund-eligibility evidence: the refundable amount + order state a refund Proposal is priced from. */
export function refundEligibilityEvidenceInput(
  o: ShopifyOrder,
  tenantId: string,
  shopDomain: string,
): Omit<Evidence, "id" | "specVersion" | "createdAt"> {
  const refundable = refundableAmount(o);
  return {
    tenantId,
    kind: "order",
    source: {
      system: "shopify",
      recordType: "refund_eligibility",
      recordId: String(o.id),
      url: orderAdminUrl(shopDomain, o.id),
    },
    summary:
      `Refund eligibility for order ${o.name ?? o.id}: refundable ${refundable.minorUnits} ` +
      `${refundable.currency} minor units (financial_status=${o.financial_status ?? "unknown"})`,
    data: {
      refundable,
      financialStatus: o.financial_status,
      alreadyRefundedCount: (o.refunds ?? []).length,
    },
    retrievedAt: new Date().toISOString(),
  };
}

/* ---------------- After-sales reads (v0.2 Phase 6) ---------------- */

const REFUND_TXN_STATUS_MAP: Record<string, RefundTransactionStatus> = {
  success: "succeeded",
  pending: "processing",
  processing: "processing",
  failure: "failed",
  error: "failed",
};

/**
 * Map Shopify order.refunds[].transactions (kind "refund") to read-only
 * RefundTransaction records. Shopify is the source of truth for refund state;
 * this adapter never creates one.
 */
export function mapShopifyRefundTransactions(
  o: ShopifyOrder,
  tenantId: string,
): RefundTransaction[] {
  const currency = (o.currency ?? "USD").toUpperCase();
  const out: RefundTransaction[] = [];
  for (const refund of o.refunds ?? []) {
    (refund.transactions ?? []).forEach((t, i) => {
      if (t.kind !== "refund") return;
      const status = (t.status ? REFUND_TXN_STATUS_MAP[t.status] : undefined) ?? "requested";
      const at = refund.created_at ?? o.created_at ?? new Date().toISOString();
      out.push({
        id: `shopify_refund_${refund.id}_${t.id ?? i}`,
        specVersion: SPEC_VERSION,
        tenantId,
        orderId: orderIdForShopify(o.id),
        ...(t.gateway ? { provider: t.gateway } : {}),
        externalTransactionId: t.id !== undefined ? String(t.id) : undefined,
        status,
        amount: { currency, minorUnits: toMinorUnits(t.amount) },
        requestedAt: at,
        ...(status === "succeeded" ? { completedAt: at } : {}),
        ...(status === "failed" ? { failureCode: `shopify_${t.status ?? "failure"}` } : {}),
        createdAt: at,
        updatedAt: at,
      });
    });
  }
  return out;
}

/** "shopify_inc_{orderId}_{fulfillmentId}" — the incident id scheme. */
export const shipmentIncidentIdFor = (
  orderId: number | string,
  fulfillmentId: number | string,
): string => `shopify_inc_${orderId}_${fulfillmentId}`;

export function parseShipmentIncidentId(id: string): { orderId: string; fulfillmentId: string } {
  const m = /^shopify_inc_(\d+)_(\d+)$/.exec(id);
  if (!m) throw new Error(`not a Shopify shipment incident id: ${id}`);
  return { orderId: m[1] as string, fulfillmentId: m[2] as string };
}

/**
 * Shopify has no native shipment-incident object; this derives a read-only
 * incident view from fulfillment state: a failed/cancelled fulfillment maps
 * to "lost", a delivered fulfillment (queried because a customer reports
 * non-receipt) maps to "delivered_not_received", anything still moving maps
 * to "delayed". Detection/investigation itself stays with the carrier and
 * humans — this is a view, never a write.
 */
export function deriveShipmentIncident(
  f: ShopifyFulfillment,
  tenantId: string,
): ShipmentIncident {
  const shipment = mapShopifyFulfillment(f, tenantId);
  const incidentType: ShipmentIncidentType =
    shipment.status === "exception"
      ? "lost"
      : shipment.status === "delivered"
        ? "delivered_not_received"
        : "delayed";
  const at = f.updated_at ?? f.created_at ?? new Date().toISOString();
  return {
    id: shipmentIncidentIdFor(f.order_id, f.id),
    specVersion: SPEC_VERSION,
    tenantId,
    orderId: orderIdForShopify(f.order_id),
    shipmentId: shipment.id,
    incidentType,
    ...(f.tracking_company ? { carrier: f.tracking_company } : {}),
    status: "open",
    detectedAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

/** Order-line claim evidence: the order snapshot scoped to the claimed line(s). */
export function orderLineClaimEvidenceInput(
  o: ShopifyOrder,
  lineId: string | undefined,
  tenantId: string,
  shopDomain: string,
): Omit<Evidence, "id" | "specVersion" | "createdAt"> {
  const currency = (o.currency ?? "USD").toUpperCase();
  const lines = (o.line_items ?? []).filter(
    (li) => lineId === undefined || String(li.id) === lineId || li.sku === lineId,
  );
  return {
    tenantId,
    kind: "order",
    source: {
      system: "shopify",
      recordType: "order_line",
      recordId: lineId === undefined ? String(o.id) : `${o.id}/${lineId}`,
      url: orderAdminUrl(shopDomain, o.id),
    },
    summary:
      `Shopify order ${o.name ?? o.id} line evidence` +
      (lineId === undefined ? "" : ` for line ${lineId}`) +
      `: ${lines.length} line item(s)`,
    data: {
      orderId: String(o.id),
      ...(lineId !== undefined ? { lineId } : {}),
      lines: lines.map((li) => ({
        lineId: String(li.id),
        sku: li.sku ?? null,
        title: li.title ?? null,
        quantity: li.quantity ?? 1,
        unitPrice: { currency, minorUnits: toMinorUnits(li.price) },
      })),
    },
    retrievedAt: new Date().toISOString(),
  };
}
