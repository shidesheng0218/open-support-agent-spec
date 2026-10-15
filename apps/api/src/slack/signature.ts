import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack request signing: X-Slack-Signature = "v0=" + hex HMAC-SHA256(secret,
 * "v0:<X-Slack-Request-Timestamp>:<raw body>"). Pure; callers inject `now`.
 */
export const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export type SlackSignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "bad_timestamp" | "timestamp_out_of_window" | "mismatch" };

export function verifySlackSignature(input: {
  secret: string;
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  now: Date;
  toleranceSeconds?: number;
}): SlackSignatureResult {
  const { secret, rawBody, timestamp, signature, now } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing_header" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const tolerance = input.toleranceSeconds ?? SLACK_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) > tolerance) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }
  const m = /^v0=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!m) return { ok: false, reason: "mismatch" };
  const provided = Buffer.from(m[1]!, "hex");
  const expected = createHmac("sha256", secret).update(`v0:${timestamp}:`).update(rawBody).digest();
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/** Test helper and reference implementation of what Slack sends. */
export function signSlackRequest(secret: string, timestamp: string, rawBody: string | Buffer): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:`).update(rawBody).digest("hex");
}
