import { fileURLToPath } from "node:url";

/**
 * Schemas directory resolution:
 * 1. `process.env.OSAS_SCHEMAS_DIR` override, else
 * 2. repo-root `schemas/`, resolved relative to this module.
 *
 * Depth check: this file lives at packages/schema-validator/src/paths.ts and is
 * compiled to packages/schema-validator/dist/paths.js — both are exactly three
 * levels below the repo root, so "../../../schemas" is correct from either.
 */
export function resolveSchemasDir(): string {
  const override = process.env.OSAS_SCHEMAS_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return fileURLToPath(new URL("../../../schemas", import.meta.url));
}
