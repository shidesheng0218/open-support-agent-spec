import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  chatwootWebhookSecretFor,
  mapChatwootEvent,
  verifyChatwootSignature,
} from "./webhooks/chatwoot.js";

const SECRET = "chatwoot-test-secret-0123456789";
const TENANT = "tenant_cw";
const ADMIN = { "x-osas-role": "policy_admin", "x-tenant-id": TENANT };

const sign = (secret: string, ts: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

const nowSec = () => String(Math.floor(Date.now() / 1000));

const incoming = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: "message_created",
    id: 501,
    message_type: "incoming",
    private: false,
    content: "my item arrived broken",
    created_at: "2026-10-15T08:00:00.000Z",
    account: { id: 1 },
    inbox: { id: 7 },
    conversation: { id: 42 },
    ...over,
  });

describe("verifyChatwootSignature", () => {
  const now = new Date("2026-10-15T08:00:00.000Z");
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = Buffer.from('{"a":1}');
  const good = sign(SECRET, ts, '{"a":1}');

  it("accepts a correct signature", () => {
    expect(verifyChatwootSignature({ secret: SECRET, rawBody: body, timestamp: ts, signature: good, now })).toEqual({
      ok: true,
    });
  });

  it("rejects a wrong secret, a tampered body and missing headers", () => {
    const base = { rawBody: body, timestamp: ts, signature: good, now };
    expect(verifyChatwootSignature({ ...base, secret: "another-secret-0123456789" })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyChatwootSignature({ ...base, secret: SECRET, rawBody: Buffer.from('{"a":2}') })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyChatwootSignature({ ...base, secret: SECRET, signature: undefined })).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });

  it("rejects stale and malformed timestamps (replay window)", () => {
    const stale = String(Math.floor(now.getTime() / 1000) - 3600);
    expect(
      verifyChatwootSignature({
        secret: SECRET,
        rawBody: body,
        timestamp: stale,
        signature: sign(SECRET, stale, '{"a":1}'),
        now,
      }),
    ).toEqual({ ok: false, reason: "timestamp_out_of_window" });
    expect(
      verifyChatwootSignature({ secret: SECRET, rawBody: body, timestamp: "abc", signature: good, now }),
    ).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("rejects a malformed signature value without throwing", () => {
    for (const signature of ["sha256=zz", "md5=abcd", "sha256=" + "a".repeat(10), ""]) {
      const r = verifyChatwootSignature({ secret: SECRET, rawBody: body, timestamp: ts, signature, now });
      expect(r.ok).toBe(false);
    }
  });
});

describe("chatwootWebhookSecretFor", () => {
  it("is keyed by tenant and connection, and refuses short secrets", () => {
    const env = {
      OSAS_CHATWOOT_WEBHOOK_SECRET_TENANT_A__CONN_1: SECRET,
      OSAS_CHATWOOT_WEBHOOK_SECRET_TENANT_B__CONN_2: "short",
    };
    expect(chatwootWebhookSecretFor(env, "tenant-a", "conn_1")).toBe(SECRET);
    expect(chatwootWebhookSecretFor(env, "tenant_b", "conn_1")).toBeUndefined();
    expect(chatwootWebhookSecretFor(env, "tenant_b", "conn_2")).toBeUndefined();
  });
});

describe("mapChatwootEvent", () => {
  const raw = Buffer.from("{}");
  const headers = { timestamp: "1760515200", delivery: "d-1" };

  it("maps a customer message to references only (no message content)", () => {
    const m = mapChatwootEvent(JSON.parse(incoming()), raw, headers);
    expect(m.kind).toBe("accept");
    if (m.kind !== "accept") return;
    expect(m.topic).toBe("chatwoot.message_created");
    expect(m.externalEventId).toBe("d-1");
    expect(m.payload).toEqual({
      event: "message_created",
      conversationId: "42",
      messageId: "501",
      messageType: "incoming",
      inboxId: "7",
      accountId: "1",
    });
    expect(JSON.stringify(m.payload)).not.toContain("broken");
  });

  it("ignores private notes, outgoing replies and unsupported events (no self-loop)", () => {
    const reason = (over: Record<string, unknown>) => {
      const m = mapChatwootEvent(JSON.parse(incoming(over)), raw, headers);
      return m.kind === "ignore" ? m.reason : "accepted";
    };
    expect(reason({ private: true })).toBe("private_message");
    expect(reason({ message_type: "outgoing" })).toBe("outgoing_message");
    expect(reason({ message_type: 1 })).toBe("outgoing_message");
    expect(reason({ message_type: 2 })).toBe("non_customer_message");
    expect(reason({ event: "conversation_status_changed" })).toBe("unsupported_event");
  });

  it("falls back to a body hash when no delivery id is sent", () => {
    const m = mapChatwootEvent(JSON.parse(incoming()), raw, { timestamp: "1760515200" });
    expect(m.kind === "accept" && m.externalEventId.startsWith("sha256:")).toBe(true);
  });
});

describe("POST /v1/webhooks/chatwoot/:tenantId/:connectionId", () => {
  // The connection id is generated at creation time, so the per-connection
  // secret is registered in the app's env after the id is known.
  async function activeApp() {
    const base = await buildApp({ logger: false, env: {} });
    const created = await base.inject({
      method: "POST",
      url: "/v1/governance/connections",
      headers: ADMIN,
      payload: { provider: "chatwoot", externalAccountId: "1", capabilities: ["ticket.read"] },
    });
    const id = created.json().id as string;
    await base.governance.stores.connections.update(
      TENANT,
      id,
      { status: "active", lastVerifiedAt: new Date().toISOString() },
      created.json().version as number,
    );
    const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    (base.webhookEnv as NodeJS.ProcessEnv)[`OSAS_CHATWOOT_WEBHOOK_SECRET_${norm(TENANT)}__${norm(id)}`] = SECRET;
    return { app: base, id };
  }

  const post = (
    app: Awaited<ReturnType<typeof buildApp>>,
    id: string,
    body: string,
    headers: Record<string, string>,
    tenant = TENANT,
  ) =>
    app.inject({
      method: "POST",
      url: `/v1/webhooks/chatwoot/${tenant}/${id}`,
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });

  it("accepts a signed delivery without any JWT/role headers and enqueues work", async () => {
    const { app, id } = await activeApp();
    const body = incoming();
    const ts = nowSec();
    const res = await post(app, id, body, {
      "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": sign(SECRET, ts, body),
      "x-chatwoot-delivery": "delivery-1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("accepted");
    expect(res.json().event.topic).toBe("chatwoot.message_created");
    expect(res.json().event.payload.conversationId).toBe("42");
    expect(JSON.stringify(res.json())).not.toContain("broken");
  });

  it("deduplicates a replayed delivery", async () => {
    const { app, id } = await activeApp();
    const body = incoming();
    const ts = nowSec();
    const headers = {
      "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": sign(SECRET, ts, body),
      "x-chatwoot-delivery": "delivery-replay",
    };
    const first = await post(app, id, body, headers);
    const second = await post(app, id, body, headers);
    expect(first.json().outcome).toBe("accepted");
    expect(second.statusCode).toBe(200);
    expect(second.json().outcome).toBe("duplicate");
  });

  it("rejects bad signatures, missing headers and tampered bodies with an identical 401", async () => {
    const { app, id } = await activeApp();
    const body = incoming();
    const ts = nowSec();
    const wrong = await post(app, id, body, {
      "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": sign("wrong-secret-0123456789", ts, body),
    });
    const missing = await post(app, id, body, {});
    const tampered = await post(app, id, body.replace("broken", "fine"), {
      "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": sign(SECRET, ts, body),
    });
    for (const r of [wrong, missing, tampered]) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.message).toBe(wrong.json().error.message);
    }
    // Rejections must not occupy a dedupe key: the genuine delivery still lands.
    const ok = await post(app, id, body, {
      "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": sign(SECRET, ts, body),
      "x-chatwoot-delivery": "after-rejects",
    });
    expect(ok.json().outcome).toBe("accepted");
  });

  it("returns the same 401 for unknown connections, other tenants and unconfigured secrets", async () => {
    const { app, id } = await activeApp();
    const body = incoming();
    const ts = nowSec();
    const headers = { "x-chatwoot-timestamp": ts, "x-chatwoot-signature": sign(SECRET, ts, body) };
    const unknown = await post(app, "conn_missing", body, headers);
    const otherTenant = await post(app, id, body, headers, "tenant_other");
    expect(unknown.statusCode).toBe(401);
    expect(otherTenant.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(otherTenant.json().error.message);
  });

  it("rejects a validly signed event that claims a different Chatwoot account", async () => {
    const { app, id } = await activeApp();
    const body = incoming({ account: { id: 999 } });
    const ts = nowSec();
    const res = await post(app, id, body, {
      "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": sign(SECRET, ts, body),
    });
    expect(res.statusCode).toBe(401);
  });

  it("acknowledges but ignores signed private notes and invalid JSON", async () => {
    const { app, id } = await activeApp();
    const note = incoming({ private: true });
    const ts = nowSec();
    const ignored = await post(app, id, note, {
      "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": sign(SECRET, ts, note),
    });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toEqual({ outcome: "ignored", reason: "private_message" });

    const junk = "not json";
    const bad = await post(app, id, junk, {
      "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": sign(SECRET, ts, junk),
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().outcome).toBe("ignored");
  });

  it("refuses events for a paused connection", async () => {
    const { app, id } = await activeApp();
    await app.inject({ method: "POST", url: `/v1/governance/connections/${id}/pause`, headers: ADMIN });
    const body = incoming();
    const ts = nowSec();
    const res = await post(app, id, body, {
      "x-chatwoot-timestamp": ts,
      "x-chatwoot-signature": sign(SECRET, ts, body),
    });
    expect(res.statusCode).toBe(409);
  });

  it("in jwt mode the signature bypass applies to the webhook path only", async () => {
    const app = await buildApp({
      logger: false,
      env: {},
      // The JWKS URL is never fetched: a request without a Bearer token is
      // rejected before verification, and the webhook path never reaches it.
      auth: {
        mode: "jwt",
        nodeEnv: "test",
        jwksUrl: "http://127.0.0.1:9/jwks.json",
        jwtIssuer: "https://issuer.test",
        jwtAudience: "osas-api",
      },
    });
    const admin = { actorId: "test-admin", roles: ["admin"], tenantId: TENANT, authenticated: true } as const;
    const conn = await app.governance.connections.create(admin, {
      tenantId: TENANT,
      provider: "chatwoot",
      externalAccountId: "1",
      capabilities: ["ticket.read"],
    });
    await app.governance.stores.connections.update(
      TENANT,
      conn.id,
      { status: "active", lastVerifiedAt: new Date().toISOString() },
      conn.version,
    );
    const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    app.webhookEnv[`OSAS_CHATWOOT_WEBHOOK_SECRET_${norm(TENANT)}__${norm(conn.id)}`] = SECRET;

    const body = incoming();
    const ts = nowSec();
    const hook = await app.inject({
      method: "POST",
      url: `/v1/webhooks/chatwoot/${TENANT}/${conn.id}`,
      headers: {
        "content-type": "application/json",
        "x-chatwoot-timestamp": ts,
        "x-chatwoot-signature": sign(SECRET, ts, body),
        "x-chatwoot-delivery": "jwt-mode-1",
      },
      payload: body,
    });
    expect(hook.statusCode).toBe(200);
    expect(hook.json().outcome).toBe("accepted");

    const other = await app.inject({ method: "GET", url: "/v1/governance/connections" });
    expect(other.statusCode).toBe(401);
    const forged = await app.inject({
      method: "GET",
      url: "/v1/governance/connections",
      headers: { "x-osas-role": "policy_admin", "x-tenant-id": TENANT },
    });
    expect(forged.statusCode).toBe(401);
  });
});
