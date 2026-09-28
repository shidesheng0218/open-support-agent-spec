/**
 * Bundle the authoritative schemas into dist/schemas at build time, so the
 * published npm package (@osas/schema-validator, and transitively
 * @osas/compat-runner) works standalone — outside the monorepo the
 * repo-relative ../../../schemas path does not exist. In-repo development
 * still resolves the live schemas/ directory first (see paths.ts).
 */
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "..", "schemas");
const dest = join(here, "..", "dist", "schemas");
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`schemas bundled: ${src} -> ${dest}`);
