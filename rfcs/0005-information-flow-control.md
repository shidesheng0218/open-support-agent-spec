# RFC 0005: Information Flow Control (Design Note)

- **Status:** Draft <!-- Draft | Accepted | Rejected | Implemented | Superseded -->
- **Authors:** OSAS founding maintainers
- **Created:** 2026-09-14
- **Target line:** post-v0.3 exploration; no conformance impact today

> **This document is a placeholder design note, not a committed feature.**
> Nothing here is normative; no schema, state machine, or policy behavior in
> v0.2/v0.3 depends on it. It exists to structure discussion before any
> implementation work begins.

## Summary

OSAS currently constrains *actions* (what may execute, under which policy) and
offers a single `redact` transform for *outputs*. It has no systematic model of
how information may flow between sources and sinks — e.g. whether PII from a
Customer object may be copied into a case note, an escalation, or a webhook.
This RFC sketches an Information Flow Control (IFC) layer for the support
domain, positioned as a generalization of the existing TenantPolicy transforms.

## Motivation

Peer governance stacks — notably the Microsoft Agent Governance Toolkit —
model IFC explicitly: data carries a **source label**, sinks declare a
**clearance**, and a decision layer allows or denies each flow
(`source label → sink clearance`). Without this, a policy engine can correctly
block a refund while still leaking the customer's card metadata into an
escalation note destined for an external webhook.

OSAS's gaps today:

- `redact` is the only output-side control, applied uniformly; it cannot
  express "PII may flow to `case_note` but only when the identity is verified".
- The audit trail records *actions*; it does not explain *information
  decisions* (why a field was redacted for one sink but not another).
- Multi-tenant isolation is enforced at the object level, not at the
  field/label level within a single tenant.

If we do nothing, adopters will bolt on per-adapter redaction rules that
diverge across implementations and cannot be conformance-tested.

## Design (proposed, non-normative)

### Domain semantics for customer support

**Data levels** (labels attached to fields/objects, similar in spirit to
`reasonCode` extensibility):

| Level | Examples |
|---|---|
| `public` | Knowledge articles, order status, public tracking links |
| `internal` | Case metadata, agent notes without PII |
| `pii` | Name, email, address, phone from Customer |
| `financial` | Card metadata, refund amounts, credit balances |

**Sinks** (destinations information can flow to):

- `case_note` — internal note on the case
- `escalation` — human escalation packet
- `webhook` — outbound third-party integration
- `model_context` — what is included in the model's prompt/context

**Rule shape** (declarative, lives in TenantPolicy):

```text
allow pii -> case_note only if identity_verified
deny financial -> webhook
allow financial -> escalation only if escalation.priority >= high
```

Evaluation stays deterministic: a rule set has an explicit default-deny, worst-
of composition, and machine-readable reason codes (new codes such as
`FLOW_DENIED`, `CLEARANCE_INSUFFICIENT`).

### Relationship to TenantPolicy transforms

Transforms are the **execution mechanism subset** of IFC: `redact` is what a
denied flow looks like at the sink boundary (drop the field instead of
rejecting the whole action). Proposed layering:

1. IFC decides whether a flow `field → sink` is allowed (possibly conditioned
  on case facts like `identity_verified`).
2. If denied, the transform layer applies the sink's default: `redact`,
  `block`, or `require_approval` — reusing the existing transform machinery
  instead of inventing a parallel one.

This keeps one policy document, one evaluation engine, and one audit stream.

### Audit

Information-flow decisions MUST be audit events (hash-chained like action
decisions) carrying `{ flow, sourceLabel, sink, decision, reasonCode }`, so a
regulator or customer can ask "why was the card field missing from this
escalation?" and get a deterministic answer.

## Compatibility

No impact on existing persisted objects, `specVersion`, endpoints, or tool
surfaces — everything above is additive. New schema candidates:
`schemas/core/information-flow-rule.json` (post-v0.3). The compat suite would
gain an `information-flow` group only after an Accepted RFC lands; the release
gate (schemas + EN/ZH docs + reference implementation + compat tests in one
PR) applies.

## Security

Primarily defensive: closes the "leak via escalation/webhook/context" channel
that action-level policies miss. New attack surface is small but real — label
spoofing by the model (mitigated by labels being engine-attached, never
model-supplied) and rule complexity (mitigated by keeping the same
deterministic, default-deny evaluation semantics as §5).

## Test plan (if accepted)

- Unit: label attachment, rule evaluation, worst-of composition, default deny.
- Compat suite group `information-flow`: PII→case_note allowed when verified,
  denied otherwise; financial→webhook always denied; audit events chained.
- Runner: conformance reset seeds cases covering each rule shape.

## Open questions

1. **Label granularity** — per-field labels require schema annotations on core
   objects (a schema-affecting change); per-object labels are cheaper but
   coarser. Which ships first?
2. **Dynamic conditions** — rules conditioned on case facts (e.g.
   `identity_verified`) blur "deterministic policy" and "contextual policy".
   What facts are in scope, and who attests them?
3. **Model context as a sink** — treating `model_context` as a sink would let
   policies control what the model ever sees, but it interacts with prompt
   assembly in the adapter/MCP layer. Is that in-spec or out of scope?
4. **Relationship to multi-party governance (RFC 0004)** — do tenant admins
   author flow rules, or only the platform? Who resolves conflicts between
   tenant and platform rules?
5. **Overlap with redact-only deployments** — can an implementation claim
   conformance with IFC fully emulated by `redact` transforms, or is a
   distinct engine required for the claim?
