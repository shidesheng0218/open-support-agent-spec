import { describe, expect, it } from "vitest";
import pino from "pino";
import { LOG_REDACT_PATHS, loggerOptions } from "./plugins.js";

/**
 * Spec §9 requires log pipelines to redact at least the authorization header,
 * email, phone, and free-text bodies. These tests drive real pino output with
 * the API's own logger options, so they fail if a path is misspelled or
 * dropped — not merely if the config array changes shape.
 */

function capture(): { log: pino.Logger; output: () => string } {
  const chunks: string[] = [];
  const destination = {
    write: (chunk: string): void => {
      chunks.push(chunk);
    },
  };
  const log = pino(loggerOptions, destination as Parameters<typeof pino>[1]);
  return { log, output: () => chunks.join("") };
}

describe("log redaction (spec §9)", () => {
  it("covers the normative paths: authorization, email, phone, bodies", () => {
    for (const required of [
      "req.headers.authorization",
      "*.email",
      "*.phone",
      "req.body",
      "*.body",
    ]) {
      expect(LOG_REDACT_PATHS).toContain(required);
    }
  });

  it("redacts authorization, email, phone, and free-text bodies from real output", () => {
    const { log, output } = capture();
    log.info(
      {
        req: {
          method: "POST",
          url: "/v1/chat",
          headers: { authorization: "Bearer super-secret-token" },
          body: { caseId: "case_refund", message: "customer free text" },
        },
        customer: { email: "vera.verified@example.com", phone: "+15551234567" },
        payload: { body: "unstructured free text" },
        res: { body: { reply: "customer-visible reply text" } },
        tenantId: "tenant_demo",
      },
      "request completed",
    );
    const out = output();
    for (const secret of [
      "super-secret-token",
      "vera.verified@example.com",
      "+15551234567",
      "customer free text",
      "unstructured free text",
      "customer-visible reply text",
    ]) {
      expect(out, `leaked: ${secret}`).not.toContain(secret);
    }
    expect(out).toContain("[redacted]");
  });

  it("keeps operational fields intact", () => {
    const { log, output } = capture();
    log.info(
      { req: { method: "GET", url: "/v1/cases" }, tenantId: "tenant_demo" },
      "request completed",
    );
    const out = output();
    expect(out).toContain("/v1/cases");
    expect(out).toContain("tenant_demo");
  });
});