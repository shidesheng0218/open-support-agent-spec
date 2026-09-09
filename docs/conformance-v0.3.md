# OSAS v0.3 Controlled Execution Conformance

The v0.2 compatibility suite remains the compatibility contract for Core,
Ecommerce, and SaaS. Controlled Execution is a separate v0.3 Draft profile so
existing v0.2 implementations do not break when they do not support Sandbox.

## Profile declaration

An implementation may declare:

```text
OSAS 0.3 ecommerce-controlled-execution-compatible
```

only when it exposes:

- `specVersion: "0.3"` execution schemas;
- `sandbox` in its execution modes;
- per-action `executionContracts`;
- deterministic idempotency and provider-event deduplication;
- execution receipts and reconciliation tasks;
- an intact audit chain;
- no model path that can invoke `execute`.

## Required scenarios

The profile must prove:

1. sandbox success produces an attempt and receipt;
2. repeated idempotency keys replay without a second provider call;
3. provider failure is terminal and not retried unless explicitly safe;
4. provider timeout produces `uncertain` and an open reconciliation task;
5. a matching provider event resolves the task exactly once;
6. a duplicate provider event is accepted as a replay and has no side effect;
7. cross-tenant events cannot resolve another tenant's task;
8. unsupported Adapter capabilities fail closed;
9. exchange requests remain human-fulfillment-only;
10. `live` startup is rejected by the reference implementation.

## Public evidence

Implementations should publish:

- a machine-readable conformance report;
- implementation and adapter versions;
- supported Profiles and execution modes;
- the exact test commit or release;
- known unsupported actions;
- whether persistence is memory or PostgreSQL/another durable store.

The current repository provides the schemas, Sandbox Adapter, API tests, and
PostgreSQL stores needed to build an independent implementation. A Python
implementation under `implementations/python-reference/` is an adoption
starting point; it is not counted as an independent governance seat until
published and tested as a separate repository.

## Running the black-box profile

Start the reference API with the test-only conformance mode, Sandbox mode, and
a provider-event key, then run the separate Draft report:

```bash
OSAS_EXECUTION_MODE=sandbox \
OSAS_CONFORMANCE_MODE=true \
OSAS_CONFORMANCE_KEY=local-conformance-key \
OSAS_PROVIDER_EVENT_KEY=local-provider-key \
pnpm dev:api

pnpm osas:compat -- \
  --target http://localhost:3001 \
  --profile controlled-execution \
  --conformance-key local-conformance-key \
  --provider-event-key local-provider-key \
  --out controlled-execution-report.json
```

The report is deliberately separate from `tests/compat/report/latest.json` and
has `specVersion: "0.3"` plus
`profile: "ecommerce-controlled-execution"`.
