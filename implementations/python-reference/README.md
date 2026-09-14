# OSAS Python Reference Implementation (candidate)

A Python implementation of the OSAS v0.2 HTTP surface plus the v0.3 Controlled
Execution Sandbox profile. It passes the black-box compatibility runner's full
v0.2 suite (read-only + stateful) and the v0.3 `controlled-execution` profile —
see "Verifying" below.

It is intentionally small and safe:

- no external network calls;
- no real provider credentials;
- deterministic Sandbox execution for refund success, failure, timeout,
  idempotency, receipts, reconciliation, and Provider Event deduplication;
- `live` execution refuses startup;
- Conformance Mode is test-only and fail-closed.

## What it implements

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

Registered in [conformance/implementations.json](../../conformance/implementations.json)
as `conforming` (same-organization, in-repository). It does **not** count as an
independent implementation toward the v1.0 gate: per
[conformance/README.md](../../conformance/README.md), independence requires a
separate repository and separate maintainership.
