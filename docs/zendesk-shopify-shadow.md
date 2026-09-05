# Zendesk + Shopify Shadow Mode Guide

[中文版](zendesk-shopify-shadow.zh-CN.md)

v0.1.1 Milestone 3 ships the reference integration pattern for running OSAS
against a real helpdesk (Zendesk) and a real commerce backend (Shopify) in
**Shadow Mode**: the agent proposes and simulates, humans decide and execute.

## What Shadow Mode is

`OSAS_EXECUTION_MODE=shadow | live` (default `shadow`).

- **shadow** — the only supported mode in v0.1.1. The runtime may only:
  1. create `ActionProposal`s,
  2. run deterministic policy simulation,
  3. record a `ShadowRun` — "if automatic execution were allowed, this is
     what would have run" (`wouldAutoExecute`, `suggestedAction`),
  4. let a human record the final outcome (`accepted` / `rejected` /
     `modified`, with comment and external reference).
- **live** — refuses to start. Booting with `OSAS_EXECUTION_MODE=live`
  aborts with `LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1`. Real execution
  capability requires a future RFC.

Shadow Mode invariants (enforced by code + tests):

- A Shadow Mode flow **never** marks a proposal `executed`; `POST
  /v1/proposals/:id/execute` refuses (409) any proposal that has a ShadowRun.
- Prompt injection, unverified/expired identity, stale evidence,
  over-threshold amounts and duplicate requests can never reach
  `wouldAutoExecute: true` — `wouldAutoExecute` is exactly
  `policyDecision.decision === "auto_execute"`, so every §4 block/approval
  reason keeps it false.
- Every human accept/reject/modify writes a `shadow_run_reviewed` audit
  event (actorType `human`); creation writes `shadow_run_created`.
- The audit hash chain (`GET /v1/audit/verify`) covers all of it.

## Components

| Piece | Package | Role |
|---|---|---|
| Zendesk adapter | `@osas/zendesk-adapter` | tickets ↔ Case, users ↔ Customer, internal notes, escalations to a configured group, evidence capture (ticket/user id + agent URL) |
| Shopify adapter | `@osas/shopify-adapter` | **read-only** orders/fulfillments → OSAS Order/Shipment + Evidence; refund Proposal drafts priced from live data |
| Shadow runtime | `@osas/ecommerce-shadow` | `ShadowRun` planning/review, stores, `OSAS_EXECUTION_MODE` loader |
| API | `@osas/api` | `POST /v1/proposals/:id/shadow-run`, `POST /v1/shadow-runs/:id/review`, `GET /v1/shadow-runs` |
| Console | `@osas/web` | Shadow page: pending reviews, agent suggestion, policy reasons, evidence links, audit-chain status — no live-execute UI |

## Configuration

All via env (see `.env.example`). Both adapters **fail closed** when their
credentials are missing — they throw `ZendeskNotConfiguredError` /
`ShopifyNotConfiguredError` and never fake a success.

```bash
# Shadow Mode (default; "live" aborts startup in v0.1.1)
OSAS_EXECUTION_MODE=shadow

# Zendesk
ZENDESK_BASE_URL=https://acme.zendesk.com   # or ZENDESK_SUBDOMAIN=acme
ZENDESK_EMAIL=agent@acme.example
ZENDESK_API_TOKEN=...                        # never logged, never audited
ZENDESK_ESCALATION_GROUP_ID=4242             # default human-escalation group

# Shopify (read-only)
SHOPIFY_SHOP_DOMAIN=acme.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=...               # Admin API token (read scopes suffice)
SHOPIFY_API_VERSION=2025-01                  # optional, pinned default
```

The demo Docker environment keeps the Mock Adapter and needs **no** Zendesk
or Shopify tokens; the reference adapters are for staging/production-style
deployments and for their mock-HTTP test suites.

## End-to-end flow

1. **Intake.** `ZendeskAdapter.getCase()` maps ticket → OSAS Case;
   `getCustomer()` maps the requester → Customer (identity stays
   `unverified` — Zendesk logins are not OSAS identity verification).
2. **Evidence.** `captureTicketEvidence` / `captureUserEvidence` file the
   ticket/user as Evidence whose `source` is the Zendesk id + agent URL.
   `ShopifyAdapter.buildRefundProposalDraft(orderId)` reads the order and
   fulfillments, computes the refundable amount (total minus refunds already
   recorded) and captures order/shipment/refund-eligibility Evidence.
3. **Proposal.** The agent creates a refund `ActionProposal` referencing
   that evidence (existing `POST /v1/proposals`).
4. **Shadow run.** `POST /v1/proposals/:id/shadow-run` runs the §4 policy
   simulation (pure — no status change, no approval, no handoff), stores a
   `ShadowRun` with `policyDecision`, `wouldAutoExecute` and
   `suggestedAction`, and audits `shadow_run_created`.
5. **Human review.** A human does the real work in Zendesk/Shopify (or
   declines), then records it: `POST /v1/shadow-runs/:id/review` with
   `{ outcome, humanComment?, externalReference? }`. Reviewed runs are final
   (re-review → 409). The review is audited as `shadow_run_reviewed` with
   the reviewer's actor id.
6. **Oversight.** The console Shadow page lists pending reviews with policy
   reasons and original evidence links, and shows the audit-chain
   verification result.

## Notes and limits

- Zendesk writes (internal note, escalation) are idempotent: the idempotency
  key is cached in-process and forwarded as `X-Idempotency-Key`.
- The Shopify adapter has **no refund write path**: `executeAction` always
  throws `CAPABILITY_UNSUPPORTED` without making any HTTP request. Adding
  real refund execution is a deliberate non-goal of v0.1.1 and requires an
  independent RFC.
- `ZendeskAdapter` region is not knowable from a ticket; Customer.region is
  the `"ZZ"` placeholder and identity is always `unverified` — policies that
  require verified identity will (correctly) block auto-execution.
