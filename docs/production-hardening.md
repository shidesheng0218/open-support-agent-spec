# Production Hardening Guide

[中文版](production-hardening.zh-CN.md)

> **What this document is.** The reference implementation is demo-grade
> ([SECURITY.md](../SECURITY.md)): it exists to make the specification runnable and
> testable. This guide is the **path** from that demo to a deployment you could put
> in front of real traffic — it is not a claim that any stage below turns the
> reference code into an audited production system.
>
> **What this document is not.** Live execution (`OSAS_EXECUTION_MODE=live`) is
> disabled by the specification itself and refuses to start. Nothing here enables
> it; that requires a future RFC (see the roadmap in README).

## The three stages

| Knob | Stage 1 · Demo | Stage 2 · Staging | Stage 3 · Production |
|---|---|---|---|
| `OSAS_AUTH_MODE` | `demo` | `jwt` | `jwt` |
| `OSAS_STORAGE` | `memory` | `postgres` | `postgres` |
| `OSAS_LLM_PROVIDER` | `mock` | `openai-compatible` | `openai-compatible` |
| `OSAS_LLM_*_BUDGET_USD` | unset | set | set + alerting |
| `OSAS_EXECUTION_MODE` | `shadow` | `shadow` or `sandbox` | `shadow` or `sandbox` |
| `OSAS_CONFORMANCE_MODE` | off | off | **off, always** |
| `NODE_ENV` | any | any | `production` |
| Data | synthetic fixtures | synthetic / anonymized | real, minimized |

Stage 1 is `docker compose up --build`. Stage 2 proves your identity provider,
database, and model provider wiring against synthetic data. Stage 3 adds the
operational controls below. Do not skip Stage 2: every fail-closed guard in the
reference API is exercised there before real customer data is involved.

## The never list (production)

Every item below fails closed at startup — the API refuses to boot rather than run
in a weak configuration. Do not fork these guards away; a fork that boots anyway is
a security regression (see the threat model, docs/threat-model.md).

1. **Never** run `OSAS_AUTH_MODE=demo` under `NODE_ENV=production`. Demo headers are
   self-asserted identity; anyone who can reach the port is anyone they claim to be.
2. **Never** enable `OSAS_CONFORMANCE_MODE` outside a throwaway CI environment. The
   reset/fixture endpoints wipe state by design.
3. **Never** attempt `OSAS_EXECUTION_MODE=live`. Startup aborts with
   `LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1` (a historical stable error-code name).
4. **Never** let a token or header claim the `system_executor` role — it is rejected
   by design; if you see it accepted, that is a vulnerability: report it privately
   per SECURITY.md.
5. **Never** feed real customer data into fixtures, issues, or eval cases.
6. **Never** log `OSAS_LLM_API_KEY`, adapter tokens, or `Authorization` headers. The
   reference logger redacts `req.headers.authorization`, `*.email`, `*.phone`, and
   free-text bodies (`apps/api/src/plugins.ts`); keep those redact paths intact if
   you modify logging.

A copy-and-edit starting point for Stage 3 lives at
[docker-compose.prod.yml.example](../docker-compose.prod.yml.example) — every
placeholder is marked `CHANGE_ME`, and CI statically validates the file
(`docker compose -f ... config`) so it cannot rot.

## Stage 3 controls

### Identity and access

- Terminate OIDC at your IdP; configure `OSAS_JWKS_URL`, `OSAS_JWT_ISSUER`,
  `OSAS_JWT_AUDIENCE`. Missing any one fails startup closed.
- Map IdP roles to the four OSAS roles (`support_agent`, `policy_admin`, `auditor`,
  `system_executor` is server-internal and must never appear in a token).
- Keep the tenant claim authoritative: cross-tenant access is rejected with 403
  `TENANT_MISMATCH` at the route layer; do not weaken `assertTenantAccess`.

### Storage and durability

- `OSAS_STORAGE=postgres` with a managed PostgreSQL. Apply migrations
  (`pnpm db:migrate`) during deploy, before the new API version serves traffic.
- The execution ledger primary key `(tenant_id, idempotency_key)` enforces
  idempotency at the database level — keep it; do not replace it with an
  application-level check.
- Execution-state updates and their audit-stream writes commit in one transaction.
  Preserve that property in any custom store.
- Back up the database; rehearse a restore. The audit chain is only as durable as
  its storage.

### Audit trail: tamper-evidence is not tamper-proof

The SHA-256 hash chain (`sequence` / `previousHash` / `eventHash`, verified by
`GET /v1/audit/verify`) detects modification, deletion, and reordering of the
**stored** stream. An attacker who can rewrite the whole store can recompute the
chain. Pair it with WORM storage:

- Stream audit events off-box as they are written (append-only log service, or an
  object store with Object Lock / immutability enabled), or
- Schedule an external job that calls `GET /v1/audit/verify` per tenant and alerts
  on `intact: false`, plus periodic off-site snapshots whose hashes you pin.

### Model provider and budget

- Set both price knobs (`OSAS_LLM_INPUT_USD_PER_MTOKEN`,
  `OSAS_LLM_OUTPUT_USD_PER_MTOKEN`) or neither — without them costs are recorded as
  *unknown*, never fabricated, and budget enforcement has nothing to measure.
- Set `OSAS_LLM_DAILY_BUDGET_USD` and `OSAS_LLM_CASE_BUDGET_USD`. Calls are blocked
  **before** the provider is touched at the cap; 80% writes a `budget_warning`
  audit event. Alert on that event.
- Track `GET /v1/usage` (roles `policy_admin` / `auditor`) into your metrics system.

### Edge and runtime

- Put a TLS-terminating reverse proxy in front of the API; the reference server
  speaks plain HTTP.
- Add rate limiting at the proxy. The reference API has none.
- Run more than one replica only against PostgreSQL storage — in-memory stores are
  per-process and would diverge.
- Watch the startup log: the API prints a **security posture summary** (one line per
  knob: auth / storage / execution / conformance / LLM provider). Alert if a
  production process reports anything but the Stage-3 column of the matrix above.
- Health-check `/health`; it is unauthenticated and returns only
  `{ status, specVersion, version }`.

### Secrets

- All credentials are read from the environment only: `OSAS_LLM_API_KEY`,
  `ZENDESK_API_TOKEN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `CHATWOOT_API_TOKEN`,
  `OSAS_PROVIDER_EVENT_KEY`, `DATABASE_URL`. Use your platform secret store;
  rotate on a schedule; never bake them into images or compose files.

## Pre-launch checklist

- [ ] `OSAS_AUTH_MODE=jwt`; a token from tenant A cannot read tenant B (probe for 403).
- [ ] `OSAS_STORAGE=postgres`; migrations applied; restore rehearsal done.
- [ ] Budgets set; a forced `budget_warning` fires and reaches your alerting.
- [ ] `GET /v1/audit/verify` returns `intact: true`; the external verifier is scheduled.
- [ ] Conformance endpoints return 404 (mode off); `/v1/usage` rejects
-      non-admin/auditor roles with 403.
- [ ] Startup posture log shows only Stage-3 values; weak combinations raise WARN
-      lines that someone reads.
- [ ] Tenant policies reviewed: `defaultDecision` is `block`; thresholds, regions,
      identity requirements match your risk appetite.
- [ ] Approval timeouts configured (`approval.timeoutSeconds`) so pending approvals
      fail safe (deny-only) instead of lingering.
- [ ] Log pipeline verified to keep the redaction paths intact.
- [ ] Rollback plan: how you disable the agent writes (revoke adapter credentials)
      without taking the helpdesk down.

## What remains your responsibility

Penetration testing, a real WORM sink, SIEM integration, data-residency controls,
and any compliance regime you operate under are deployment concerns. The spec gives
you tamper-evidence, tenant isolation, deterministic policy, and a complete audit
trail — turning those into your compliance story is yours.