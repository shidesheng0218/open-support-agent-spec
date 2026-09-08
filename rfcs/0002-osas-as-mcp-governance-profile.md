# RFC 0002: OSAS as a governance profile for the MCP/A2A ecosystem

- **Status:** Draft
- **Authors:** OSAS founding maintainers
- **Created:** 2026-09-07

## Summary

This RFC states OSAS's positioning relative to the horizontal agent protocols —
MCP (agent↔tools), A2A (agent↔agent), and AG-UI (agent↔UI) — and commits the
project to a specific role: **OSAS is the vertical governance profile for
customer-support agents on top of those protocols, not a competitor to them.**
It introduces no schema or state-machine changes; it fixes the project's
integration posture, non-goals, and the conformance story that third-party
implementations are asked to target.

## Motivation

Since RFC 0001, the horizontal protocols have consolidated: MCP is the de-facto
agent-to-tool standard (Linux Foundation governance, near-universal client
support), A2A covers cross-platform agent coordination, and both are being
adopted faster than the governance frameworks around them. The widely
acknowledged gap is not connectivity — it is control: who may write what, under
which policy, with what evidence, and how every step is audited and replayed.

OSAS already sits exactly in that gap, but its positioning was implicit. Without
an explicit statement we face two failure modes:

1. **Perceived as "yet another protocol."** Developers are fatigued by protocol
   fragmentation; a spec that looks like it competes with MCP/A2A will be
   dismissed before its governance content is evaluated.
2. **No onboarding path for independent implementations.** The v1.0 gate
   requires ≥3 independent implementations passing the compat suite
   (GOVERNANCE.md "Path to v1.0"), and today there is no documented path for a
   team that already runs MCP-based tooling to adopt OSAS governance semantics.

If we do nothing, OSAS risks being ignored as redundant while the governance
vacuum it targets is filled by closed, vendor-specific guardrails.

## Design

Positioning commitments (normative for the project's direction, not for the
schema level):

1. **MCP remains the tool transport.** The OSAS tool surface (16 tools across
   the `core`/`ecommerce`/`saas` profiles) is and stays MCP-native; new tool
   transports MUST NOT be introduced. An implementation may expose the tools
   over plain HTTP in addition, as the reference API does, but MCP support is
   part of the profile contract.
2. **OSAS governs what horizontal protocols deliberately leave open.** The
   spec's ownable surface is: the permission ladder (`read` → `draft` →
   `request-approval` → `execute`, models capped at `request-approval`),
   deterministic policy evaluation, proposal/approval/handoff state machines,
   idempotent execution with reconciliation, evidence anchoring, and the
   `AuditEvent` hash chain. Semantics that MCP/A2A already standardize
   (transport, discovery framing, agent cards) MUST NOT be re-specified here.
3. **Composability with A2A and AG-UI is encouraged, not specified.** A
   deployment MAY front an OSAS-conformant agent with AG-UI for approvals UX,
   or coordinate it with other agents over A2A; OSAS conformance is unaffected
   by either. Future RFCs MAY define an OSAS delegation profile for A2A if
   multi-agent refund/escalation flows demand it.
4. **Embedding is a first-class adoption path.** The deterministic policy
   engine (`@osas/policy-engine`) is designed to be embeddable into existing
   support platforms without adopting the OSAS API or MCP server. Embedding
   alone does not constitute profile compatibility; compatibility claims follow
   GOVERNANCE.md "Declaring compatibility" and must pass the compat suite for
   the declared profile.
5. **The conformance path for third parties is documented and black-box.**
   `docs/implementing-osas.md` (EN/ZH) describes the minimal implementation
   surface per profile and how to verify with `@osas/compat-runner` over HTTP
   only. Compatibility claims name the spec version tested.

Non-goals: a general-purpose agent protocol; a channel/inbox product;
governance semantics for domains outside customer support (a future RFC may
consider generalization once ≥3 independent support implementations exist).

## Compatibility

RFC 0002 itself adds no new runtime actions: it introduces no schema,
state-machine, tool-surface, or API change, and constrains future work
(transports, non-goals) rather than existing behavior. However, **v0.2 is a
new specification line**: it ships with a `specVersion` bump from `"0.1"` to
`"0.2"` (per GOVERNANCE.md "Versioning", a new minor spec line bumps
`specVersion`), and that change is not transparent to implementers. The
`specVersion` change requires implementers to re-run the compatibility suite
against the v0.2 spec and schemas and to upgrade per the migration notes in
CHANGELOG.md `[0.2.0]`; compatibility declarations must name `specVersion`
`"0.2"` (see `docs/implementing-osas.md`).

## Security

The positioning strengthens the security story rather than changing it: by
refusing to respecify transport/security mechanisms that MCP already defines,
OSAS avoids diluting its normative security requirements (spec §9) and avoids
encouraging parallel, weaker tool paths. Risk: implementers may treat embedding
the policy engine as "compliant enough"; mitigated by commitment 4's explicit
statement that compatibility requires the compat suite, and by the
`docs/implementing-osas.md` guidance.

## Test plan

No new runtime behavior. Documentation deliverables accompanying this RFC:

- `docs/implementing-osas.md` + `docs/implementing-osas.zh-CN.md` — third-party
  implementation and conformance guide.
- `packages/policy-engine/README.md` (+ zh-CN) and a runnable minimal embedding
  example under `examples/embed-policy-engine/`.
- A second reference adapter (`@osas/chatwoot-adapter`) demonstrating the
  adapter contract against an open-source helpdesk, with mock-HTTP tests.

Validation: `pnpm verify` green (build, unit/contract tests, compat suite,
Docker boot, E2E), the embedding example runs, and the compat runner passes
against the reference API as before.
