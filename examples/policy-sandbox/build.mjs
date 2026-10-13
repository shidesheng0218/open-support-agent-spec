#!/usr/bin/env node
/**
 * Bundles the sandbox into ONE self-contained HTML file with no external
 * requests: no CDN, no npm install, no dev server. Double-click it, or host it
 * anywhere. Run from anywhere:  node examples/policy-sandbox/build.mjs
 */
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The artifact is committed so it can be downloaded and double-clicked with no
// toolchain at all — which is the entire point of this demo. `--out` exists so
// the drift test can build somewhere else and compare.
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outfile =
  outFlag >= 0 && args[outFlag + 1]
    ? path.resolve(args[outFlag + 1])
    : path.join(here, "policy-sandbox.html");

/**
 * The policy-engine barrel re-exports its audit-chain and action-binding
 * modules, which import `node:crypto` for SHA-256. The sandbox exercises
 * neither, but a bundler still has to resolve the import graph.
 *
 * The stub THROWS instead of shipping a hand-rolled SHA-256. A security
 * project's demo must not contain a fake implementation of the very primitive
 * it is demonstrating: if a future scenario ever reaches these paths, it fails
 * loudly rather than hashing wrongly.
 */
const stubNodeCrypto = {
  name: "stub-node-crypto",
  setup(b) {
    b.onResolve({ filter: /^node:crypto$/ }, (args) => ({
      path: args.path,
      namespace: "node-crypto-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "node-crypto-stub" }, () => ({
      loader: "js",
      contents: [
        'const MESSAGE = "node:crypto is not available in the browser sandbox: "',
        '  + "the audit-chain and action-digest helpers are not part of this demo, "',
        '  + "which is why they fail instead of returning a wrong hash";',
        "export function createHash() { throw new Error(MESSAGE); }",
        "export function createHmac() { throw new Error(MESSAGE); }",
        "export function timingSafeEqual() { throw new Error(MESSAGE); }",
        "export function randomUUID() {",
        "  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();",
        "  throw new Error(MESSAGE);",
        "}",
        "export default { createHash, createHmac, timingSafeEqual, randomUUID };",
      ].join("\n"),
    }));
  },
};

const result = await build({
  entryPoints: [path.join(here, "src/main.ts")],
  bundle: true,
  format: "iife",
  target: ["es2022"],
  platform: "browser",
  minify: true,
  legalComments: "none",
  write: false,
  plugins: [stubNodeCrypto],
});

const js = result.outputFiles[0].text;
if (js.includes("</script")) {
  throw new Error("bundle contains a literal </script — would break the host page");
}

const shell = await readFile(path.join(here, "index.html"), "utf8");
// Function replacer: a string replacement would interpret $& / $1 in the bundle.
const html = shell.replace("/*__BUNDLE__*/", () => js);

await mkdir(path.dirname(outfile), { recursive: true });
await writeFile(outfile, html);

const kb = (html.length / 1024).toFixed(1);
console.log(`policy-sandbox: wrote ${path.relative(process.cwd(), outfile)} (${kb} kB, self-contained)`);
