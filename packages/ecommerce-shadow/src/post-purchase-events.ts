import type { ProviderEvent } from "@osas/core";
import { hashProviderPayload } from "./controlled-execution.js";

/**
 * Transport-neutral post-purchase event names that OSAS accepts after an
 * adapter has verified the source protocol's signature and tenant binding.
 */
export const POST_PURCHASE_EVENT_TYPES = [
  "order.created",
  "order.cancelled",
  "fulfillment.shipped",
  "fulfillment.delayed",
  "fulfillment.delivered",
  "refund.requested",
  "refund.succeeded",
  "refund.failed",
  "return.requested",
  "return.received",
] as const;

export type PostPurchaseEventType = (typeof POST_PURCHASE_EVENT_TYPES)[number];
export type PostPurchaseProtocol = "ucp" | "acp";

export interface PostPurchaseEventInput {
  id: string;
  protocol: PostPurchaseProtocol;
  tenantId: string;
  providerEventId: string;
  eventType: string;
  idempotencyKey: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  now?: Date;
}

const supportedEventTypes = new Set<string>(POST_PURCHASE_EVENT_TYPES);

/**
 * Converts an already-authenticated external commerce event into an OSAS
 * ProviderEvent. This function is intentionally side-effect free: callers
 * must persist, reconcile, or act on the resulting event separately.
 */
export function normalizePostPurchaseEvent(input: PostPurchaseEventInput): ProviderEvent {
  if (typeof input.providerEventId !== "string" || input.providerEventId.trim().length === 0) {
    throw new Error("providerEventId must be a non-empty string");
  }

  if (!supportedEventTypes.has(input.eventType)) {
    throw new Error(`Unsupported post-purchase event type: ${input.eventType}`);
  }

  const payload = {
    source: {
      protocol: input.protocol,
      eventType: input.eventType,
    },
    data: input.payload,
  };

  return {
    id: input.id,
    specVersion: "0.3",
    tenantId: input.tenantId,
    provider: input.protocol,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    payloadHash: hashProviderPayload(payload),
    payload,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}
