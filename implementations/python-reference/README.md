# OSAS Python Reference Implementation

> **Seeking independent maintainer:** This implementation is mature and passes all conformance tests, but currently lives in the OSAS spec repository. We're looking for an individual or organization to adopt it as an independent project, which would count toward the v1.0 multi-party governance gate (≥3 independent implementations required).
>
> **What you'd get:** Recognition as a conforming implementation maintainer, a governance seat when OSAS reaches v1.0, and a working codebase (~1566 lines) with full test coverage.
>
> **Interested?** Open an issue with the `implementation` label or email the maintainers listed in [GOVERNANCE.md](../../GOVERNANCE.md).

---

A Python implementation of the OSAS v0.2 proposal/execution surface plus the v0.3 Controlled Execution Sandbox profile. It passes the black-box compatibility runner's full v0.2 suite (read-only + stateful) and the v0.3 `controlled-execution` profile — see "Verifying" below.

**Current status:** Conforming reference implementation (same organization). **Independence path:** Transfer to separate repository under independent maintainership → becomes an `independent-conforming` implementation counting toward the v1.0 gate.

## What makes this a good adoption candidate

- **Complete and tested:** Passes all black-box conformance checks with `gateOk: true`
- **Small and focused:** ~1566 lines total, no external API dependencies
- **Clear boundaries:** Implements Core + eCommerce profiles with deterministic sandbox execution; no production backend integration needed
- **Well-documented:** Inline comments explain every algorithm (stable-json, audit-chain, policy evaluation)
- **Minimal dependencies:** Only `jsonschema` + `referencing` (both pure Python)
- **CI-verified:** Automated conformance tests run on every commit

## Scope

Implements:

- Discovery (`/.well-known/osas`, `/v1/capabilities`, `/v1/meta/tools`,
  `/v1/schemas[/…]`) served from the authoritative `schemas/` directory.
- Real JSON Schema (draft 2020-12) validation for `/v1/validate` and policy
  drafts, via `jsonschema` + the `referencing` registry (the only runtime
  dependency — see `requirements.txt`).
- The deterministic policy-evaluation algorithm (spec §5) as a faithful port
  of `@osas/policy-engine`, including param-transform passthrough.
- The policy version lifecycle (`draft → simulated → approved → active →
  retired`) with supersession, `POLICY_IMMUTABLE`, and RBAC
  (`policy_admin`-only mutations; cross-tenant access → `TENANT_MISMATCH`).
- Idempotent execution keyed by `(tenantId, idempotencyKey)`, `uncertain` →
  reconciliation (never retried), `/v1/proposals/:id/reconcile`.
- Per-tenant append-only audit hash chains (SHA-256 over canonical JSON — see
  docs/implementing-osas.md, "Reproducing the audit hash chain") with
  `/v1/audit/verify`.
- Conformance Mode (`reset` / `fixtures/load` / `snapshot`), seeded from the
  machine-readable [conformance/fixtures/demo-tenant.json](../../conformance/fixtures/README.md).
- `POST /v1/chat` — the demo driver (message → proposal → policy decision →
  sandbox execution or handoff), mirroring the reference API's mock-provider
  flow: deterministic keyword scenario detection, `$amount` and id parsing,
  evidence anchoring, and prompt-injection interception.

## Running

Requires Python ≥ 3.11.

```bash
cd implementations/python-reference
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
OSAS_EXECUTION_MODE=sandbox \
OSAS_CONFORMANCE_MODE=true OSAS_CONFORMANCE_KEY=test-key \
OSAS_PROVIDER_EVENT_KEY=test-pe-key \
.venv/bin/python server.py --port 3010
```

## Verifying

Unit tests:

```bash
cd implementations/python-reference && .venv/bin/python -m unittest
```

Black-box conformance (from the repository root, with the server running):

```bash
pnpm osas:compat -- --target http://127.0.0.1:3010 --conformance-key test-key
pnpm osas:compat -- --target http://127.0.0.1:3010 \
  --profile controlled-execution \
  --conformance-key test-key --provider-event-key test-pe-key
```

CI runs both suites in the `python-compat` job (`.github/workflows/ci.yml`).

## Status

**Registry:** Registered in [conformance/implementations.json](../../conformance/implementations.json) as `conforming` (same-organization, in-repository).

**Independence:** This implementation does **not** currently count as an independent implementation toward the v1.0 gate. Per [GOVERNANCE.md](../../GOVERNANCE.md) and [conformance/README.md](../../conformance/README.md), independence requires:

1. **Separate repository** (outside `open-support-agent-spec`)
2. **Separate maintainership** (different organization or individual from the spec maintainers)
3. **Continued conformance** (passing `gateOk: true` on each release)

**Path to independence:**

- [ ] Transfer to independent GitHub repository (e.g., `yourorg/osas-python`)
- [ ] Update `conformance/implementations.json` with new repository URL and maintainer info
- [ ] Add CI workflow that runs `@osas/compat-runner` against each release
- [ ] Registry status changes to `independent-conforming` → counts toward v1.0 gate
- [ ] Maintainer receives governance seat when OSAS reaches v1.0 (≥3 independent implementations)

**Why adopt this?**

- **Governance participation:** Independent implementation maintainers get a seat at the table for v1.0+ roadmap decisions
- **Proven foundation:** No need to build from scratch; this passes all tests today
- **Community credibility:** Listed as a reference implementation for Python developers evaluating OSAS
- **Low maintenance:** Stable spec (v0.2 frozen), test suite catches regressions automatically

## How to adopt (for potential independent maintainers)

1. **Fork or transfer:** Create `yourorg/osas-python` repository (or similar name)
2. **Copy these files:**
   ```bash
   cp -r implementations/python-reference/* yourorg/osas-python/
   cp -r schemas yourorg/osas-python/schemas  # authoritative schemas
   cp -r conformance/fixtures yourorg/osas-python/conformance/fixtures
   ```
3. **Add CI:** Set up GitHub Actions to run conformance tests (see `.github/workflows/ci.yml` `python-compat` job as template)
4. **Submit claim:** File a compatibility claim issue in the OSAS spec repository with:
   - Your new repository URL
   - Conformance report JSON (from `@osas/compat-runner --out report.json`)
   - Maintainer contact info
   - Statement of independence (different org/individual from spec maintainers)
5. **Get listed:** Spec maintainers verify and update `conformance/implementations.json` with `status: "independent-conforming"`

**Questions?** Open an issue with the `implementation` label or reach out to the maintainers listed in [GOVERNANCE.md](../../GOVERNANCE.md).
