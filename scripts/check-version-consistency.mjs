#!/usr/bin/env node
// Version-consistency gate for the OSAS v0.2 line.
// Run: node scripts/check-version-consistency.mjs  (exit 1 on any failure)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];

const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const read = (rel) => readFileSync(join(root, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

/* ---------- 1. package versions (lockstep 0.2.0) ---------- */

const EXPECTED_VERSION = "0.2.0";
const EXPECTED_SPEC = "0.2";
const PUBLIC_PACKAGES = new Set([
  "@osas/core",
  "@osas/schema-validator",
  "@osas/policy-engine",
]);

const pkgFiles = ["package.json"];
for (const dir of ["packages", "apps", "tests", "examples"]) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `${dir}/${entry.name}/package.json`;
    if (existsSync(join(root, rel))) pkgFiles.push(rel);
  }
}
if (existsSync(join(root, "evals/package.json"))) pkgFiles.push("evals/package.json");

const versions = new Map();
for (const rel of pkgFiles) {
  const pkg = readJson(rel);
  const label = `${rel} (${pkg.name ?? "root"})`;
  versions.set(pkg.name ?? rel, pkg.version);
  if (pkg.version !== EXPECTED_VERSION) {
    fail(`${label}: version is "${pkg.version}", expected "${EXPECTED_VERSION}"`);
  }
  // Publish policy: only the three public packages may be non-private.
  if (rel === "package.json") continue;
  if (PUBLIC_PACKAGES.has(pkg.name)) {
    if (pkg.private === true) {
      fail(`${label}: expected public npm package (private must not be true)`);
    }
  } else if (pkg.private !== true) {
    fail(
      `${label}: not in the public publish set {${[...PUBLIC_PACKAGES].join(", ")}} but is not "private": true`,
    );
  }
  // No package metadata may still claim specVersion "0.1".
  if (typeof pkg.description === "string" && /specVersion\s*\\?"v?0\.1(?![\d.])/.test(pkg.description)) {
    fail(`${label}: description still references specVersion "0.1"`);
  }
}

/* ---------- 2. SPEC_VERSION constants ---------- */

for (const rel of ["packages/core/src/enums.ts", "apps/api/src/plugins.ts"]) {
  const m = read(rel).match(/SPEC_VERSION\s*=\s*"([^"]+)"/);
  if (!m) fail(`${rel}: SPEC_VERSION constant not found`);
  else if (m[1] !== EXPECTED_SPEC) fail(`${rel}: SPEC_VERSION is "${m[1]}", expected "${EXPECTED_SPEC}"`);
}

/* ---------- 3. schemas ---------- */

{
  const common = readJson("schemas/core/common.json");
  let found;
  const walk = (node) => {
    if (found !== undefined || node === null || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "SpecVersion" && v && typeof v === "object" && "const" in v) {
        found = v.const;
        return;
      }
      walk(v);
    }
  };
  walk(common);
  if (found !== EXPECTED_SPEC) {
    fail(`schemas/core/common.json: SpecVersion const is "${found}", expected "${EXPECTED_SPEC}"`);
  }
}
{
  const manifest = readJson("schemas/manifest.json");
  if (manifest.specVersion !== EXPECTED_SPEC) {
    fail(`schemas/manifest.json: specVersion is "${manifest.specVersion}", expected "${EXPECTED_SPEC}"`);
  }
}

/* ---------- 4. compat report ---------- */

{
  const compatVersion = versions.get("@osas/compat-suite");
  const reportSrc = read("tests/compat/src/report.ts");
  const gen = reportSrc.match(/@osas\/compat-suite@([\d.]+)/);
  if (!gen) fail(`tests/compat/src/report.ts: generator tag not found`);
  else if (gen[1] !== compatVersion) {
    fail(`tests/compat/src/report.ts: generator "@osas/compat-suite@${gen[1]}" != package version "${compatVersion}"`);
  }

  const latest = "tests/compat/report/latest.json";
  if (existsSync(join(root, latest))) {
    const report = readJson(latest);
    if (report.specVersion !== EXPECTED_SPEC) {
      fail(`${latest}: specVersion is "${report.specVersion}", expected "${EXPECTED_SPEC}"`);
    }
    if (typeof report.generator === "string" && !report.generator.endsWith(`@${compatVersion}`)) {
      warn(`${latest}: generator "${report.generator}" != "@osas/compat-suite@${compatVersion}" (regenerate the report)`);
    }
  } else {
    warn(`${latest} not present (generated artifact; run pnpm test:compat) — skipped`);
  }
}

/* ---------- 4b. canonical tool/document consistency ---------- */

{
  const toolSchemaNames = readdirSync(join(root, "schemas/tools"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
  const toolSource = read("packages/mcp-server/src/tool-definitions.ts");
  const sourceNames = [...toolSource.matchAll(/name:\s*"(osas_[^"]+)"/g)]
    .map((m) => m[1])
    .sort();
  if (toolSchemaNames.length !== 20) {
    fail(`schemas/tools: expected 20 tool schemas, found ${toolSchemaNames.length}`);
  }
  if (sourceNames.length !== toolSchemaNames.length || sourceNames.some((name, i) => name !== toolSchemaNames[i])) {
    fail("packages/mcp-server/src/tool-definitions.ts and schemas/tools are not a 1:1 canonical tool list");
  }
  for (const rel of ["README.md", "README.zh-CN.md", "rfcs/0002-osas-as-mcp-governance-profile.md"]) {
    const text = read(rel);
    if (/\b16 tools\b|16 个 MCP 工具|16 个工具/i.test(text)) {
      fail(`${rel}: stale 16-tool claim; current canonical tool count is 20`);
    }
  }
}

/* ---------- 5. historical spec files must exist ---------- */

for (const rel of ["docs/spec-v0.1.md", "docs/spec-v0.1.zh-CN.md"]) {
  if (!existsSync(join(root, rel))) fail(`${rel}: missing — restore the historical v0.1 spec (git show HEAD:${rel})`);
}

/* ---------- 6. current docs must not present 0.1 as current ---------- */

// Lines with these markers mention 0.1.x as history (release provenance,
// milestone labels) and are allowed.
const HISTORICAL =
  /(introduced|added in|since v?0\.1|pre-0\.1|Milestone|里程碑|引入|新增|历史|historical|superseded|retained|extensions?\b|扩展|首次发布|shipped in)/i;

const CURRENCY_RULES = [
  { re: /\bcurrent\b[^\n]{0,60}\bv?0\.1\b/i, why: `presents 0.1 as "current"` },
  { re: /当前[^\n]{0,30}v?0\.1\b/, why: `presents 0.1 as 当前 (current)` },
  { re: /specVersion["'`\s]*[:=]["'`\s]*v?0\.1(?![\d.])/i, why: `claims specVersion 0.1` },
  { re: /\bv?0\.1\.[01x]\b/, why: `stale "0.1.1"/"0.1.0"/"0.1.x" reference without a historical marker`, historicalOk: true },
];

// spec-v0.2 keeps v0.1.1 provenance annotations (history of when extensions
// were introduced), so it is scanned for currency claims only, not rule 4.
const PROVENANCE_EXEMPT = new Set(["docs/spec-v0.2.md", "docs/spec-v0.2.zh-CN.md"]);
const SCAN_FILES = [
  "README.md",
  "README.zh-CN.md",
  "CONTRACTS.md",
  "CONTRIBUTING.md",
  "CONTRIBUTING.zh-CN.md",
  "SECURITY.md",
  "GOVERNANCE.md",
  "CHANGELOG.md",
  ".env.example",
  ...readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md") && !/^spec-v0\.1/.test(f))
    .map((f) => `docs/${f}`),
  ...readdirSync(join(root, "packages"))
    .flatMap((d) => [`packages/${d}/README.md`, `packages/${d}/README.zh-CN.md`])
    .filter((rel) => existsSync(join(root, rel))),
];

for (const rel of SCAN_FILES) {
  let text = read(rel);
  if (rel === "CHANGELOG.md") {
    // Only the Unreleased / latest-release sections are "current"; historical
    // 0.1.x entries below the first "## [0.1" heading may keep their versions.
    const cut = text.search(/^## \[0\.1/m);
    if (cut >= 0) text = text.slice(0, cut);
  }
  const rules = PROVENANCE_EXEMPT.has(rel) ? CURRENCY_RULES.slice(0, 3) : CURRENCY_RULES;
  text.split("\n").forEach((line, i) => {
    for (const rule of rules) {
      if (!rule.re.test(line)) continue;
      if (rule.historicalOk && HISTORICAL.test(line)) continue;
      fail(`${rel}:${i + 1}: ${rule.why}\n    > ${line.trim()}`);
    }
  });
}

/* ---------- report ---------- */

for (const w of warnings) console.warn(`WARN: ${w}`);
if (errors.length) {
  console.error(`\nversion-consistency check FAILED (${errors.length} problem(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `version-consistency OK: ${pkgFiles.length} packages at ${EXPECTED_VERSION}, SPEC_VERSION "${EXPECTED_SPEC}", schemas and current docs consistent.`,
);
