# OSAS Adopters

This file lists organizations and projects that have adopted OSAS — as an
implementation target, an embedded policy engine, or an integration surface.

**Today the list is empty — deliberately.** OSAS v0.2 is a Draft, and the
reference implementation is demo-grade (see [SECURITY.md](SECURITY.md)). The
meaningful way to appear here is to build against the spec and say so.

## How to get listed

1. **Independent implementations** — follow
   [docs/implementing-osas.md](docs/implementing-osas.md), pass the black-box
   compat runner (read-only + stateful suites), then register via the
   compatibility-claim issue template. Registration lands in
   [conformance/implementations.json](conformance/implementations.json);
   `independent-conforming` entries are also listed here and count toward the
   v1.0 gate.
2. **Integrations and embeddings** — using `@osas/policy-engine` or
   `@osas/core` inside your platform, fronting an OSAS agent with AG-UI, or
   bridging OSAS proposals into your helpdesk? Open a PR adding a row below
   (project, link, how OSAS is used). No conformance run is required for
   integration listings; be precise about what you use.

## Independent implementations

| Implementation | Organization | Profiles | Registry status |
|---|---|---|---|
| — | — | — | — |

## Integrations and embeddings

| Project | How OSAS is used |
|---|---|
| — | — |
