#!/usr/bin/env tsx
/**
 * Export a static OpenAPI 3.1 spec to docs/openapi-v0.2.json
 * for external tool consumption (Postman, Swagger UI, etc.)
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../apps/api/src/openapi.js";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../docs/openapi-v0.2.json");

console.log("Generating static OpenAPI spec...");
const doc = buildOpenApiDocument();

writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");

console.log(`✓ Exported to ${outPath}`);
console.log(`  Spec version: ${(doc.info as any).version}`);
console.log(`  Paths: ${Object.keys((doc as any).paths).length}`);
console.log(`  Schemas: ${Object.keys((doc.components as any).schemas).length}`);
