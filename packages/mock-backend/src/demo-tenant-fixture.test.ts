import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDemoFixtures, type DemoFixtures } from "./fixtures.js";

/**
 * Drift guard for conformance/fixtures/demo-tenant.json — the machine-readable
 * demo dataset that independent implementations seed their conformance mode
 * from. The JSON must always match createDemoFixtures() exactly (at a fixed
 * clock); regenerate it with `pnpm --filter @osas/mock-backend fixtures:emit`.
 */

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const FIXTURE_URL = new URL("../../../conformance/fixtures/demo-tenant.json", import.meta.url);

const TOKEN = /^now(?:([+-])(\d+)([smhd]))?$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function materialize(value: unknown, base: Date): unknown {
  if (typeof value === "string") {
    const m = TOKEN.exec(value);
    if (!m) return value;
    if (m[1] === undefined) return base.toISOString();
    const delta = Number(m[2]) * UNIT_MS[m[3]!]! * (m[1] === "-" ? -1 : 1);
    return new Date(base.getTime() + delta).toISOString();
  }
  if (Array.isArray(value)) return value.map((v) => materialize(v, base));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, materialize(v, base)]),
    );
  }
  return value;
}

describe("conformance/fixtures/demo-tenant.json", () => {
  it("materializes to exactly createDemoFixtures() at a fixed clock", () => {
    const json: unknown = JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), "utf8"));
    const materialized = materialize(json, FIXED_NOW);
    expect(materialized).toEqual(createDemoFixtures(FIXED_NOW) as DemoFixtures);
  });

  it("encodes every timestamp as a relative now-token (never a stale absolute date)", () => {
    const raw = readFileSync(fileURLToPath(FIXTURE_URL), "utf8");
    // ISO-8601 timestamps must not appear; every timestamp is a now±N<unit> token.
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
