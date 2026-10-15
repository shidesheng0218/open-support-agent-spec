import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Chatwoot webhook edge: signature verification and event mapping.
 *
 * Pure functions only. Nothing here touches the network, the clock (callers
 * inject `now`), or the governance stores, so every branch is unit-testable.
 *
 * Signature scheme, as implemented upstream in chatwoot/chatwoot
 * `lib/webhooks/trigger.rb`:
 *   X-Chatwoot-Timestamp: <unix seconds>
 *   X-Chatwoot-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *   X-Chatwoot-Delivery:  <delivery id>   (only sent when present)
 * The secret is only used when the webhook has one, so OSAS refuses any
 * delivery that arrives without a signature.
 */

export const CHATWOOT_TIMESTAMP_TOLERANCE_SECONDS = 300;
export const CHATWOOT_MIN_SECRET_LENGTH = 16;

export type ChatwootSignatureFailure =
  | "missing_header"
  | "bad_timestamp"
  | "timestamp_out_of_window"
  | "mismatch";

export type ChatwootSignatureResult = { ok: true } | { ok: false; reason: ChatwootSignatureFailure };

export interface VerifyChatwootSignatureInput {
  secret: string;
  /** The exact bytes received. Re-serialised JSON will not verify. */
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  now: Date;
  toleranceSeconds?: number;
}

export function verifyChatwootSignature(input: VerifyChatwootSignatureInput): ChatwootSignatureResult {
  const { secret, rawBody, timestamp, signature, now } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing_header" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };

  const tolerance = input.toleranceSeconds ?? CHATWOOT_TIMESTAMP_TOLERANCE_SECONDS;
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
  if (skew > tolerance) return { ok: false, reason: "timestamp_out_of_window" };

  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!match) return { ok: false, reason: "mismatch" };
  const provided = Buffer.from(match[1]!, "hex");
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/**
 * Per-connection webhook secret, resolved from the environment by convention:
 *   OSAS_CHATWOOT_WEBHOOK_SECRET_<TENANT>__<CONNECTION>
 * (each part upper-cased, non-alphanumerics -> "_"). Keying on tenant AND
 * connection means one tenant's Chatwoot can never sign events for another
 * tenant's connection, even if it learns the connection id. Too-short or absent
 * secrets resolve to undefined, which the route treats exactly like a bad
 * signature.
 */
export function chatwootWebhookSecretFor(
  env: NodeJS.ProcessEnv,
  tenantId: string,
  connectionId: string,
): string | undefined {
  const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const value = env[`OSAS_CHATWOOT_WEBHOOK_SECRET_${norm(tenantId)}__${norm(connectionId)}`]?.trim();
  return value && value.length >= CHATWOOT_MIN_SECRET_LENGTH ? value : undefined;
}

export type ChatwootMapping =
  | { kind: "ignore"; reason: string }
  | {
      kind: "accept";
      topic: string;
      externalEventId: string;
      occurredAt: string;
      accountId: string | undefined;
      /** References only. Message content and contact PII are refetched via the adapter. */
      payload: Record<string, unknown>;
    };

const SUPPORTED_EVENTS = new Set(["message_created", "conversation_created"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const idString = (v: unknown): string | undefined =>
  typeof v === "number" && Number.isFinite(v)
    ? String(v)
    : typeof v === "string" && v.trim()
      ? v.trim()
      : undefined;

/** Accepts ISO-8601 or unix seconds. Returns undefined for anything else. */
function toIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return undefined;
}

export function mapChatwootEvent(
  body: unknown,
  rawBody: Buffer,
  headers: { delivery?: string | undefined; timestamp: string },
): ChatwootMapping {
  if (!isRecord(body)) return { kind: "ignore", reason: "payload_not_object" };
  const event = typeof body.event === "string" ? body.event : undefined;
  if (!event || !SUPPORTED_EVENTS.has(event)) return { kind: "ignore", reason: "unsupported_event" };

  const accountId = isRecord(body.account) ? idString(body.account.id) : undefined;
  const inboxId = isRecord(body.inbox) ? idString(body.inbox.id) : undefined;
  const conversation = isRecord(body.conversation) ? body.conversation : undefined;

  let conversationId: string | undefined;
  let messageId: string | undefined;
  let messageType: string | undefined;

  if (event === "message_created") {
    conversationId = conversation ? idString(conversation.id) : undefined;
    messageId = idString(body.id);
    const mt = body.message_type;
    messageType = mt === 0 || mt === "incoming" ? "incoming" : mt === 1 || mt === "outgoing" ? "outgoing" : undefined;
    // Our own private notes (and any agent reply) come back as message_created.
    // Dropping them here is what keeps a note-writing worker from looping on itself.
    if (body.private === true) return { kind: "ignore", reason: "private_message" };
    if (messageType === "outgoing") return { kind: "ignore", reason: "outgoing_message" };
    if (mt === 2 || mt === "activity" || mt === 3 || mt === "template") {
      return { kind: "ignore", reason: "non_customer_message" };
    }
  } else {
    conversationId = idString(body.id) ?? (conversation ? idString(conversation.id) : undefined);
  }
  if (!conversationId) return { kind: "ignore", reason: "no_conversation_id" };

  const occurredAt =
    toIso(body.created_at) ??
    (conversation ? toIso(conversation.created_at) : undefined) ??
    toIso(Number(headers.timestamp));
  if (!occurredAt) return { kind: "ignore", reason: "no_timestamp" };

  const externalEventId =
    headers.delivery?.trim() || `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;

  return {
    kind: "accept",
    topic: `chatwoot.${event}`,
    externalEventId,
    occurredAt,
    accountId,
    payload: {
      event,
      conversationId,
      ...(messageId ? { messageId } : {}),
      ...(messageType ? { messageType } : {}),
      ...(inboxId ? { inboxId } : {}),
      ...(accountId ? { accountId } : {}),
    },
  };
}
