# OSAS Governance

This document describes how the Open Support Agent Spec (OSAS) project is governed
while at v0.x, and the path toward broader, multi-party governance at v1.0.

## Roles

- **Founding maintainers** — the initial maintainer group listed in the repository.
  They own releases, merge decisions, RFC acceptance, and the roadmap.
- **Contributors** — anyone submitting issues, PRs, RFCs, or implementations under
  the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Implementers** — teams building independent implementations of the spec; they
  gain a formal governance seat at v1.0 (see below).

## Decision making

- Day-to-day changes (bug fixes, editorial docs, tests, tooling) are merged by any
  founding maintainer after review and green CI.
- **Breaking changes and new semantics require an RFC** accepted by the founding
  maintainers before implementation begins. This covers schemas, state machines,
  the policy evaluation algorithm, the permission ladder, the MCP tool surface, and
  the adapter interface. See [rfcs/0000-template.md](rfcs/0000-template.md) and
  [CONTRIBUTING.md](CONTRIBUTING.md).
- RFC decisions are made by lazy consensus among founding maintainers; if consensus
  fails, a simple majority of founding maintainers decides.

## Releases

Releases are cut by the founding maintainers. The release gate is normative
(see [CONTRIBUTING.md](CONTRIBUTING.md)):

1. Schemas, EN+ZH documentation, the reference implementation, and the compatibility
   tests change together in the same PR.
2. No spec version is published as stable without runnable examples and passing tests.
3. CI (`build-test`, `compat`, `docker`, `e2e`) must be green on `main`.

## Versioning

The specification, the JSON Schemas, and all `@osas/*` packages share **one semantic
version** and are released in lockstep.

- **v0.x (now):** any minor bump may be breaking; `specVersion` stays `"0.1"` for the
  0.1.x line and is bumped with each new minor spec line.
- **v1.0 and later:** breaking changes require a major version bump; additive changes
  a minor bump; editorial/errata fixes a patch bump.

## Declaring compatibility

An implementation may declare **OSAS profile compatibility** (for `core`,
`ecommerce`, or `saas`) only if the current compatibility suite
(`@osas/compat-suite`) passes against that implementation and the machine-readable
report (`tests/compat/report/latest.json` format) shows `ok: true` for the declared
profile. Compatibility claims must name the spec version tested (e.g. "OSAS 0.1
ecommerce-compatible").

## Path to v1.0

OSAS v0.1 is a Draft. The gates for declaring v1.0:

1. **≥3 independent implementations** (beyond the reference implementation in this
   repository) pass the compat suite for a given profile.
2. All normative documents exist in English and Chinese and are maintained in
   lockstep.
3. No accepted-but-unimplemented RFCs block the core semantics.

Once the v1.0 gates are met, governance will broaden to a **multi-party model** in
which organizations with passing independent implementations hold seats in spec
decisions alongside the founding maintainers. The exact composition will be defined
by an RFC before v1.0 is declared.
