import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSchemasDir } from "./paths.js";

export interface SchemaManifestEntry {
  name: string;
  profile: "core" | "ecommerce" | "saas" | "tools" | "execution";
  path: string;
}

export interface SchemaManifest {
  specVersion: string;
  schemas: SchemaManifestEntry[];
}

export function loadManifest(schemasDir: string = resolveSchemasDir()): SchemaManifest {
  return JSON.parse(readFileSync(join(schemasDir, "manifest.json"), "utf8")) as SchemaManifest;
}

export function listSchemas(schemasDir: string = resolveSchemasDir()): SchemaManifestEntry[] {
  return loadManifest(schemasDir).schemas;
}

export function loadSchema(
  name: string,
  schemasDir: string = resolveSchemasDir(),
): Record<string, unknown> {
  const entry = loadManifest(schemasDir).schemas.find((s) => s.name === name);
  if (!entry) {
    throw new Error(`Unknown schema: ${name}`);
  }
  return JSON.parse(readFileSync(join(schemasDir, entry.path), "utf8")) as Record<string, unknown>;
}
