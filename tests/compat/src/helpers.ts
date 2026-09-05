import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadManifest,
  resolveSchemasDir,
  validate,
} from "@osas/schema-validator";

export interface ManifestEntry {
  name: string;
  profile?: string;
  path: string;
}

export interface Manifest {
  specVersion: string;
  schemas: ManifestEntry[];
}

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve the repo-level schemas/ directory (works from src/ and dist/). */
export function schemasDir(): string {
  try {
    const dir = resolveSchemasDir();
    if (existsSync(dir)) return dir;
  } catch {
    // fall through to relative resolution
  }
  for (const candidate of [
    resolve(here, "../../../schemas"), // from src/
    resolve(here, "../../../../schemas"), // from dist/
  ]) {
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
  }
  throw new Error("compat-suite: could not locate schemas/ directory");
}

export function getManifest(): Manifest {
  return loadManifest() as Manifest;
}

export function loadSchema(entry: ManifestEntry): Record<string, unknown> {
  const raw = readFileSync(join(schemasDir(), entry.path), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

export function fixturesDir(): string {
  const fromSrc = resolve(here, "fixtures/valid");
  if (existsSync(fromSrc)) return fromSrc;
  return resolve(here, "../src/fixtures/valid");
}

/** Fixture files are named by the basename of the (possibly namespaced) schema name. */
export function fixtureKey(schemaName: string): string {
  return schemaName.split("/").pop() as string;
}

export function loadFixture(name: string): Record<string, unknown> | undefined {
  const file = join(fixturesDir(), `${fixtureKey(name)}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export interface ValidationResultLike {
  valid: boolean;
  errors?: unknown;
}

/** Single adaptation point over @osas/schema-validator's validate(). */
export function validateAgainst(schemaName: string, data: unknown): boolean {
  const result = validate(schemaName, data) as ValidationResultLike | boolean;
  return typeof result === "boolean" ? result : result.valid;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// --- schema walking ---------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Paths (dot-separated, `[]` for arrays) of enum-constrained properties. */
export function findEnumPaths(schema: JsonObject, base = ""): string[] {
  const out: string[] = [];
  const props = isObject(schema.properties) ? (schema.properties as JsonObject) : {};
  for (const [key, sub] of Object.entries(props)) {
    if (!isObject(sub)) continue;
    const path = base ? `${base}.${key}` : key;
    if (Array.isArray(sub.enum)) out.push(path);
    if (isObject(sub.properties)) out.push(...findEnumPaths(sub, path));
    if (isObject(sub.items)) {
      if (Array.isArray(sub.items.enum)) out.push(`${path}[]`);
      if (isObject(sub.items.properties)) out.push(...findEnumPaths(sub.items, `${path}[]`));
    }
  }
  return out;
}

/** True when a subschema looks like Money ({currency, minorUnits}) or a $ref to one. */
function isMoneySchema(sub: JsonObject): boolean {
  if (typeof sub.$ref === "string" && /money/i.test(sub.$ref)) return true;
  const props = isObject(sub.properties) ? (sub.properties as JsonObject) : {};
  return "currency" in props && "minorUnits" in props;
}

/** Paths of Money-typed properties in a schema. */
export function findMoneyPaths(schema: JsonObject, base = ""): string[] {
  const out: string[] = [];
  const props = isObject(schema.properties) ? (schema.properties as JsonObject) : {};
  for (const [key, sub] of Object.entries(props)) {
    if (!isObject(sub)) continue;
    const path = base ? `${base}.${key}` : key;
    if (isMoneySchema(sub)) {
      out.push(path);
      continue;
    }
    if (isObject(sub.properties)) out.push(...findMoneyPaths(sub, path));
    if (isObject(sub.items)) {
      if (isMoneySchema(sub.items)) out.push(`${path}[]`);
      else if (isObject(sub.items.properties)) out.push(...findMoneyPaths(sub.items, `${path}[]`));
    }
  }
  return out;
}

/** Set a value at a dot path (`a.b` / `a[].b` for first array element). */
export function setAtPath(obj: JsonObject, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    if (part.endsWith("[]")) {
      const key = part.slice(0, -2);
      const arr = (cur as JsonObject)[key];
      cur = Array.isArray(arr) ? arr[0] : undefined;
    } else {
      cur = (cur as JsonObject)[part];
    }
    if (!isObject(cur)) return;
  }
  const last = parts[parts.length - 1] as string;
  if (last.endsWith("[]")) {
    const key = last.slice(0, -2);
    const arr = (cur as JsonObject)[key];
    if (Array.isArray(arr) && isObject(arr[0])) arr[0] = value;
    else if (Array.isArray(arr)) arr[0] = value;
  } else {
    (cur as JsonObject)[last] = value;
  }
}

/** Ensure a Money object exists at path (creating `{currency:"USD",minorUnits:0}` if absent). */
export function ensureMoneyAt(obj: JsonObject, path: string): void {
  const parts = path.split(".");
  let cur: JsonObject = obj;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const isLast = i === parts.length - 1;
    if (part.endsWith("[]")) {
      const key = part.slice(0, -2);
      if (!Array.isArray(cur[key])) cur[key] = [];
      const arr = cur[key] as unknown[];
      if (!isObject(arr[0])) arr[0] = isLast ? { currency: "USD", minorUnits: 0 } : {};
      cur = arr[0] as JsonObject;
    } else if (isLast) {
      if (!isObject(cur[part])) cur[part] = { currency: "USD", minorUnits: 0 };
    } else {
      if (!isObject(cur[part])) cur[part] = {};
      cur = cur[part] as JsonObject;
    }
  }
}

/** Delete a top-level key. */
export function withoutKey(obj: JsonObject, key: string): JsonObject {
  const copy = clone(obj);
  delete copy[key];
  return copy;
}

export function listFixtureNames(): string[] {
  return readdirSync(fixturesDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}
