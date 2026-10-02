#!/usr/bin/env node
// Publish-readiness gate for the public npm packages.
// Run: node scripts/check-publish-readiness.mjs  (exit 1 on any failure)
//
// For every public package this script: rebuilds it, packs it with
// `pnpm pack` (which rewrites workspace:* dependency specifiers to real
// versions), and inspects the tarball — asserting the files npm users would
// actually receive. Publishing itself stays a manual maintainer action; this
// gate makes "is it publishable right now" a machine-checkable question.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (msg) => errors.push(msg);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const EXPECTED_VERSION = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")).version;

// Keep in sync with PUBLIC_PACKAGES in scripts/check-version-consistency.mjs.
const PUBLIC_PACKAGES = [
  { dir: "packages/core", name: "@osas/core" },
  { dir: "packages/schema-validator", name: "@osas/schema-validator" },
  { dir: "packages/policy-engine", name: "@osas/policy-engine" },
  { dir: "packages/compat-runner", name: "@osas/compat-runner" },
];

// Per-package extra tarball members beyond the universal baseline.
const EXTRA_MEMBERS = {
  "@osas/schema-validator": ["package/dist/schemas/manifest.json"],
  "@osas/compat-runner": ["package/dist/cli.js"],
};

const BASELINE_MEMBERS = [
  "package/package.json",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/README.md",
  "package/LICENSE",
  "package/NOTICE",
];

/* ---------- 1. LICENSE / NOTICE parity with the repo root ---------- */

const rootLicense = readFileSync(join(root, "LICENSE"));
const rootNotice = readFileSync(join(root, "NOTICE"));
for (const pkg of PUBLIC_PACKAGES) {
  for (const f of ["LICENSE", "NOTICE"]) {
    const p = join(root, pkg.dir, f);
    if (!existsSync(p)) {
      fail(`${pkg.name}: missing ${f} in ${pkg.dir} (copy the repo-root file)`);
      continue;
    }
    const expected = f === "LICENSE" ? rootLicense : rootNotice;
    if (!readFileSync(p).equals(expected)) {
      fail(`${pkg.name}: ${pkg.dir}/${f} differs from the repo-root ${f}`);
    }
  }
}

/* ---------- 2. Build + pack + inspect each tarball ---------- */

for (const pkg of PUBLIC_PACKAGES) {
  const dir = join(root, pkg.dir);
  console.log(`\n[publish-readiness] ${pkg.name}`);
  execFileSync("pnpm", ["run", "build"], { cwd: dir, stdio: "inherit" });

  const tmp = mkdtempSync(join(tmpdir(), "osas-pack-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", tmp], { cwd: dir, stdio: "pipe" });
    const tarballs = execFileSync("ls", [tmp], { encoding: "utf8" }).trim().split("\n").filter((f) => f.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      fail(`${pkg.name}: expected exactly one tarball in ${tmp}, found ${tarballs.length}`);
      continue;
    }
    const tgz = join(tmp, tarballs[0]);
    const members = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n");

    for (const want of [...BASELINE_MEMBERS, ...(EXTRA_MEMBERS[pkg.name] ?? [])]) {
      if (!members.includes(want)) fail(`${pkg.name}: tarball is missing ${want}`);
    }

    // Tests must not ship to npm. Compiling them was also what made this gate
    // depend on prebuilt private workspace packages (compat-runner's test
    // imports @osas/api/app), so it passed locally only when apps/api/dist
    // happened to exist — and failed on a clean CI checkout. Regression guard.
    const shippedTests = members.filter((m) => /\.test\.(js|d\.ts|js\.map)$/.test(m));
    if (shippedTests.length > 0) {
      fail(
        `${pkg.name}: tarball ships compiled tests (${shippedTests.join(", ")}); ` +
          "build with tsconfig.build.json, which excludes src/**/*.test.ts",
      );
    }

    execFileSync("tar", ["-xzf", tgz, "-C", tmp, "package/package.json"]);
    const packed = readJson(join(tmp, "package/package.json"));
    if (packed.version !== EXPECTED_VERSION) {
      fail(`${pkg.name}: packed version ${packed.version} != lockstep version ${EXPECTED_VERSION}`);
    }
    const raw = JSON.stringify(packed);
    if (raw.includes("workspace:")) {
      fail(`${pkg.name}: packed package.json still contains a workspace:* specifier`);
    }
    if (packed.private === true) {
      fail(`${pkg.name}: packed package.json is marked private`);
    }
    rmSync(join(tmp, "package"), { recursive: true, force: true });
    console.log(`  tarball OK: ${tarballs[0]} (${members.length} members)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------- report ---------- */

if (errors.length) {
  console.error(`\npublish-readiness check FAILED (${errors.length} problem(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`\npublish-readiness OK: ${PUBLIC_PACKAGES.length} public packages pack cleanly at ${EXPECTED_VERSION}.`);
