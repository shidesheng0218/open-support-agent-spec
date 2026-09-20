# RFC 0006: External Policy Decision Point (Optional Tightening Seam)

- **Status:** Draft
- **Authors:** OSAS founding maintainers
- **Created:** 2026-09-14
- **Target line:** OSAS v0.4 Draft candidate; no conformance impact

> **Draft for discussion.** Until this RFC is Accepted, nothing here is
> normative and no implementation work may begin (CONTRIBUTING.md §RFC
> process). The deterministic algorithm in spec §5 remains the only
> conformance-relevant decision path.

## Summary

This RFC proposes an **optional, strictly-tightening seam** between the
normative policy evaluation algorithm and external policy decision points
(PDPs) such as OPA. The normative algorithm keeps full authority over its
existing checks; an external PDP may only *raise* a decision
(`auto_execute → require_approval → block`), never lower it. Conformance is
unchanged: the compat suite continues to test only the normative algorithm.

## Motivation

Spec §5 fixes a deterministic evaluation algorithm: ordered checks over the
tenant policy's declarative rules, worst-of decision. That determinism is a
feature — it is what makes conformance testable at all — but it caps
expressiveness. Real deployments keep running into policies that do not fit
the `PolicyRule` shape: time-windowed velocity limits ("max 3 refunds per
customer per day"), compound conditions over evidence metadata,
organization-specific risk scores, attribute-based rules shared with the rest
of the company's infrastructure.

Today the only escape hatches are bad ones:

- **Fork the evaluator.** The implementation quietly diverges from the spec,
  and its conformance claim stops meaning anything.
- **Encode policy in the model prompt.** The exact failure mode OSAS exists
  to prevent — probabilistic enforcement of a deterministic requirement.
- **Force-fit the rule schema.** `maxAmount` abused as a velocity counter,
  regions abused as risk tiers. The schema stays honest; the policy lies.

Meanwhile, general-purpose policy engines (OPA/Rego being the most deployed)
already solve rich, deterministic, testable policy evaluation — and are
explicitly marketed for AI tool-call enforcement. As of September 2026,
Microsoft's Agent Governance Toolkit (AGT) ships an even closer fit: its Agent
Control Specification is a deterministic, fail-closed policy decision runtime
with a closed verdict set (`allow` / `deny` / `transform` / `escalate`), a
fail-safe approval lifecycle, and Merkle-chained audit. What both lack is the
OSAS domain semantics: proposals, principals, evidence, idempotency, audit.
The useful composition is obvious: **OSAS owns the contract; an external PDP
may contribute stricter decisions.**

The design constraint that makes this safe to standardize: tightening-only
delegation. The normative checks (permission overreach, injection, profile
match, identity, region, evidence, duplicates, thresholds, never-auto-execute)
are all safety invariants. Allowing an external engine to *loosen* them would
let a misconfigured PDP silently disable the spec's security model — so this
RFC forbids it.

## Design

### Definitions

- **Normative evaluation**: the spec §5 algorithm as implemented by
  `evaluateProposal` in `@osas/policy-engine`. Unchanged by this RFC.
- **External PDP**: any implementation-specific policy engine (OPA, a rules
  service, embedded WASM) that an implementation chooses to consult.
- **PDP verdict**: `auto_execute | require_approval | block`, plus optional
  reason codes in the implementation's own namespace (see below).

### The seam

1. Evaluation proceeds exactly as in spec §5, producing the normative
   decision `D_spec` with its reason list.
2. **After** the normative decision — and only if `D_spec` is not already
   `block` — the implementation MAY consult an external PDP with a
   documented, implementation-defined input document (proposal, customer,
   evidence summaries, policy version).
3. The PDP returns a verdict `D_ext`. The final decision is the **worst of**
   `D_spec` and `D_ext` under the existing severity order
   (`block > require_approval > auto_execute`).
4. PDP verdicts carry at least one reason code. Implementation-specific codes
   MUST be namespaced (e.g. `OPA_*`, `X_ACME_*`) so audit readers can
   distinguish them from spec-defined `POLICY_REASON_CODES`.
5. Every consultation is audited: the `AuditEvent` for the evaluation records
   `detail.externalPdp: { system, verdict, reasonCodes, latencyMs }` (keys
   illustrative; the exact audit detail shape is part of the implementation
   PR). PDP unavailability or timeout MUST be treated as `block`
   (fail closed), recorded with a `PDP_UNAVAILABLE`-style code.
6. The PDP is never consulted when `D_spec` is `block`, and its verdict can
   never *lower* the decision: if `D_ext` is less severe than `D_spec`, the
   result is `D_spec`. There is no mechanism — config, flag, or rule — to
   delegate loosening.

### Reference PDPs and verdict mapping

Two concrete reference PDPs are in scope for the implementation PRs. The
mapping from their native verdicts onto the OSAS three-grade decision is:

| External verdict | OSAS effect | Rationale |
|---|---|---|
| AGT `deny` / OPA deny | `block` | Direct. |
| AGT `escalate` (liftable deny carrying an approval) | `require_approval` | Structurally identical to the OSAS approval path — an approval-seeking decision. |
| AGT/OPA `allow` | unchanged (`D_spec` stands) | Tightening-only: an external allow never lowers the normative decision. |
| AGT `transform` | `require_approval` plus the transform's rewrites appended to `decision.transforms` (param transforms) | A transform asserts "the params as submitted are wrong"; that is never auto-executable. A transform must never make a decision more permissive. |
| OPA partial / unparseable / error / timeout | `block` (fail closed, audited) | See rule 5. |

Two non-obvious compatibilities make AGT the primary reference:

- AGT's `escalate` is already "an approval is needed" as a first-class
  verdict — the OSAS `require_approval` state has the same shape, including
  the human-decision lifecycle.
- AGT's `transform` verdict is exactly OSAS's param-transform channel
  (`{ path, op: "redact", replacement? }`) — an external PDP can contribute
  deterministic redactions that ride the existing `PolicyDecision.transforms`
  pipeline into `executeProposal`.

Related hardening worth noting (not part of this RFC): AGT binds each approval
to the action's canonical input hash (`enforced_identity`, re-verified before
execution). OSAS approvals are not yet action-bound; adopting that binding is
a candidate for a future hardening RFC alongside the approval fail-safe
lifecycle.

### What this is not

- Not a replacement for the normative algorithm. An implementation that skips
  spec §5 checks because "the PDP handles it" is non-conformant.
- Not a new decision vocabulary. The three grades stay; the PDP maps its
  internal outcomes onto them (lossy by design).
- Not normative input-shape standardization. The PDP input document is
  implementation-defined in v0.4; a future RFC may standardize a minimal
  input schema if ≥2 implementations converge.

### Conformance boundary

The compat suite tests only the normative algorithm. A conformance claim
("OSAS 0.x ecommerce-compatible") is made against the normative path with no
PDP attached. Implementations MAY ship a PDP-enabled deployment, but:

- the conformance run for the claim MUST be reproducible with the PDP
  disabled or configured to always return the normative decision;
- the capability manifest gains no new fields (PDP usage is not advertised;
  it is an internal control).

## Compatibility

Fully additive and opt-in. No schema changes, no state-machine changes, no
tool-surface changes. `PolicyDecision` may carry additional reason codes
(namespaced) which already conform to `POLICY_REASON_CODES` being an open
list for implementations (spec §5 defines the spec-reserved codes).

Implementations that never attach a PDP are byte-for-byte unaffected, and the
reference implementation will not ship a PDP integration; the seam is
exercised by contract tests with a stub PDP.

## Security

- **Fail closed.** PDP error/timeout → `block`. Tightening-only → a
  compromised or buggy PDP can deny service but cannot authorize anything the
  normative algorithm denied.
- **No credentials to the model (unchanged).** PDP endpoints, credentials,
  and policies live server-side; none of it enters the model context.
- **Auditability improves.** External decisions become explicit audit records
  instead of invisible prompt-conditioning.
- **New attack surface:** the PDP input document may contain customer data;
  implementations MUST apply the same PII-redaction discipline to PDP inputs
  and logs as to model contexts (spec §9).

## Test plan (for the implementation PR, after acceptance)

- Contract tests in `@osas/policy-engine` with a stub PDP: tightening
  (`auto_execute` → `block` via PDP), no-op (`D_ext` ≤ `D_spec`), PDP error →
  `block`, never-consulted-on-block, reason-code namespace preserved in the
  decision and audit detail.
- Compat suite: unchanged and still passing with no PDP attached.
- An `examples/` entry wiring `evaluateProposal` + stub PDP end to end.

## Open questions

- Should the PDP verdict schema (`decision`, `reasonCodes[]`, optional
  `diagnostics`) be spec'd minimally to ease portability between PDPs, or
  left fully implementation-defined in v0.4?
- Is `PDP_UNAVAILABLE` worth reserving as a spec reason code, given it will
  be common to every PDP integration?
