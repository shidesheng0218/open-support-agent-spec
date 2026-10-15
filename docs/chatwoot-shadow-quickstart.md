# Chatwoot Shadow Quickstart

[中文版](chatwoot-shadow-quickstart.zh-CN.md)

Run OSAS next to a real [Chatwoot](https://www.chatwoot.com/) inbox in
**Shadow Mode**. For each customer message the agent proposes an action, the
policy engine decides, and OSAS writes **one private note** into the
conversation. Nothing is executed and nothing is sent to the customer.

```
Chatwoot webhook ──HMAC check──▶ governance inbox (dedupe / order / enqueue)
                                        │  background drain or /jobs/drain
                                        ▼
 recent customer messages → injection screen → model proposal
   → policy engine → ShadowRun → one private note in the conversation
```

Verified once end to end against Chatwoot 4.18.0 (self-hosted, docker) with the
mock model, in-memory storage and demo auth. Not verified: a real model,
Postgres storage, `jwt` auth, concurrency, retries, or Chatwoot being
unreachable.

## 1. Configure OSAS

| Variable | Purpose |
|---|---|
| `OSAS_GOVERNANCE_EVENT_CONSUMER=chatwoot-shadow` | Registers the shadow worker. Startup fails closed if the next three are missing. |
| `CHATWOOT_BASE_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_API_TOKEN` | Chatwoot API access. The token is sent as `api_access_token` and is never logged. |
| `OSAS_CHATWOOT_WEBHOOK_SECRET_<TENANT>__<CONNECTION>` | Webhook signing secret, at least 16 characters. Each part is upper-cased with non-alphanumerics replaced by `_`. For tenant `tenant_demo` and connection `conn_ab12` the name is `OSAS_CHATWOOT_WEBHOOK_SECRET_TENANT_DEMO__CONN_AB12`. |
| `OSAS_GOVERNANCE_WORKER_INTERVAL_MS` | Optional, minimum 250. Starts a background drain. Unset means no timer; call `POST /v1/governance/jobs/drain` yourself. |

Use `OSAS_AUTH_MODE=jwt` for anything reachable from outside your machine. The
webhook path `/v1/webhooks/*` skips JWT (Chatwoot cannot send one) and relies on
the signature instead. Every other path still requires a token.

## 2. Create the connection

The connection's `externalAccountId` must equal `CHATWOOT_ACCOUNT_ID`. A
connection that names a different account never receives the Chatwoot client.

```bash
curl -s -X POST "$OSAS/v1/governance/connections" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"provider":"chatwoot","externalAccountId":"1","capabilities":["ticket.read"]}'
```

Connections start paused and events are only accepted while a connection is
`active`. The reference API ships no connection probe, so verification parks
the connection in `error`. Activation in the reference build is done through
the store (see `apps/api/src/chatwoot-shadow.test.ts`); a production
deployment supplies its own probe.

## 3. Register the webhook in Chatwoot

Create an **account-level** webhook (`webhook_type: account_type`), subscribed
to `message_created` and `conversation_created`, with the secret from step 1:

```
URL:    https://<your-osas-host>/v1/webhooks/chatwoot/<tenantId>/<connectionId>
Secret: <the value of OSAS_CHATWOOT_WEBHOOK_SECRET_...>
```

An inbox-level webhook record (`inbox_type`) did **not** deliver in the
verification run on Chatwoot 4.18.0: no `WebhookJob` was enqueued. The
Chatwoot listener delivers API-inbox events through the channel's own
`webhook_url` instead. Use the account-level webhook.

Chatwoot signs each delivery as
`X-Chatwoot-Signature: sha256=HMAC-SHA256(secret, "<X-Chatwoot-Timestamp>.<raw body>")`.
OSAS verifies the exact bytes received, accepts a 5 minute clock window, and
deduplicates on `X-Chatwoot-Delivery`. Missing, malformed, stale or wrong
signatures, unknown connections, other tenants and unconfigured secrets all get
the same `401`.

### Self-hosted Chatwoot and private addresses

Chatwoot sends webhooks through `SafeFetch`. The Chatwoot `.env.example` says
private-network targets are blocked by default and can be allowed with
`SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true`. The verification run set that flag
because OSAS ran on the host. Running without it was **not** tested, so treat
the blocking behaviour as documented upstream, not as something observed here.
A public HTTPS URL for OSAS avoids the question.

When OSAS runs on the docker host, do not rely on `host.docker.internal` in the
webhook URL. In repeated runs it sometimes resolved to an IPv6 address
(`Failed to open TCP connection to fdc4:...:3001` in the sidekiq log) while OSAS
listens on IPv4 only, so deliveries were lost. `scripts/e2e-chatwoot.sh` uses
the container's IPv4 address for the host instead; after that change 5 of 5
consecutive runs passed.

## Optional: read-only Shopify order evidence

Set `SHOPIFY_SHOP_DOMAIN` and `SHOPIFY_ADMIN_ACCESS_TOKEN` (read scopes are
enough) and create an active connection with `provider: "shopify"` and
`externalAccountId` equal to the shop domain. For order-related proposals the
worker then reads the order, and attaches it as evidence only when the order's
email equals the Chatwoot contact's email. Otherwise the note says why nothing
was attached (order not found, belongs to another contact, no contact email, no
connection, Shopify error) and policy blocks the proposal as before. Shopify is
only ever called with GET.

Even with evidence attached, a Chatwoot contact stays `unverified` with region
`ZZ`, so refunds still need a human. A web-widget email can be self-asserted,
so the email match narrows the risk but is not identity verification.

Covered by unit tests with a faked Shopify HTTP client. **Not** run against a
real Shopify store.

## 4. What you get in the conversation

```
[OSAS shadow] Suggested: refund $20.00 (reason: other)
Policy v1.0.0: blocked by policy
  - IDENTITY_UNVERIFIED: rule requires a verified identity but status is 'unverified'
  - REGION_UNLISTED: customer region 'ZZ' is not in allowedRegions for actionType 'refund'
  - INSUFFICIENT_EVIDENCE: financial actionType 'refund' requires at least one evidence reference
Evidence: none attached (Chatwoot holds no order data)
Not verified against any order system. Check the order before acting.
Shadow mode: nothing has been executed.
Refs: proposal prop_1 / shadow run shadow_...
```

Notes carry ids, the action and policy reasons. They never carry the customer's
message text or contact details.

Behaviour worth knowing:

- Only customer-authored messages are read. Private notes and agent replies are
  ignored, so the worker cannot trigger itself.
- Text that looks like prompt injection is not sent to a model. The worker
  writes a short notice and records a `prompt_injection_blocked` audit event.
- A message that maps to no action produces no note.
- A refund suggestion is blocked on this setup for three independent reasons,
  not one. A Chatwoot contact is always `unverified` with region `ZZ`, and the
  worker attaches no evidence. Supplying order evidence alone will not change
  the verdict.
- Failed jobs are not retried automatically (inbound events are classified as
  side-effecting by default). A dead-lettered job opens a reconciliation.

## 5. Check it

```bash
curl -s "$OSAS/v1/governance/integration-events" -H "authorization: Bearer $TOKEN"
curl -s "$OSAS/v1/governance/jobs"               -H "authorization: Bearer $TOKEN"
curl -s "$OSAS/v1/shadow-runs"                   -H "authorization: Bearer $TOKEN"
```

The repeatable harness for the verification run is
[`scripts/e2e-chatwoot.sh`](../scripts/e2e-chatwoot.sh). It needs docker and
pulls roughly 4 GB of images, so it is not part of `pnpm test` or CI.
