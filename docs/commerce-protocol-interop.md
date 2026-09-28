# Commerce Protocol Post-Purchase Interop (v0.3 Draft)

[中文版](commerce-protocol-interop.zh-CN.md)

OSAS governs after-sales actions after a commerce interaction. It does not
implement checkout, payment, or an external commerce protocol. This guide
defines the reference implementation's narrow mapping boundary for
post-purchase events arriving from a UCP- or ACP-connected integration.

This is an **OSAS mapping profile**, not a claim of conformance to UCP, ACP,
or any provider's webhook format. An adapter owns the upstream protocol
client, authentication, signature verification, and field extraction.

## Relationship to AP2 (Agent Payments Protocol)

[AP2](https://github.com/google-agentic-commerce/AP2) (donated to the FIDO
Alliance at v0.2) standardizes **signed, typed, non-repudiable intent** for
payments: Verifiable Digital Credentials and Checkout/Payment Mandates with
open (constraints) and closed (authorized) stages, chained so the mandate
sequence forms a verifiable audit trail. The structural kinship with OSAS is
real — an OSAS `ActionProposal` is a typed intent record, and the per-tenant
hash chain plays the role AP2's mandate chain plays for payments.

The deliberate division of labor:

- **AP2 owns payment intent** — proving *the buyer authorized this charge*;
  it evaluates no policy and decides nothing about execution.
- **OSAS owns the support write boundary** — whether a refund/credit/reshipment
  may auto-execute, requires approval, or is blocked, plus idempotent execution
  and reconciliation against the system of record.

An implementation that receives AP2 mandates SHOULD carry the mandate reference
through as evidence (`Evidence.kind: "order"` / `policy` with the mandate id in
`source`) rather than treating mandate validation as policy evaluation. OSAS
does not re-implement mandate verification, and passing the OSAS conformance
suites implies nothing about AP2. A future RFC MAY define a tighter mapping if
≥2 implementations converge on one.

## Trust boundary

An adapter MUST complete all of the following before it calls the internal
`POST /v1/provider-events` endpoint:

1. verify the upstream protocol's signature, OAuth claim, or mutually
   authenticated transport;
2. bind the external order and event to one OSAS `tenantId`;
3. extract a stable provider event ID and idempotency key;
4. redact data that is not needed for after-sales evidence or reconciliation.

`x-osas-provider-key` / `OSAS_PROVIDER_EVENT_KEY` is an internal
adapter-to-OSAS credential. It is **not** a substitute for an upstream
signature check and must never be given to a model, browser client, or external
commerce provider.

## Supported event vocabulary

When `provider` is `"ucp"` or `"acp"`, the reference API accepts only the
following OSAS post-purchase event names:

| Domain | Event type |
|---|---|
| Order | `order.created`, `order.cancelled` |
| Fulfillment | `fulfillment.shipped`, `fulfillment.delayed`, `fulfillment.delivered` |
| Refund | `refund.requested`, `refund.succeeded`, `refund.failed` |
| Return | `return.requested`, `return.received` |

Unknown event types fail closed with `422 SCHEMA_INVALID`; they are not stored,
audited, or used to resolve a reconciliation task.

## Normalization

After the source adapter has authenticated and normalized the external event,
it calls the internal API with the standard ProviderEvent input shape:

```json
{
  "provider": "ucp",
  "providerEventId": "evt_refund_123",
  "eventType": "refund.succeeded",
  "idempotencyKey": "refund_123",
  "occurredAt": "2026-09-20T00:00:00.000Z",
  "payload": {
    "orderId": "ord_123",
    "refundId": "refund_123",
    "status": "succeeded"
  }
}
```

The reference implementation persists the normalized `ProviderEvent.payload`:

```json
{
  "source": {
    "protocol": "ucp",
    "eventType": "refund.succeeded"
  },
  "data": {
    "orderId": "ord_123",
    "refundId": "refund_123",
    "status": "succeeded"
  }
}
```

The payload hash is computed over this normalized form. Provider-event
deduplication remains `(tenantId, provider, providerEventId)`; execution
replay remains `(tenantId, idempotencyKey)`.

## Reconciliation and execution boundary

`refund.succeeded` and `refund.failed` may resolve an existing open
reconciliation task only when the event idempotency key matches its proposal.
An event never creates a refund, changes a proposal into an execution request,
or gives a model execution authority. Unknown provider outcomes remain
`reconciliation_required` and are never automatically retried.

This mapping is compatible with Shadow and Sandbox. `live` remains disabled.

## Adapter test checklist

- Verify the upstream signature before using the internal provider-event key.
- Reject an event whose order does not belong to the resolved tenant.
- Reject blank event IDs and unsupported event types.
- Assert duplicate delivery returns the first stored event without a second
  reconciliation or audit transition.
- Assert tests use synthetic or fully redacted event payloads only.
