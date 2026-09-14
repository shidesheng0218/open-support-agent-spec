# RFC 0004: Multi-Party Governance Model

- **Status:** Draft
- **Authors:** OSAS founding maintainers
- **Created:** 2026-09-12
- **Target line:** governance; takes effect when the v1.0 gates are met

## Summary

This RFC defines the governance model that replaces single-organization
stewardship once the v1.0 gates in GOVERNANCE.md are met: a Governance
Committee in which the founding maintainers and every organization holding a
registered `independent-conforming` implementation each hold one seat, with
decision rules, a trademark/compatibility-claim policy, and maintainer
expansion and exit mechanics.

This RFC changes process only. It introduces no schemas, no API semantics, and
no code.

## Motivation

Today every normative decision — releases, merges, RFC acceptance, the
roadmap — is owned by the founding maintainer group under lazy consensus
(GOVERNANCE.md §Decision making). That is appropriate for a draft spec weeks
after publication, but it caps the project's credibility in exactly the
dimension the spec itself argues for: **verifiability by parties who do not
have to trust a single vendor.** A governance vacuum filled by closed,
vendor-specific guardrails was named as a risk in RFC 0002; a single-vendor
governance model is the same failure mode one level up.

GOVERNANCE.md already commits to broadening governance at v1.0 and requires
"the exact composition [to] be defined by an RFC before v1.0 is declared."
This is that RFC. Defining it now — before any second organization holds a
stake — is cheaper and more credible than negotiating it under pressure later.

## Design

### Committee composition

1. The **Governance Committee** replaces the founding maintainers as the
   decision body for releases, merges to normative artifacts, RFC acceptance,
   and the roadmap.
2. The founding maintainers collectively hold **one seat**, exercised by their
   own internal lazy consensus.
3. Each organization (or unaffiliated individual) maintaining a registered
   `independent-conforming` implementation in `conformance/implementations.json`
   holds **one seat** while its registration is current. Multiple
   implementations by the same organization still yield one seat.
4. A seat lapses automatically if the implementation's registration is removed
   (false claim, unreproducible evidence, or withdrawal).

### Decision rules

- Day-to-day, non-normative changes (bug fixes, editorial docs, tests,
  tooling): any two committee members' approval, green CI required.
- RFC acceptance/rejection: lazy consensus on the committee; failing that, a
  simple majority of seats, with at least three seats voting.
- Changes to GOVERNANCE.md or this model itself, and declaration of v1.0:
  a **two-thirds majority of seats**, with at least one seat beyond the
  founding maintainers voting in favor.
- All committee votes are recorded in a public minutes file or in the relevant
  PR.

### Compatibility claims and the OSAS name

1. "OSAS", the OSAS logo (once one exists), and the phrase "OSAS
   &lt;version&gt; &lt;profile&gt;-compatible" may be used to describe an
   implementation **only** while it is registered in
   `conformance/implementations.json` with status `conforming` or
   `independent-conforming` for the claimed profile.
2. Descriptive use ("implements the Open Support Agent Spec v0.2") is always
   permitted and does not require registration.
3. The committee may revoke a registration — and with it the claim — when the
   evidence criteria in conformance/README.md are no longer met. Revocation
   follows the RFC decision rule.

### Maintainer expansion and exit

- Any committee member may nominate a new maintainer (commit rights) for
  sustained contribution; acceptance by lazy consensus of the committee.
- Maintainers inactive for 12 months move to emeritus status (no vote, no
  commit rights) and may return by request.
- Committee members may resign; a resigning independent implementer's seat
  lapses with its registration unless another organization takes over
  maintainership of that implementation and re-registers.

### Transition

This model takes effect only when the three v1.0 gates in GOVERNANCE.md are
met. Until then the current single-organization model applies unchanged, and
this RFC is advisory.

## Compatibility

No impact on schemas, persisted objects, `specVersion`, the HTTP API, the MCP
tool surface, or the compat suite. GOVERNANCE.md is amended by the PR that
accepts this RFC (pointer to this model), and again when the model takes
effect.

## Security

The model reduces a single point of failure in the trust story: a compatibility
claim no longer rests solely on the word of one organization. The trademark
policy closes a social-engineering vector — claiming "OSAS-compatible" without
evidence. No technical attack surface changes.

## Test plan

Process-only RFC; no unit or compat tests. The registry criteria it depends on
are exercised by the compatibility-claim issue template and the verification
flow in conformance/README.md. Acceptance of this RFC must include the
GOVERNANCE.md amendment and a CHANGELOG entry in the same PR.

## Open questions

- Should there be a seat cap or a per-industry balancing rule once the number
  of independent implementers grows large?
- Should committee minutes live in-repo (e.g. `governance/minutes/`) or in the
  wiki?
- Is 12 months the right inactivity window?
