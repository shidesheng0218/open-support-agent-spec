# Chatwoot Adapter Guide

[中文版](chatwoot-adapter.zh-CN.md)

`@osas/chatwoot-adapter` is the reference `SupportAdapter` for
[Chatwoot](https://www.chatwoot.com/) — the open-source support inbox — over
its REST API. It mirrors the Zendesk reference adapter's structure and
discipline and covers the **core profile** only: conversation/contact reads,
private notes, human escalations, and evidence capture. There is no live
execution path — Shadow Mode only.

> **Packaging:** `@osas/chatwoot-adapter` is a private reference implementation
> (`"private": true`) — it is **not published to npm**, so
> `npm install @osas/chatwoot-adapter` does not work. Build it from a checkout
> of this repo (`pnpm --filter @osas/chatwoot-adapter build`) or copy it as the
> starting point for your own adapter. Only `@osas/core`,
> `@osas/schema-validator`, and `@osas/policy-engine` are public npm packages.

## What it maps

| Chatwoot | OSAS | Notes |
|---|---|---|
| Conversation | `Case` (`cw_conv_{id}`) | `additional_attributes.mail_subject` (email channel) or the first public incoming message becomes `subject`; fallback `Chatwoot conversation {id}` |
| Contact | `Customer` (`cw_contact_{id}`) | identity stays `unverified`; `region` comes from `additional_attributes.country_code` when it looks like ISO 3166-1 alpha-2, else `"ZZ"` |
| Message (`private: true`) | `CaseNote` | internal note only — never a public reply |
| Team assignment + private note | `Escalation` | assigns the conversation to `CHATWOOT_ESCALATION_TEAM_ID` and leaves an `[OSAS escalation]` private note |
| Conversation/contact fetch | `Evidence` | `source.system: "chatwoot"`, `recordType` `conversation`/`contact`, `recordId` = Chatwoot id, `url` = agent-console link |

### Status / priority / channel mapping

- **Status:** `open → open`, `pending → pending_agent`, `snoozed →
  pending_agent`, `resolved → resolved`. Chatwoot has no `pending_customer`
  or `closed` state; a resolved conversation sets `closedAt` (from
  `updated_at`, falling back to `last_activity_at`).
- **Priority:** `low → low`, `medium → normal`, `high → high`, `urgent →
  urgent`, `null → normal`.
- **Channel:** `Channel::Email → email`; `WebWidget` / `Whatsapp` /
  `TwilioSms` / `Sms` / `Telegram` / `Line → chat`; `FacebookPage` /
  `TwitterProfile` / `Instagram → social`; `Channel::Api → api`; anything
  unknown falls back to `api`.
- **Timestamps:** conversations report unix epoch seconds, contacts report
  ISO strings — the mapper accepts both and normalizes to ISO 8601.
- **Assignee:** an assigned agent means `assigneeType: "human"`, otherwise
  `"none"`.

## Configuration

All via env. The adapter **fails closed** when credentials are missing —
`chatwootConfigFromEnv` throws `ChatwootNotConfiguredError` and never fakes
a success.

```bash
CHATWOOT_BASE_URL=https://app.chatwoot.com   # or your self-hosted origin (no trailing slash needed)
CHATWOOT_ACCOUNT_ID=7                        # numeric account id in the API path
CHATWOOT_API_TOKEN=...                       # user access token; never logged, never audited
CHATWOOT_ESCALATION_TEAM_ID=12               # default team for human escalations
```

Every request goes to
`{CHATWOOT_BASE_URL}/api/v1/accounts/{CHATWOOT_ACCOUNT_ID}/...` with the
token in the `api_access_token` header. The token never appears in error
messages, logs, audit events, or evidence payloads.

## Endpoints used

| Operation | Chatwoot call |
|---|---|
| `getCase` | `GET /conversations/{id}` |
| `searchCases` (by customer) | `GET /contacts/{id}/conversations` |
| `searchCases` (free text) | `GET /conversations/search?q=...` |
| `searchCases` (list) | `GET /conversations` |
| `getCustomer` | `GET /contacts/{id}` |
| `createCaseNote` | `POST /conversations/{id}/messages` with `{ content, message_type: "outgoing", private: true }` |
| `createEscalation` | `POST /conversations/{id}/assignments` with `{ team_id }`, then a private note |

Status filtering in `searchCases` is applied client-side after mapping, the
same way the Zendesk adapter does it.

## Idempotency and fail-closed writes

Both write paths (`createCaseNote`, `createEscalation`) take an
`idempotencyKey`:

1. The first result per key is cached in-process and replayed on retries —
   no second HTTP write.
2. The key is also forwarded as an `X-Idempotency-Key` header for upstreams
   or proxies that honor it.

`createEscalation` throws `ChatwootNotConfiguredError` without any HTTP call
when `CHATWOOT_ESCALATION_TEAM_ID` is not configured. Upstream `404` maps to
`AdapterNotFoundError` (`NOT_FOUND`); any other non-2xx maps to
`ChatwootApiError` carrying only the HTTP status — never headers or bodies.

### Idempotency boundary (reference adapter)

This is a **reference adapter**. Its idempotency cache is an **in-process
`Map`**: it deduplicates retries only within the lifetime of one process and
is **lost on restart**. It is not a complete production idempotency
solution. Production-grade, cross-restart idempotency must come from the
upstream system (Chatwoot's idempotency-key support where available — the
adapter always forwards `X-Idempotency-Key`) or from an external persistent
store / transactional outbox in front of the adapter.

### Escalation partial failure and reconciliation

An escalation is two external writes: team assignment
(`POST /conversations/{id}/assignments`) followed by a private note. The two
legs use **distinct idempotency keys** — `{key}:assignment` and
`{key}:note` — so a retry never re-sends a leg that already landed.

- If the **assignment leg fails**, nothing is written, nothing is cached,
  and the error propagates as before.
- If the assignment succeeds but the **note leg fails**, the escalation is
  returned and cached with `status: "partial_success"`, carrying everything
  needed for human reconciliation: `assignment: { teamId, response }` (the
  completed leg and the upstream response) and `noteError` (the failed
  leg's error). A retry with the same `idempotencyKey` **resumes from the
  note leg only** — no second assignment call — and on success the cached
  record transitions to `status: "success"` with `noteError` cleared. A
  duplicate retry after full success performs zero HTTP calls.

### No fabricated customers

A `Case` always needs a real customer. When a conversation has no sender, an
empty sender, or a sender id that is not a positive integer, the mapping
fails closed: `getCase` / `searchCases` throw
`ChatwootCustomerIdUnavailableError` (`CUSTOMER_ID_UNAVAILABLE`) instead of
ever producing a placeholder like `cw_contact_0`.

## Capability manifest

`getCapabilities()` declares exactly what is implemented, profile `core`:

```json
{
  "implementationId": "osas-chatwoot-adapter",
  "profiles": [{ "name": "core", "capabilities": [
    "case.read", "customer.read", "evidence.read", "note.write", "escalation.write"
  ] }],
  "transports": ["http"],
  "executionModes": ["shadow"]
}
```

Everything else — `searchKnowledge` (Chatwoot knowledge base is not covered
here), proposals, approvals, audit, ecommerce/SaaS reads, `executeAction` —
throws `AdapterCapabilityError` (`CAPABILITY_UNSUPPORTED`) **without making
any HTTP request**. Once declared, the manifest binds: the API rejects
operations needing an undeclared capability with `403
CAPABILITY_UNSUPPORTED`.

## Testing

`src/chatwoot-adapter.test.ts` uses an injectable mock `HttpClient` that
records requests and replays canned responses — no credentials, no network.
It asserts request construction (method/URL/headers/body), idempotent replay
(exactly one HTTP write per key), error mapping with no token leakage, and
the conversation/contact → Case/Customer mapping.

```bash
pnpm --filter @osas/chatwoot-adapter build
pnpm --filter @osas/chatwoot-adapter typecheck
pnpm --filter @osas/chatwoot-adapter test
```
