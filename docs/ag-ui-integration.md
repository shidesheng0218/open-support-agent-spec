# Pairing OSAS with AG-UI (approval UX)

[中文版](ag-ui-integration.zh-CN.md)

> Integration guide, not normative text. RFC 0002 positions OSAS as the
> governance profile above the horizontal protocols; AG-UI is the agent↔UI
> one. This guide shows the concrete mapping for the most important shared
> interaction: **human approval of a proposed action**.

## Why the pairing is natural

OSAS produces *decision points*: a proposal evaluated as `require_approval`
creates an `Approval`, and nothing executes until a human decides. AG-UI
standardizes how an agent backend surfaces exactly such interruptions to a
frontend — as frontend tool calls and state events — without either side
inventing a bespoke channel. OSAS decides **whether** an action needs a
human; AG-UI decides **how** that human is asked.

The boundary stays clean: the frontend never talks to the policy engine, and
AG-UI events never carry authority. The decision HTTP call
(`POST /v1/approvals/:id/decide`) remains the only mutating path, authenticated
and audited as usual.

## The mapping

Scenario: a refund proposal is created via `POST /v1/chat` and the policy
engine returns `require_approval`.

| Step | OSAS side | AG-UI side |
|---|---|---|
| 1. Agent run begins | `POST /v1/chat` accepted | Backend emits `RUN_STARTED` |
| 2. Decision requires approval | Proposal → `pending_approval`; `Approval` created; audit `approval_created` | Backend emits `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` for a **frontend tool** (e.g. `render_approval_card`) whose args carry the proposal id, action type, amount, policy reasons, and evidence links |
| 3. Human reviews in the UI | (no OSAS traffic yet) | Frontend renders the approval card; the run stays open (paused) |
| 4. Human decides | Frontend calls `POST /v1/approvals/:id/decide` (`approve` / `reject`) with the authenticated human principal | Frontend emits `TOOL_CALL_RESULT` with the decision outcome so the agent run can continue |
| 5. Outcome | Approval → execution (idempotent, audited); rejection → audited, no execution | Backend streams the outcome (`TEXT_MESSAGE_*`), then `RUN_FINISHED` |
| 6. Failure | Any OSAS error (`{error:{code,…}}`) maps to a user-visible notice | `RUN_ERROR` with the code in the message payload |

State synchronization (approval queue counts, audit-chain badge) can ride
`STATE_SNAPSHOT` / `STATE_DELTA` events sourced from `GET /v1/approvals` and
`GET /v1/audit/verify`.

## Rules of the road

1. **Authority never crosses into AG-UI.** The approval card's args are a
   rendering of server state, not a decision. The frontend's decision call
   goes to the OSAS API with the human's own credentials; the backend
   re-verifies role (`support_agent`/`policy_admin`) and records the audit
   event with `actorType: "human"`.
2. **Idempotency survives the UI.** Retries, double-clicks, and reconnects
   are expected in chat UIs. They are absorbed by the OSAS idempotency
   boundary (`(tenantId, idempotencyKey)`), so the frontend may retry
   `decide` freely.
3. **No auto-execute from the frontend.** A UI must not expose an "execute"
   affordance fed by agent text; the only executions come from the
   server-side decision path (or Shadow Mode review).
4. **Timeouts fail safe.** If the human never responds, the approval simply
   stays pending — and, where the tenant policy sets `approval.timeoutSeconds`,
   it expires to a denial (`expired`, `APPROVAL_TIMED_OUT`). The AG-UI run
   SHOULD be closed with a clear message rather than left open.

## Reference points

- OSAS approval surface: `GET /v1/approvals`, `POST /v1/approvals/:id/decide`;
  Shadow review: `POST /v1/shadow-runs/:id/review` (same mapping applies to
  shadow-run review UX).
- The console's `/agent` page (`apps/web`) is a working non-AG-UI rendering of
  the same interaction — a useful reference for what the card must show
  (policy reasons, evidence, amount).
- AG-UI protocol: https://github.com/ag-ui-protocol/ag-ui — event transport
  (SSE/WebSocket) is your choice; OSAS does not care which you use.

A runnable example is tracked on the roadmap (README → Status & roadmap); the
mapping above is the contract it will implement.
