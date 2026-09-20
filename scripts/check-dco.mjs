#!/usr/bin/env node
/**
 * DCO enforcement (see DCO and CONTRIBUTING.md §Developer Certificate of
 * Origin): every non-merge commit in the given range must carry a
 * `Signed-off-by: Name <email>` trailer whose email matches the commit's
 * author or committer. Merge commits are skipped — they are not authored
 * contributions.
 *
 * Usage:
 *   node scripts/check-dco.mjs                    # origin/main..HEAD (falls back to HEAD~1..HEAD)
 *   node scripts/check-dco.mjs <base>..<head>     # explicit range (CI: PR base..head)
 *
 * CI runs this in the `dco` job for pull requests; the checkout needs
 * `fetch-depth: 0` so the range base resolves locally.
 */
import { execFileSync } from "node:child_process";

const ZERO_SHA = /^0{40}$/;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
}

function fail(message) {
  console.error(`check-dco FAILED: ${message}`);
  process.exit(1);
}

function defaultRange() {
  if (tryGit("rev-parse", "--verify", "origin/main")) return "origin/main..HEAD";
  if (tryGit("rev-parse", "--verify", "HEAD~1")) return "HEAD~1..HEAD";
  return undefined;
}

const range = process.argv[2] ?? defaultRange();
if (!range) {
  console.log("check-dco OK: single-commit history with no base to compare; nothing to check");
  process.exit(0);
}

const [base, head] = range.split("..");
if (ZERO_SHA.test(base ?? "") || ZERO_SHA.test(head ?? "")) {
  console.log(`check-dco OK: range ${range} contains an all-zero SHA (first push); nothing to check`);
  process.exit(0);
}
if (!tryGit("rev-parse", "--verify", `${base}^{commit}`)) {
  fail(
    `range base ${base} is not available locally — fetch it first ` +
      "(CI: actions/checkout with fetch-depth: 0)",
  );
}

const commits = git("rev-list", "--no-merges", range).split("\n").filter(Boolean);
const offenders = [];

for (const sha of commits) {
  const authorEmail = git("show", "-s", "--format=%ae", sha).toLowerCase();
  const committerEmail = git("show", "-s", "--format=%ce", sha).toLowerCase();
  const message = git("show", "-s", "--format=%B", sha);
  const signoffEmails = [...message.matchAll(/^Signed-off-by:\s*.+?\s*<([^>]+)>\s*$/gim)].map(
    (match) => match[1].toLowerCase(),
  );
  const matches = signoffEmails.some(
    (email) => email === authorEmail || email === committerEmail,
  );
  if (!matches) {
    offenders.push({ sha, authorEmail, subject: git("show", "-s", "--format=%s", sha) });
  }
}

if (offenders.length > 0) {
  console.error(`check-dco FAILED: ${offenders.length} commit(s) in ${range} lack a sign-off\n`);
  for (const { sha, authorEmail, subject } of offenders) {
    console.error(`  ${sha.slice(0, 12)}  ${subject}`);
    console.error(`      author <${authorEmail}> has no matching Signed-off-by trailer`);
  }
  console.error(
    "\nFix: sign new commits with `git commit -s`. For existing commits either\n" +
      "  git rebase --signoff <base>            # add a sign-off to each\n" +
      "or, if the identity is not yours, do not sign on someone else's behalf —\n" +
      "the commit must be authored and signed by the same person (DCO).\n",
  );
  process.exit(1);
}

console.log(`check-dco OK: ${commits.length} commit(s) in ${range} carry a matching sign-off.`);