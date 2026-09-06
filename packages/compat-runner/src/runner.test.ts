import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { buildApp } from "@osas/api/app";
import { runCompat } from "./runner.js";

const CONFORMANCE_KEY = "test-only-conformance-key";
const apps: FastifyInstance[] = [];

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no listening address");
  apps.push(app);
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
});

describe("compat runner against the reference API", () => {
  it("passes all read-only checks; stateful suite is skipped without a conformance key", async () => {
    const target = await listen(await buildApp({ logger: false }));
    const report = await runCompat({ target });
    expect(report.ok).toBe(true);
    expect(report.mode.stateful).toBe(false);
    expect(report.totals.failed).toBe(0);
    const stateful = report.suites.find((s) => s.name === "stateful");
    expect(stateful?.skipped).toBeGreaterThan(0);
  });

  it("passes the full stateful suite against a conformance-enabled target", async () => {
    const target = await listen(
      await buildApp({
        logger: false,
        env: { OSAS_CONFORMANCE_MODE: "true", OSAS_CONFORMANCE_KEY: CONFORMANCE_KEY },
      }),
    );
    const report = await runCompat({ target, conformanceKey: CONFORMANCE_KEY });
    expect(report.mode.stateful).toBe(true);
    expect(report.totals.failed).toBe(0);
    expect(report.ok).toBe(true);
    const stateful = report.suites.find((s) => s.name === "stateful");
    expect(stateful?.passed).toBeGreaterThanOrEqual(8);
  });

  it("fails (non-zero exit semantics) against a target without OSAS endpoints", async () => {
    const stub = Fastify({ logger: false });
    stub.get("/health", async () => ({ status: "ok" }));
    const target = await listen(stub);
    const report = await runCompat({ target });
    expect(report.ok).toBe(false);
    expect(report.totals.failed).toBeGreaterThan(0);
    // CLI maps ok=false to exit code 1. (A 404-only stub still vacuously
    // passes the "unknown version -> 404" probe, so don't assert passed===0.)
  });

  it("fails the stateful suite when the target lacks conformance endpoints", async () => {
    const target = await listen(await buildApp({ logger: false }));
    const report = await runCompat({ target, conformanceKey: CONFORMANCE_KEY });
    expect(report.ok).toBe(false);
    const stateful = report.suites.find((s) => s.name === "stateful");
    expect(stateful?.failed).toBeGreaterThan(0);
  });
});
