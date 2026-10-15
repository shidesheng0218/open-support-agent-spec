import type { FastifyInstance } from "fastify";
import type { GovernanceActor } from "@osas/governance";
import { UnauthenticatedError } from "../auth.js";
import {
  chatwootWebhookSecretFor,
  mapChatwootEvent,
  verifyChatwootSignature,
} from "../webhooks/chatwoot.js";

/**
 * Provider webhook edge (unauthenticated by JWT; authenticated by signature).
 *
 *   POST /v1/webhooks/chatwoot/:tenantId/:connectionId
 *
 * The path tenant is untrusted input. It only selects which connection and
 * which per-connection secret to check; nothing is accepted unless the HMAC
 * verifies against the secret configured for exactly that (tenant, connection).
 * Every rejection returns the same 401 so the endpoint does not reveal which
 * connections exist.
 *
 * Ingesting is not acting: a verified event is handed to the governance inbox,
 * which dedupes it, orders it against the connection watermark and enqueues a
 * job. Nothing executes inside this request.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Scoped to this plugin: signature verification needs the exact bytes, and
  // re-serialised JSON would not verify. Other routes keep the default parser.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  const reject = (req: { log: { warn(o: unknown, m: string): void } }, reason: string): never => {
    req.log.warn({ reason }, "chatwoot webhook rejected");
    throw new UnauthenticatedError("webhook signature could not be verified");
  };

  app.post("/v1/webhooks/chatwoot/:tenantId/:connectionId", async (req) => {
    const { tenantId, connectionId } = req.params as { tenantId: string; connectionId: string };
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    const secret = chatwootWebhookSecretFor(app.webhookEnv, tenantId, connectionId);
    if (!secret) return reject(req, "no_secret_configured");

    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const timestamp = header("x-chatwoot-timestamp");
    const sig = verifyChatwootSignature({
      secret,
      rawBody,
      timestamp,
      signature: header("x-chatwoot-signature"),
      now: new Date(),
    });
    if (!sig.ok) return reject(req, sig.reason);

    const connection = await app.governance.stores.connections.get(tenantId, connectionId);
    if (!connection || connection.provider !== "chatwoot") return reject(req, "unknown_connection");

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      // Signed but unparseable: acknowledge so Chatwoot does not retry garbage.
      return { outcome: "ignored", reason: "invalid_json" };
    }

    const mapped = mapChatwootEvent(parsed, rawBody, {
      delivery: header("x-chatwoot-delivery"),
      timestamp: timestamp!,
    });
    if (mapped.kind === "ignore") return { outcome: "ignored", reason: mapped.reason };

    // A valid signature for connection A must not be usable to inject events
    // that claim to come from a different Chatwoot account.
    if (mapped.accountId && mapped.accountId !== connection.externalAccountId) {
      return reject(req, "account_mismatch");
    }

    const actor: GovernanceActor = {
      actorId: "chatwoot-webhook",
      roles: ["operator"],
      tenantId,
      authenticated: true,
    };
    return app.governance.intake.accept(actor, tenantId, {
      connectionId,
      topic: mapped.topic,
      externalEventId: mapped.externalEventId,
      occurredAt: mapped.occurredAt,
      payload: mapped.payload,
      signatureVerified: true,
    });
  });
}
