import type { FastifyInstance } from "fastify";
import { UnauthenticatedError } from "../auth.js";
import type { SlackConfig } from "./config.js";
import type { SlackApprovals } from "./approvals.js";
import { verifySlackSignature } from "./signature.js";

/**
 * POST /v1/webhooks/slack/interactivity — Slack button clicks.
 *
 * Lives under /v1/webhooks/ so the JWT hook skips it; authentication is the
 * Slack signature over the exact request bytes, plus the approver mapping
 * inside handleInteraction. Every signature failure returns the same 401.
 * Slack sends application/x-www-form-urlencoded with one `payload` field.
 */
export async function slackRoutes(
  app: FastifyInstance,
  opts: { config: SlackConfig; approvals: SlackApprovals },
): Promise<void> {
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/v1/webhooks/slack/interactivity", async (req, reply) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const sig = verifySlackSignature({
      secret: opts.config.signingSecret,
      rawBody,
      timestamp: header("x-slack-request-timestamp"),
      signature: header("x-slack-signature"),
      now: new Date(),
    });
    if (!sig.ok) {
      req.log.warn({ reason: sig.reason }, "slack interactivity rejected");
      throw new UnauthenticatedError("slack signature could not be verified");
    }
    let payload: unknown;
    try {
      const field = new URLSearchParams(rawBody.toString("utf8")).get("payload");
      payload = field ? JSON.parse(field) : undefined;
    } catch {
      payload = undefined;
    }
    const outcome = await opts.approvals.handleInteraction(payload);
    req.log.info({ outcome }, "slack interactivity handled");
    // Slack only needs an empty 200 within 3 seconds; the card is updated via chat.update.
    return reply.code(200).send();
  });
}
