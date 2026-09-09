# RFC 0003: Controlled Execution Profile

- **Status:** Draft
- **Authors:** OSAS founding maintainers
- **Created:** 2026-09-09
- **Target line:** OSAS v0.3 Draft

## Summary

This RFC defines a controlled execution profile for e-commerce after-sales
actions. It adds a deterministic `sandbox` mode, execution attempts and
receipts, provider-event ingestion, reconciliation tasks, and per-action
execution contracts.

It does not enable production writes. `live` remains fail-closed until a later
RFC defines provider authentication, tenant opt-in, rollback/compensation,
operational monitoring, and an independent Live Conformance Suite.

## Positioning

MCP remains the tool transport. OSAS continues to own customer-support
governance semantics: proposal permissions, policy decisions, approvals,
evidence, idempotency, reconciliation, and audit explanation.

This RFC is additive to the v0.2 line. Implementations claiming OSAS v0.2
compatibility do not need to implement this profile. Implementations claiming
the v0.3 controlled-execution profile must expose the v0.3 execution schemas and
pass the controlled-execution conformance checks.

## Execution modes

| Mode | Meaning | Default |
|---|---|---|
| `proposal_only` | Produce a typed proposal; no simulation or write | no |
| `shadow` | Evaluate policy and record what would happen | yes |
| `sandbox` | Execute against synthetic deterministic provider behavior | no |
| `live` | Execute against a real provider | rejected in this RFC |

The reference API accepts `OSAS_EXECUTION_MODE=sandbox` only for synthetic
fixtures. It rejects `live` at startup.

## Normative objects

The JSON Schemas live under `schemas/execution-v0.3/`:

- `ExecutionCapability`
- `ExecutionAttempt`
- `ExecutionReceipt`
- `ReconciliationTask`
- `ProviderEvent`

All objects are tenant-scoped, reject unknown fields, and use
`specVersion: "0.3"`.

## State and safety rules

1. A model principal is capped at `request-approval`.
2. Only a server-side system executor can invoke `execute`.
3. `(tenantId, idempotencyKey)` is the execution replay boundary.
4. A provider result of `uncertain` is never automatically retried.
5. An uncertain result creates exactly one open reconciliation task for the
   execution attempt.
6. Provider events are deduplicated by
   `(tenantId, provider, providerEventId)`.
7. A provider event can resolve an open reconciliation task only when its
   idempotency key matches and its payload status is `succeeded` or `failed`.
8. Every attempt, receipt, provider event, reconciliation transition, and
   compensation decision is represented in the audit stream.
9. `exchange_request` remains human-fulfillment-only; a model cannot execute it.
10. Missing adapter capability is `CAPABILITY_UNSUPPORTED`, never a fabricated
    success.

## API surface

Existing routes are extended:

- `POST /v1/proposals/:id/execute` returns `attempt`, `receipt`, and optional
  `reconciliation` records.
- `POST /v1/proposals/:id/reconcile` resolves a human/system decision.

New routes:

- `GET /v1/executions/:id`
- `GET /v1/reconciliation?status=open|resolved`
- `POST /v1/provider-events`

Provider events require the internal `x-osas-provider-key` and the server-side
`OSAS_PROVIDER_EVENT_KEY` configuration. The key is not passed to the model or
stored in audit details.

## Adapter contract

`CapabilityManifest.executionContracts` describes, per action type:

- supported execution modes;
- approval requirement;
- idempotency support;
- reconciliation support;
- compensation support.

The reference Mock/Sandbox adapter declares sandbox support. Shopify, Zendesk,
and Chatwoot remain read-only/reference integrations and do not advertise live
execution.

## Persistence

Memory stores are used in the default demo runtime. PostgreSQL deployments
persist attempts, receipts, reconciliation tasks, and provider events in
tenant-scoped tables with unique provider-event and idempotency indexes.

## Conformance and release gates

The v0.3 controlled-execution profile requires:

- all execution schemas to validate valid and invalid fixtures;
- deterministic sandbox success, failure, timeout, replay, and reconciliation;
- zero model-to-execute paths;
- provider-event deduplication;
- intact audit chain;
- no `live` startup in the reference implementation.

Production Live requires a future RFC and is not implied by passing this RFC.
