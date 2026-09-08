# OSAS Adapter Development Guide

[中文版](adapter-guide.zh-CN.md)

This guide explains how to build a `SupportAdapter` that connects OSAS to a
real support/commerce/billing stack. Three reference implementations ship with
v0.2.0: `@osas/zendesk-adapter` (ticketing), `@osas/shopify-adapter`
(read-only commerce) and `@osas/chatwoot-adapter` (open-source helpdesk) —
read their source alongside this guide.

## The contract

All model and API traffic flows through the `SupportAdapter` interface
(`packages/adapter/src/types.ts`). Adapters receive a `ToolContext` on every
call:

```ts
interface ToolContext {
  tenantId: string;
  principal: { actorType: "model" | "human" | "system"; actorId: string; permission: Permission };
}
```

- **Never trust the caller.** Enforce the permission ladder
  (`read < draft < request-approval < execute`) with `requirePermission`
  from `@osas/adapter`. Models can never hold `execute`.
- **Tenant scope everything.** Every read/write is scoped to
  `ctx.tenantId`; cross-tenant access must be impossible.
- **Models never hold backend credentials.** API keys live in the adapter's
  config (env), are sent as HTTP headers, and never appear in logs, errors,
  audit events, or evidence payloads.

## Error mapping

| Adapter error | API result |
|---|---|
| `AdapterNotFoundError` | 404 `NOT_FOUND` |
| `AdapterPermissionError` | 403 `FORBIDDEN` |
| `AdapterCapabilityError` | 403 `CAPABILITY_UNSUPPORTED` |
| anything else | 500 `INTERNAL_ERROR` |

Map upstream 404s to `AdapterNotFoundError`. Wrap other upstream failures in
an adapter-specific error (e.g. `ZendeskApiError`, `ShopifyApiError`) that
carries the HTTP status but **never** the request headers or body (they may
contain tokens or PII).

## Fail closed

An adapter without complete configuration must throw at construction/startup
(`ZendeskNotConfiguredError`, `ShopifyNotConfiguredError` in the reference
adapters). It must never fake a success response. The same applies per
operation: `ZendeskAdapter.createEscalation` throws when no default
escalation group (`ZENDESK_ESCALATION_GROUP_ID`) is configured.

## Capability manifest

Implement `getCapabilities(ctx)` to publish a `CapabilityManifest`. Once
declared it binds: the API rejects operations needing an undeclared
capability with `CAPABILITY_UNSUPPORTED`. Declare only what you truly
support — the Shopify adapter deliberately does **not** declare
`ecommerce.refund.execute`.

For operations you do not support, throw `AdapterCapabilityError` (see the
`unsupported(...)` helper pattern in both reference adapters).

## HTTP access: injectable client

All third-party traffic goes through an injectable HTTP client:

```ts
interface HttpRequest { method: string; url: string; headers?: Record<string, string>; body?: unknown }
interface HttpResponse { status: number; body: unknown }
type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;
```

The default implementation wraps global `fetch`; tests inject a mock client
that records requests and replays canned responses. Adapter unit tests must
pass with **no external credentials and no network** — assert request
construction (method/URL/headers/body), error mapping, and mapping to OSAS
objects.

## Idempotent writes

Every write input carries an `idempotencyKey`. The reference adapters:

1. cache the first result per key in-process and replay it on retries
   (no second HTTP write), and
2. forward the key to the upstream as an `X-Idempotency-Key` header.

If the upstream has native idempotency support, prefer it.

## Evidence

When you read external records for a decision, convert them to OSAS
`Evidence`: `source.system` (e.g. `"zendesk"`, `"shopify"`),
`source.recordType` / `source.recordId` (the external primary key) and
`source.url` (a human-openable console link). Evidence is what the policy
engine prices decisions from; freshness (`retrievedAt` / `expiresAt`) is
enforced by §4 rule 10.

## Execution discipline

`executeAction` is execute-permission only and is never exposed as an MCP
tool. In v0.2.0 Shadow Mode, reference integrations must not implement real
financial writes at all: the Shopify adapter's `executeAction` always throws
`CAPABILITY_UNSUPPORTED` without making any HTTP call. Adding real execution
capability requires a separate RFC.

## Testing checklist

- Mock-HTTP tests pass with zero credentials configured.
- Unconfigured adapter throws (fail closed) — and makes no HTTP call.
- Writes are idempotent under key replay (assert exactly one HTTP write).
- Errors never leak tokens (assert on error strings).
- `getCapabilities()` matches the actual method surface.
