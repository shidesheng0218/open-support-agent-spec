/**
 * Regenerates conformance/fixtures/demo-tenant.json from createDemoFixtures().
 *
 * The TypeScript fixtures in packages/mock-backend/src/fixtures.ts remain the
 * runtime source; this script derives the machine-readable form that
 * independent (non-TypeScript) implementations seed their conformance mode
 * from. Run after editing fixtures.ts:
 *
 *   pnpm --filter @osas/mock-backend build
 *   pnpm --filter @osas/mock-backend fixtures:emit
 *
 * The drift-guard test (src/demo-tenant-fixture.test.ts) fails if the
 * committed JSON no longer matches the runtime fixtures.
 *
 * Timestamp encoding: fixture timestamps are relative to "now" so the dataset
 * never goes stale. In the JSON every timestamp is a token: "now",
 * "now-<N><unit>" or "now+<N><unit>" with unit s|m|h|d (seconds, minutes,
 * hours, days). Implementations materialize tokens against their own clock.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoFixtures } from "../dist/index.js";

const BASE = new Date("2026-01-01T00:00:00.000Z");
const MAX_OFFSET_S = 500 * 86_400;
const UNITS = [
  [86_400, "d"],
  [3_600, "h"],
  [60, "m"],
  [1, "s"],
];

function toToken(value) {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  const offsetS = (ts - BASE.getTime()) / 1000;
  if (!Number.isInteger(offsetS) || Math.abs(offsetS) > MAX_OFFSET_S) return value;
  if (offsetS === 0) return "now";
  const sign = offsetS < 0 ? "-" : "+";
  const abs = Math.abs(offsetS);
  for (const [size, unit] of UNITS) {
    if (abs % size === 0) return `now${sign}${abs / size}${unit}`;
  }
  return `now${sign}${abs}s`;
}

function encode(value) {
  if (typeof value === "string") return toToken(value);
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  }
  return value;
}

const fixtures = encode(createDemoFixtures(BASE));
const out = new URL("../../../conformance/fixtures/demo-tenant.json", import.meta.url);
mkdirSync(dirname(fileURLToPath(out)), { recursive: true });
writeFileSync(fileURLToPath(out), JSON.stringify(fixtures, null, 2) + "\n");
console.log(`wrote ${fileURLToPath(out)}`);
