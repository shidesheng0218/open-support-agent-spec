import type { SupportAdapter, ToolContext } from "@osas/adapter";
import type { ActionType, Customer, Evidence, Money } from "@osas/core";
import type { GovernanceStores } from "@osas/governance";
import type { ShopifyAdapter } from "@osas/shopify-adapter";
import { formatMoney } from "./shadow-note.js";

/**
 * Optional order evidence for the Chatwoot shadow worker (read-only Shopify).
 *
 * Rules, all enforced here and not by the model:
 * - Shopify is only read when the tenant has an ACTIVE `shopify` connection whose
 *   externalAccountId equals the configured shop domain. One deployment-wide
 *   credential therefore never serves a tenant that has not opted in.
 * - Evidence is attached only if the order's email matches the Chatwoot
 *   contact's email. A web-widget email can be self-asserted, so this narrows
 *   the risk but does not prove identity; identity stays "unverified".
 * - Any failure degrades to "no evidence": policy then blocks the proposal.
 *   Shopify errors never fail the job and nothing is ever written to Shopify.
 */

export interface ShopifyEvidenceDeps {
  client: ShopifyAdapter;
  /** Normalised shop domain the credentials belong to. */
  shopDomain: string;
}

const ORDER_ACTIONS: readonly ActionType[] = [
  "refund",
  "return_request",
  "reshipment",
  "cancel_order",
  "exchange_request",
];

export const isOrderAction = (a: ActionType): boolean => ORDER_ACTIONS.includes(a);

/**
 * Accepts a bare Shopify order id, `shopify_order_<id>`, `ord_<id>` or `#<id>`.
 * Digits only after the prefix, so nothing model-supplied reaches a URL path.
 */
export function normalizeShopifyOrderId(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const m = /^(?:shopify_order_|ord_|#)?(\d{1,20})$/.exec(String(v).trim());
  return m ? m[1] : undefined;
}

export type OrderLookupReason =
  | "no_order_id"
  | "no_shopify_connection"
  | "customer_email_missing"
  | "order_not_found"
  | "order_contact_mismatch"
  | "shopify_error";

export type OrderLookup =
  | {
      checked: true;
      evidence: Evidence[];
      status: string;
      refundable: Money;
      summary: string;
    }
  | { checked: false; reason: OrderLookupReason; httpStatus?: number; summary: string };

const NOT_CHECKED_TEXT: Record<OrderLookupReason, string> = {
  no_order_id: "none attached (no usable order number in the request)",
  no_shopify_connection: "none attached (no active Shopify connection for this tenant)",
  customer_email_missing: "none attached (the Chatwoot contact has no email to match an order against)",
  order_not_found: "none attached (order not found in Shopify)",
  order_contact_mismatch: "none attached (the order does not belong to this contact)",
  shopify_error: "none attached (Shopify lookup failed)",
};

const skip = (reason: OrderLookupReason, httpStatus?: number): OrderLookup => ({
  checked: false,
  reason,
  ...(httpStatus !== undefined ? { httpStatus } : {}),
  summary: NOT_CHECKED_TEXT[reason],
});

export async function lookupOrderEvidence(
  deps: ShopifyEvidenceDeps,
  stores: GovernanceStores,
  adapter: SupportAdapter,
  ctx: ToolContext,
  input: { orderIdParam: unknown; customer: Customer; caseId: string },
): Promise<OrderLookup> {
  const orderId = normalizeShopifyOrderId(input.orderIdParam);
  if (!orderId) return skip("no_order_id");

  const connections = await stores.connections.list(ctx.tenantId, { status: "active", provider: "shopify" });
  if (!connections.some((c) => c.externalAccountId === deps.shopDomain)) {
    return skip("no_shopify_connection");
  }
  const contactEmail = input.customer.email?.trim().toLowerCase();
  if (!contactEmail) return skip("customer_email_missing");

  let read;
  try {
    read = await deps.client.readOrderForSupport(ctx, orderId);
  } catch (err) {
    if ((err as { name?: string }).name === "AdapterNotFoundError") return skip("order_not_found");
    const status = (err as { status?: unknown }).status;
    return skip("shopify_error", typeof status === "number" ? status : undefined);
  }
  if (!read.contactEmails.includes(contactEmail)) return skip("order_contact_mismatch");

  const evidence: Evidence[] = [];
  for (const e of read.evidence) {
    evidence.push(await adapter.captureEvidence(ctx, { ...e, caseId: input.caseId }));
  }
  return {
    checked: true,
    evidence,
    status: read.orderStatus,
    refundable: read.refundable,
    summary:
      `Shopify order ${read.orderId} read (status ${read.orderStatus}, ` +
      `refundable ${formatMoney(read.refundable)}, ${evidence.length} records)`,
  };
}
