# Maintainer Onboarding

[中文版](maintainer-onboarding.zh-CN.md)

This document is for new maintainers and reviewers: how the repository fits
together, which invariants you are trusted to protect, and how to run every gate
locally before CI has to. Contributors should start with
[CONTRIBUTING.md](../CONTRIBUTING.md) instead.

## The architecture in one paragraph

The **schemas** (`schemas/`, JSON Schema draft 2020-12) are the machine-checkable
authority — where prose and schema disagree, the schema wins. `@osas/core` holds
types, enums, state machines, and `detectInjection`; `@osas/schema-validator` is the
Ajv loader over the schemas; `@osas/policy-engine` is the deterministic decision
point (evaluation, permission ladder, execution orchestration, audit hash chain).
Around that core: `@osas/model-gateway` (provider abstraction, budgets, telemetry),
`@osas/adapter` plus mock/Zendesk/Shopify/Chatwoot adapter implementations,
`@osas/mcp-server` (the 20-tool MCP surface), `apps/api` (Fastify HTTP), `apps/web`
(the console), and the verification stack (`tests/compat`, `@osas/compat-runner`,
`evals/`, `tests/e2e`). [CONTRACTS.md](../CONTRACTS.md) is the single shared
contract that keeps independently-built parts from drifting — read it before
changing anything structural.

## The invariants you protect

These are the properties that make OSAS worth trusting. A PR that weakens any of
them is a security regression, not a design choice:

1. **Models never execute.** Model principals are capped at `request-approval`;
   `executeAction` is never an MCP tool; only the server side moves a proposal to
   `executing`.
2. **Fail closed everywhere.** Demo auth refuses production; `live` execution
   refuses to start; conformance mode refuses production; unconfigured adapters
   refuse rather than fake success; unknown costs are recorded as *unknown*, never
   fabricated.
3. **No blind retries.** Terminal proposal states stay terminal; `uncertain` goes to
   human reconciliation; a new attempt is a new proposal with a new idempotency key.
4. **Default deny.** Unmatched actions block; the policy default decision is
   `block`.
5. **The audit trail explains everything.** Every state change emits a hash-chained
   audit event; log redaction paths stay intact.
6. **Schemas and docs move with code.** The release gate requires schemas, EN+ZH
   docs, the reference implementation, and the compat tests in the same PR.

## The gates, and how to run them locally

| Gate | Command | What it proves |
|---|---|---|
| Version consistency | `pnpm check:versions` | One lockstep version, SPEC_VERSION, no stale tool counts or version claims in docs |
| CI workflow shape | part of `pnpm test` | CI runs test before typecheck; compat builds first |
| DCO | `pnpm check:dco` | Every PR commit carries a matching Signed-off-by |
| Build + unit tests | `pnpm test` | Strict TS across the workspace; all package suites |
| White-box compat | `pnpm test:compat` | 345 checks: schemas, tool mapping, state machines, policy matrix, idempotency |
| Black-box compat | `pnpm osas:compat -- --target <url> --conformance-key <k>` | Registry-grade `gateOk` over HTTP |
| Offline evals | `pnpm eval:policy` (+ `:after-sales`, `:controlled`) | Hard gates: 100% schema-valid, 100% policy-consistent, 0 overreach/duplicates/bypass |
| Publish readiness | `pnpm check:publish` | The four public packages pack cleanly (dist, README, LICENSE, NOTICE; no `workspace:*` left) |
| Full release gate | `bash scripts/verify.sh` | All of the above plus Docker and e2e |

CI mirrors these as jobs (`build-test`, `compat`, `python-compat`, `docker`, `e2e`,
`publish-dry-run`, `dco` on PRs). If CI fails, reproduce locally with the matching
row before asking anyone to look.

## RFC process

Breaking changes and new semantics (schemas, state machines, the evaluation
algorithm, the permission ladder, the MCP tool surface, the adapter interface)
require an RFC **before** implementation:

`Draft` → maintainer review → `Accepted` / `Rejected` → schemas + implementation +
tests + bilingual docs all merged → `Implemented`. `Superseded` marks an RFC
replaced by a newer one. Only `Accepted` RFCs may be implemented. Template:
[rfcs/0000-template.md](../rfcs/0000-template.md).

## Releases

Releases are cut by the founding maintainers against the normative release gate
(CONTRIBUTING.md): schemas + EN+ZH docs + implementation + compat tests in the same
PR; no stable release without runnable examples and passing tests; CI green on
`main`. The mechanical publishing steps live in
[docs/release-checklist.md](release-checklist.md).

## Your first week

- [ ] Run `pnpm install && pnpm test && pnpm eval:policy` from a clean checkout.
- [ ] Run the three demo scenarios (`docker compose up --build`, open the console,
      `/demo`) and read the audit trail they produce (`/platform`).
- [ ] Read the spec §4–§6 (permission ladder, evaluation algorithm, execution) and
      then `packages/policy-engine/src/evaluate.ts` — the code should read like the
      spec with the prose removed.
- [ ] Read the threat model and find the test named for each threat row.
- [ ] Review one open PR against the invariants above, not against taste.
- [ ] Merge nothing until `pnpm check:versions`, unit tests, and eval gates pass
      locally.

## Where things live

| Question | Authoritative place |
|---|---|
| Data shapes | `schemas/` (machine-checkable) + `docs/spec-v0.2.md` (prose) |
| Engineering invariants | [CONTRACTS.md](../CONTRACTS.md) |
| Decision rules, versioning, v1.0 gates | [GOVERNANCE.md](../GOVERNANCE.md) |
| Security baseline + reporting | [SECURITY.md](../SECURITY.md) |
| Threats → defenses → tests | [docs/threat-model.md](threat-model.md) |
| Publishing mechanics | [docs/release-checklist.md](release-checklist.md) |
| Production deployment path | [docs/production-hardening.md](production-hardening.md) |