# REST Integration Guide

[中文版](rest-integration.zh-CN.md)

OSAS is transport-neutral. The 20 MCP tools are one surface; this guide is the
other: plain HTTP against the reference API. Nothing here requires an MCP client.

## Discovery

```bash
curl -s http://localhost:3001/.well-known/osas   # specVersion, capabilities, endpoints
curl -s http://localhost:3001/v1/openapi.json    # OpenAPI 3.1 document
```

`/v1/openapi.json` describes the stable v1 surface. Its `components.schemas` are
loaded from the authoritative `schemas/` manifest at request time — the same
source the runtime validator uses — so the document cannot drift from what the
server enforces. Feed it to any OpenAPI 3.1 toolchain (client generators,
contract testers, documentation viewers).

## Authentication and tenancy

Every request carries a principal and a tenant:

| Mode | Headers |
|---|---|
| `OSAS_AUTH_MODE=demo` (local default) | `x-osas-role`, `x-osas-actor-id`, `x-tenant-id` |
| `OSAS_AUTH_MODE=jwt` | `Authorization: Bearer <OIDC token>` with `sub` / `tenant_id` / `roles` claims |

A path tenant must match the principal's tenant or the API returns 403
`TENANT_MISMATCH`. External principals never receive the `execute` permission.

## The proposal pipeline over REST

The write path mirrors the spec: **propose → evaluate → (approve) → execute**,
with an audit event at every step.

```bash
# 1. Create a proposal (idempotent: replaying the same idempotencyKey returns
#    the stored proposal with replayed: true and no side effects).
curl -s -X POST http://localhost:3001/v1/proposals \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent' \
  -d '{
    "tenantId": "tenant_demo",
    "caseId": "case_refund",
    "profile": "ecommerce",
    "actionType": "refund",
    "reasonCode": "damaged",
    "params": { "orderId": "ord_small" },
    "requestedPermission": "request-approval",
    "requestedBy": { "actorType": "human", "actorId": "agent_1" },
    "amount": { "currency": "USD", "minorUnits": 2500 },
    "evidenceIds": ["ev_order_small"],
    "idempotencyKey": "my-unique-key-001"
  }'

# 2. Evaluate it against the tenant policy (deterministic; emits policy_evaluated).
curl -s -X POST http://localhost:3001/v1/proposals/prp_1/evaluate \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent'

# 3a. auto_execute decisions are immediately eligible for execution.
curl -s -X POST http://localhost:3001/v1/proposals/prp_1/execute \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent'

# 3b. require_approval decisions park in the queue until a human decides.
curl -s "http://localhost:3001/v1/approvals?status=pending" \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent'
curl -s -X POST http://localhost:3001/v1/approvals/apr_1/decide \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent' \
  -d '{ "decision": "approved", "approverId": "agent_1" }'

# 4. Inspect the hash-chained audit trail.
curl -s "http://localhost:3001/v1/audit?proposalId=prp_1" \
  -H 'x-tenant-id: tenant_demo'
curl -s "http://localhost:3001/v1/audit/verify" -H 'x-tenant-id: tenant_demo'
```

Execution semantics to rely on:

- **Idempotency.** Executions key on `(tenantId, idempotencyKey)`; a replay
  returns the stored result with `replayed: true` and no second side effect.
- **No blind retries.** A `failed` / `rejected` proposal is terminal; a new
  attempt is a new proposal with a new key. An `uncertain` execution parks in
  `reconciliation_required` until a human calls `/v1/proposals/:id/reconcile`.
- **Approval expiry.** Pending approvals fail safe: deciding after the deadline
  is 409 `APPROVAL_TIMED_OUT`, the proposal closes as `rejected`, audited once.
- **Action binding.** An approval is bound to the exact `{ actionType, params }`
  it authorized (`actionDigest`); the execution boundary re-verifies it (409
  `ACTION_BINDING_MISMATCH` on divergence).

## Error model

All errors share one shape:

```json
{ "error": { "code": "SCHEMA_INVALID", "message": "...", "details": [] } }
```

Common codes: 404 `*_NOT_FOUND`, 403 `TENANT_MISMATCH` / `POLICY_ADMIN_REQUIRED` /
`CAPABILITY_UNSUPPORTED`, 409 `POLICY_IMMUTABLE` / `APPROVAL_TIMED_OUT` /
`ACTION_BINDING_MISMATCH`, 422 `SCHEMA_INVALID`. Schema-invalid writes are
rejected before any state change and never execute.

## Verifying any implementation

Integrating against a non-reference OSAS implementation? Score it with the
black-box runner instead of trusting claims:

```bash
pnpm osas:compat -- --target https://their-deployment.example --conformance-key <k>
```

`gateOk: true` in the report is the registry-grade bar (see GOVERNANCE.md and
conformance/README.md).