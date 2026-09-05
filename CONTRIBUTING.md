# Contributing to OSAS

[中文版](CONTRIBUTING.zh-CN.md)

Thank you for helping build the Open Support Agent Spec. This document covers the
contribution flow, development setup, pull-request requirements, and the release gate.
By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md) and license your
work under [Apache-2.0](LICENSE).

## Ways to contribute

- **Spec text and schemas** — clarifications, new fields/objects, profile extensions.
- **Reference implementation** — packages under `packages/`, `apps/`, `tests/`.
- **Compatibility suite** — new conformance cases in `@osas/compat-suite`.
- **Documentation and translations** — EN and ZH documents must stay complete
  equivalents; update both in the same change.
- **Independent implementations** — the most valuable contribution on the road to v1.0;
  see [GOVERNANCE.md](GOVERNANCE.md).

## Development setup

Requirements: Node >= 20 (Node 22 recommended), pnpm 11.

```bash
pnpm install && pnpm build
pnpm dev:api        # API on http://localhost:3001
pnpm dev:web        # Console on http://localhost:5173
pnpm typecheck      # strict TypeScript across the workspace
pnpm test           # build + all unit tests
pnpm test:compat    # compat suite → tests/compat/report/latest.json
pnpm verify         # full release gate: typecheck + tests + compat + docker + health + e2e
pnpm docker:up      # docker compose up --build (console :8080, api :3001)
```

Conventions (fixed by [CONTRACTS.md](CONTRACTS.md)):

- pnpm workspace, npm scope `@osas/*`, all packages `private`, version `0.1.0`.
- TypeScript strict, ESM (`"type": "module"`); relative imports in TS use the `.js`
  suffix (NodeNext).
- Runtime validation with Ajv v8 + ajv-formats only (no other validation libraries).
- Money is `{ currency, minorUnits }` integers — never floats.
- Tests use Vitest, colocated as `src/**/*.test.ts`.
- Do not edit root workspace files (`package.json`, `pnpm-workspace.yaml`,
  `tsconfig.base.json`) unless the change is specifically about them.

## Pull request checklist

Before opening a PR, confirm:

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` pass locally.
- [ ] `pnpm test:compat` passes and the report is regenerated when relevant.
- [ ] Schemas, prose docs, and implementation agree (the schema is the authority).
- [ ] EN and ZH documents are updated together, as complete equivalents.
- [ ] Breaking or new-semantics changes reference an accepted RFC (see below).
- [ ] `CHANGELOG.md` has an entry under Unreleased (or the target version).
- [ ] No real customer data, credentials, or secrets are added anywhere.

## Release gate (normative)

**Schemas, EN+ZH documentation, the reference implementation, and the compatibility
tests MUST change in the same PR.** A spec change without its schema, its tests, its
reference implementation, and its bilingual docs — or any subset missing — is not
mergeable.

**No spec version is published as stable without runnable examples and passing tests.**
CI (`build-test`, `compat`, `docker`, `e2e`) must be green on `main` for any tagged
release.

## RFC process

An RFC is **required** for:

- breaking changes to schemas, state machines, the policy algorithm, the permission
  ladder, the tool surface, or the adapter interface;
- any new semantics (new object kinds, action types, event types, decision codes, …).

Editorial fixes (typos, clarifications that do not change meaning) do not need an RFC.

Process: copy [rfcs/0000-template.md](rfcs/0000-template.md) to
`rfcs/NNNN-short-name.md`, open a PR with Status `Draft`, iterate with maintainer
review, and the RFC is `Accepted` or `Rejected` by the founding maintainers. Only
`Accepted` RFCs may be implemented. See [GOVERNANCE.md](GOVERNANCE.md).

## Versioning

The specification, schemas, and all `@osas/*` packages share one semantic version
(currently `0.1.0`). While v0.x, minor bumps may be breaking; from v1.0, breaking changes
require a major bump. Details in [GOVERNANCE.md](GOVERNANCE.md#versioning).

## Reporting security issues

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
