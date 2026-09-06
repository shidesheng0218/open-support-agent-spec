# Conformance Mode (Milestone 4) — TEST ONLY

> **Never enable Conformance Mode in production.** It exposes reset, fixture
> load, and state-snapshot endpoints that wipe and re-seed all data. The
> reference API fails closed: `OSAS_CONFORMANCE_MODE=true` combined with
> `NODE_ENV=production` aborts startup, and so does enabling it without
> `OSAS_CONFORMANCE_KEY`.

Conformance Mode exists so the black-box compat runner
(`packages/compat-runner`, `pnpm osas:compat -- --target <url>`) can verify
stateful contract behavior — policy lifecycle transitions, idempotent
execution, permission and tenant isolation, audit-chain integrity — against a
deterministic base state.

## Enabling (test environments only)

```bash
OSAS_CONFORMANCE_MODE=true
OSAS_CONFORMANCE_KEY=<test-only-secret>   # never reuse a real credential
```

The runner enables its stateful suite when the same variables are set in its
own environment, or when `--conformance-key <key>` is passed. Without a key
the runner executes only the read-only suites.

## Endpoints

All endpoints require the `X-OSAS-Conformance-Key: <key>` header (compared in
constant time; wrong/missing key → 403). They are **not registered at all**
when Conformance Mode is off (404).

| Endpoint | Behavior |
|---|---|
| `POST /v1/conformance/reset` | Wipes all mutable state and re-seeds the CONTRACTS.md §11 demo fixtures; returns a snapshot. |
| `POST /v1/conformance/fixtures/load` | Body `{ "name": "demo" \| "empty" }`; `empty` keeps only the demo policy (no cases/customers/orders). |
| `GET /v1/conformance/snapshot` | Per-tenant counts (cases, proposals, handoffs, audit events, policy versions, ShadowRuns, usage records) plus the audit-chain verification result. |

With `OSAS_STORAGE=postgres`, reset additionally clears the store tables
(`policy_versions`, `audit_events`, `execution_records`, `shadow_runs`,
`model_usage`); the adapter dataset itself is always the in-memory mock.

## Fail-closed guarantees

- `NODE_ENV=production` + `OSAS_CONFORMANCE_MODE=true` → startup refuses
  (`ConfigError`), independent of auth mode.
- `OSAS_CONFORMANCE_MODE=true` without `OSAS_CONFORMANCE_KEY` → startup refuses.
- Mode off → endpoints do not exist (404).
- Wrong key → 403, compared via `timingSafeEqual` on hashed values.
- CI enables the mode only for the disposable Docker test environment
  (`.github/workflows/ci.yml`, `docker` job).
