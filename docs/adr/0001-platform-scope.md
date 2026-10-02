# ADR 0001 — Platform scope: a governed control plane, not a single vendor integration

- Status: accepted (M0)
- Date: 2026-01
- Supersedes: none
- Applies to: OSAS spec v0.2 Draft, reference implementation, and every package under `packages/`

## Context

The repository contains a specification, a reference implementation, and
reference adapters for several unrelated providers. The adapters proved the
safety model works end to end: a model proposes, a deterministic policy engine
decides, and only the server executes. They also created a recurring question
the code could not answer on its own:

> Is this product a governance runtime that connects to many systems, or a
> product for one system?

The question matters because the two answers lead to different code. A
single-vendor product is allowed to put vendor concepts in its core schema, its
storage, and its API. A platform is not.

## Decision

**OSAS is a provider-neutral governance platform.** Vendor knowledge lives only
in adapters. The core contract, the governance runtime, and the control-plane
API must remain vendor-agnostic.

Four layers, in dependency order:

1. **OSAS Spec** — normative schemas (`schemas/`): `ActionProposal`,
   `Approval`, `AuditEvent`, `CapabilityManifest`, profiles. Provider-neutral.
2. **Governance Runtime** (`@osas/governance`) — organization, workspace,
   connection lifecycle, event inbox, job queue, reconciliation, case state.
   Provider-neutral.
3. **Adapters** (`@osas/*-adapter`) — the only place a vendor's API shape is
   allowed to appear. Read and write capabilities are declared separately.
4. **Hosted Control Plane** — team collaboration, hosted connections,
   operational tooling, SLA. Not in this repository.

## Consequences

### What this forces

- **No vendor field in a core schema.** A vendor's payload may only appear as an
  opaque snapshot on an application-layer record (`IntegrationEvent.payload`),
  never as a field the policy engine reasons about.
- **Capabilities are declared, not assumed.** A connection states what it may
  do; an undeclared capability is refused rather than attempted. Read and write
  capabilities are distinct strings, and a write capability requires a
  credential reference.
- **The control plane cannot execute.** There is no governance capability that
  performs a business action. Execution stays behind the policy engine, the
  adapter permission ladder, and the server-internal system principal.
- **Adapters stay private packages.** A vendor adapter is not published to npm
  until the adapter interface is stable, so a provider's quirks cannot become
  the platform's public API by accident.

### What this costs

- One more layer of indirection between a provider's event and an action.
- Adapter authors must map their world into provider-neutral records.
- A feature that is easy to bolt onto one provider must be argued for at the
  platform level before it ships.

These costs are accepted. The alternative — a platform whose core quietly
depends on one vendor — is much more expensive to reverse.

## Alternatives considered

**Single-vendor product first.** Faster to a paying integration, but it makes
vendor semantics normative: the core schema would absorb vendor fields, the
policy engine would encode vendor quirks, and every later integration would be a
rewrite. Rejected.

**Adapter-only SDK, no control plane.** Keep the reference implementation as a
library and let each deployment build its own tenancy, queue, and approvals.
Rejected: tenancy, reliable ingest, retry classification, and reconciliation are
exactly the parts that are easy to get subtly wrong, and they are the parts
OSAS claims to make safe.

**Specification only.** Stop maintaining a runtime. Rejected: the spec's claims
are only credible when an implementation demonstrates them, and the reference
implementation is how schema changes get tested.

## Follow-ups

- M2: Policy Studio, approval queue, and audit search on the control plane.
- M2: governance audit events, which require a normative extension of the
  `audit-event` `eventType` enum through the RFC process.
- M3: publish the adapter SDK surface and a third-party adapter contract suite.
