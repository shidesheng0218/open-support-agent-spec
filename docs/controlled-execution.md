# Controlled Execution Profile (v0.3 Draft)

OSAS v0.2 remains Shadow-first. The v0.3 Draft adds a deterministic sandbox
execution path so implementers can verify idempotency, receipts, provider events,
and reconciliation without real commerce credentials.

## Quick start

```bash
OSAS_EXECUTION_MODE=sandbox pnpm dev:api
```

The sandbox uses synthetic fixtures only. It does not call Shopify, Zendesk,
Chatwoot, a payment provider, or any external network.

## Execution response

`POST /v1/proposals/:id/execute` returns the existing proposal and execution
result plus:

- `attempt`: request hash, mode, status, and timestamps;
- `receipt`: provider status, external reference, and retry safety;
- `reconciliation`: present when the provider result is uncertain.

The sandbox supports deterministic success, failure, and timeout scenarios via
synthetic proposal parameters. `simulate: "timeout"` never mutates business
fixtures and always creates an open reconciliation task.

## Provider events

Configure an internal event key:

```bash
OSAS_PROVIDER_EVENT_KEY=local-sandbox-key
```

Then send a provider event with `x-osas-provider-key`. Events are schema
validated, hashed, deduplicated, audited, and matched by idempotency key. A
`payload.status` of `succeeded` or `failed` resolves the matching open
reconciliation task.

## Production boundary

`OSAS_EXECUTION_MODE=live` remains rejected. No reference Shopify, Zendesk, or
Chatwoot adapter advertises live execution. Production writes require a future
RFC, provider-specific authentication and callback verification, tenant opt-in,
compensation semantics, and a separate Live Conformance Suite.

Normative details are in [RFC 0003](../rfcs/0003-controlled-execution-profile.md)
and the schemas under `schemas/execution-v0.3/`.
