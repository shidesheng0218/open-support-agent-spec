# RFC 0008: Action-Bound Approvals

- **Status:** Accepted
- **Authors:** OSAS founding maintainers
- **Created:** 2026-09-28
- **Target line:** v0.2.x — backward-compatible additive hardening; no conformance impact
- **Acceptance provenance:** accepted by the founding maintainers via the approved
  implementation plan of 2026-09-28; the schema change, reference implementation,
  tests, and bilingual docs land in the same change. Flips to `Implemented` on merge.

## Summary

An Approval now carries an optional `actionDigest`: SHA-256 over the canonical
(key-sorted, stable-JSON) serialization of `{ actionType, params }` of the proposal
it approves. The execution boundary re-computes the digest from the proposal it is
about to execute and refuses to run when the two differ — closing the
time-of-check/time-of-use gap between "a human approved this" and "this is what
executes." The pattern is borrowed from Microsoft AGT's `enforced_identity`
(ADR-0030); this RFC adapts it to OSAS's existing approval lifecycle and audit chain.

## Motivation

Today an approval authorizes a *proposal reference*, not an *action*. Between the
decision and the execution, three things can silently diverge:

1. **Store tampering or corruption.** A proposal's `params` are mutated in place
   (buggy store, compromised store, stray migration) after approval; execution then
   performs an action nobody approved.
2. **Wrong wiring.** A buggy integration executes proposal B while holding the
   approval for proposal A.
3. **Audit ambiguity.** When disputing an execution, there is no cryptographic link
   between the human's decision and the exact action input — only two rows that
   *reference* each other.

OSAS already closes the stale-approval hole (RFC-era approval fail-safe, threat T13:
deny-only timeouts). But an approval that is *fresh* and yet authorizes a *different*
action is still possible. The competitive deep dive (docs/competitive-deep-dive.md
§3.1) identified this as the single clearest capability gap against AGT, whose
ADR-0030 binds every approval to `SHA-256(JCS(action input))` and re-verifies at
execution time with seven atomic checks. OSAS does not need AGT's full chain-entry
machinery to get the core property; it needs one digest, stamped once, verified once.

What happens if we do nothing: every "the human approved it" story rests on
referential integrity of mutable rows — the weakest link in the audit trail for the
class of action OSAS exists to govern (money-moving writes).

## Design

### The digest

`actionDigest = lowercase_hex( SHA-256( UTF-8( stableJSON({ actionType, params }) ) ) )`

- `stableJSON` is the exact canonicalization already specified for the audit hash
  chain (spec §12.3, `docs/implementing-osas.md` "Reproducing the audit hash chain"):
  keys sorted by UTF-16 code unit, no whitespace, no `eventHash`-style exclusions.
- The digest covers the proposal **as approved** — the pre-transform `params`. Param
  transforms (spec §5) are deterministic policy rewrites applied at execution; they
  do not change what the human approved, so they do not change the digest.
- The digest does **not** cover `caseId`/`amount` separately: `amount` is part of the
  canonical action input only if the implementation places it inside `params`.
  (v0.2 reference: `params` carries the action payload; `amount` is mirrored at the
  top level for policy evaluation. See "Open questions".)

### Stamping (creation time)

When the policy decision is `require_approval`, the server creates the `Approval`
with `actionDigest` computed from the proposal (spec §2.6 gains the field;
`schemas/core/approval.json` gains an optional `actionDigest` matching
`^[0-9a-f]{64}$`). Auto-executed proposals carry **no** approval and are unaffected —
their gate is the policy decision itself, stamped on `proposal.policyDecision`.

### Verification (execution time)

`executeProposal` gains an optional binding parameter. When the caller supplies an
`actionDigest`, the engine MUST recompute the digest from the proposal it was given
and MUST throw `ActionBindingMismatchError` (`ACTION_BINDING_MISMATCH`) **before**
any state transition, replay lookup, transform, or adapter call when the digests
differ. When no digest is supplied (legacy approvals created before this RFC, or
embedded engine use without the binding), the check is skipped — the field is
additive and optional, and existing behavior is unchanged.

The API execution path loads the decided approval for the proposal and always passes
the binding, so the check is unconditional for API-driven executions. A mismatch is
audited as `action_binding_mismatch_blocked` (new AuditEventType) and returned to
the caller as 409 `ACTION_BINDING_MISMATCH`. The proposal is **not** transitioned;
a human must review the divergence (the proposal can be rejected and re-created).

### One-time consumption

Already covered by existing mechanics: a successful execution moves the proposal to
a terminal state (`executed`/`failed`), the status guard refuses re-execution of a
non-`approved` proposal, and the `(tenantId, idempotencyKey)` store replays without
side effects. This RFC adds no new consumption machinery; it binds *what* the single
permitted execution may be.

### Relationship to the approval fail-safe

Orthogonal and complementary: expiry (T13) bounds *how long* an approval lives;
binding bounds *what* it authorizes. Expiry is evaluated at decide time; binding is
evaluated at execute time. An approval must pass both.

## Compatibility

- **Schemas:** `approval.json` gains one optional field; `audit-event.json`'s
  `eventType` enum gains one value. Both are additive; previously valid documents
  remain valid. `additionalProperties: false` means older strict validators reject
  *new* documents carrying `actionDigest` — acceptable during v0.x (minor-line
  evolution per GOVERNANCE.md), and the shared `schemas/` directory keeps the in-repo
  implementations in lockstep.
- **Conformance:** unchanged. The black-box runner gains no checks in this pass; the
  property is enforced in the engine and proven by white-box tests. A future
  conformance profile MAY probe it.
- **API/MCP surface:** unchanged (one new error code on the execution path).
- **Persisted objects:** approvals created before this RFC lack `actionDigest` and
  continue to work (check skipped).

## Security

- **Closes:** approval/execution TOCTOU, wrong-proposal wiring, and audit ambiguity
  for approved writes (threat classes T6/T8-adjacent; a new threat-model entry is
  added).
- **No new credentials or secrets**; the digest is content-derived.
- **Algorithm agility:** SHA-256 over stable JSON, same primitive as the audit chain;
  a future RFC can version the digest (`sha256:…` prefix) if a migration is ever
  needed.
- **Denial-of-service note:** an attacker who can corrupt the store can now trigger
  execution refusal — but refusal is the safe direction (fail closed), and such an
  attacker already loses to the audit hash chain.

## Test plan

- `@osas/policy-engine` (white-box):
  - digest is deterministic and key-order-independent;
  - tampered `params` → `ActionBindingMismatchError` before any adapter call
    (adapter call count stays 0);
  - matching digest → executes normally;
  - absent digest → check skipped (backward compatibility);
  - expiry still takes precedence at decide time (existing T13 tests unaffected).
- `@osas/api`: approving a proposal stamps `actionDigest`; an execution whose
  approval digest matches passes; a mismatched one 409s with
  `ACTION_BINDING_MISMATCH` and emits exactly one `action_binding_mismatch_blocked`
  audit event.
- Compat suite: unchanged and still passing (no new black-box checks).

## Open questions

- Should the canonical input include top-level `amount` explicitly (it is currently
  evaluated from the top level while the digest covers `params`)? If a future schema
  version moves money into `params`, the digest definition stays unchanged.
- Should `actionDigest` become REQUIRED for new approvals at v1.0? (Recommended yes;
  optional in v0.x for compatibility.)
