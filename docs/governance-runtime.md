# Governance Runtime (M1)

The governance control plane: organizations, workspaces, connections, reliable
event ingest, a job queue, reconciliation, and governed cases — provider-neutral
by construction (see [ADR 0001](adr/0001-platform-scope.md)).

Package: [`@osas/governance`](../packages/governance) · HTTP surface:
`/v1/governance/*` (see `GET /v1/openapi.json`).

## Why this layer exists

The OSAS runtime answers "may this action happen?". The governance layer answers
a different set of questions that every real deployment hits immediately:

- Which tenant is this, and who inside it may touch what?
- Is this integration actually connected, and what is it allowed to do?
- This event arrived twice. Now what?
- This event arrived *late*. Now what?
- A worker died mid-write. Did it happen?

Each of those has a fail-closed answer here instead of a plausible-looking
default.

## Domain model

| Record | Purpose |
|---|---|
| `Organization` | Top-level account boundary. |
| `Workspace` | The unit of tenant isolation. Owns exactly one `tenantId`; that 1:1 mapping is what lets this layer sit on top of the existing tenant-scoped stores. |
| `Membership` | Role binding for a principal, workspace-scoped or organization-wide. |
| `Connection` | A tenant-scoped link to one external account, with declared capabilities and an opaque credential reference. |
| `IntegrationEvent` | Inbox record for one delivered event, deduplicated on the provider's identity. |
| `JobRun` | Queued work with a lease, a retry class, and a hard deadline. |
| `Reconciliation` | The only allowed endpoint for an uncertain outcome. |
| `GovernedCase` | Provider-neutral case record; joins to the core runtime through evidence/proposal/approval ids. |
| `GovernanceUsageEvent` | Control-plane metering: governed objects, never tokens. |

### Two invariants worth stating explicitly

**No secret is ever stored.** A connection holds a `credentialRef` — a pointer
with a scheme (`vault:secret/data/osas/acme`, `env:ACME_TOKEN`,
`aws-sm:prod/osas/acme`). Values that look like tokens (provider key prefixes,
JWTs, `Bearer` strings, AWS key ids) or that have no scheme are refused with
`SECRET_REFUSED`. The rule is structural, not entropy-based, so a leaked request
body cannot become a leaked row.

**Governance roles never widen the permission ladder.** Control-plane
capabilities (`connection:write`, `approval:decide`, …) are a separate axis
from the adapter ladder (`read < draft < request-approval < execute`). No
governance role maps to `execute`, and `system_executor` maps to nothing at all.

## Connection lifecycle

```
create ──► paused ──verify(ok)──► active ──pause──► paused
             │                      │                 │
             └──verify(fail)──► error└──revoke──► revoked ──► delete
                                      ▲
                       rotate ────────┘ (returns to paused)
```

- **New connections are paused.** Nothing may use a connection until a probe has
  proven it works. A failed probe parks it in `error` with the code recorded.
- **Resume requires a prior successful verification.** You cannot un-pause a
  connection that was never proven.
- **Rotation returns to paused**, because the new credential is unproven.
- **Only revoked connections can be deleted**, so an active integration is never
  removed out from under in-flight work.
- **One live connection per provider account.** Two connections reading the same
  account would double-ingest every event; the second create is a conflict.
- **Write capabilities require a credential reference.** Declaring the ability
  to write without any way to authenticate is a configuration error.

## Reliable ingest

```
delivery ──► verified? ──no──► rejected (never occupies a dedupe key)
                │yes
                ▼
          duplicate? ──yes──► recorded as "duplicate", NO job
                │no
                ▼
     behind the watermark? ──yes──► "stale_ignored" + reconciliation + refetch job
                │no
                ▼
             "received" + one job  (nothing executes inline)
```

- **Dedupe key is the provider's identity**: `(tenantId, connectionId, topic,
  externalEventId)`. A replay can never create a second row, even under
  concurrent delivery.
- **Unverified deliveries are rejected before insert.** If a forged event could
  occupy the dedupe key, an attacker could suppress the genuine delivery that
  follows.
- **Ordering uses the provider timestamp, never the receipt time.** An event that
  arrives behind the accepted watermark is parked as `stale_ignored`, a
  reconciliation is opened, and a **read-only refetch job** is queued. The stale
  payload is never applied.
- **Ingesting is not acting.** The HTTP request that receives an event enqueues
  work; it never executes anything.

## Jobs, leases, and retry classification

Retry classification is a safety property, not a tuning knob:

| Retry class | Used for | On failure |
|---|---|---|
| `safe_read` | idempotent reads (`reconciliation.refetch`) | requeued with exponential backoff up to `maxAttempts` |
| `side_effecting` | anything that may have changed provider state | **never retried** — dead-lettered and reconciled |

- **Only claim what you can run.** A worker claims only job kinds it has a
  handler for, so an unhandled job stays visible in the queue instead of being
  claimed and destroyed.
- **Leases, not locks.** Claiming is atomic (`FOR UPDATE SKIP LOCKED` on
  PostgreSQL), so two workers cannot lease the same job. A worker that dies
  leaves a lease that expires.
- **An expired lease on a side-effecting job is an unknown outcome.** The sweep
  dead-letters it and opens a reconciliation; it is never silently retried.
- **No "failed" resting state.** A job failure either returns to `queued` for a
  permitted retry or ends in `dead_letter`, so "will this still happen?" is
  answerable from the status alone.

## Reconciliation

A reconciliation is the only allowed endpoint for uncertainty. It is created by
the runtime, never by a model or an external caller, and it is idempotent on
`(tenantId, dedupeKey)`:

| Reason | Raised when |
|---|---|
| `unknown_outcome` | a side-effecting job dead-lettered or its worker's lease expired |
| `out_of_order_event` | an event arrived behind the accepted watermark |
| `provider_error` | reserved for classified provider failures |
| `manual` | opened by an operator |

Deciding one is a single-shot compare-and-set: it requires the version you read,
records who resolved it and how, and refuses a second decision. Resolution writes
a `reconciliation_resolved` event to the OSAS audit chain — an existing
normative event type, so the governance plane joins the audit trail without a
schema change.

## Governed case state machine

```
intake ─► evidence_required ─► proposed ─► pending_approval ─► executing ─► resolved
   │              │                │              │                │
   └──────────────┴────────────────┴──────────────┴────────────────┴──► blocked
                                                    executing ─► reconciliation_required ─► resolved
```

`resolved` is terminal. `reconciliation_required` is deliberately **not**
terminal: an uncertain outcome must stay reachable by a human. Transitions are
validated inside a compare-and-set, so a racing or illegal transition writes
nothing.

## HTTP surface

| Method and path | Purpose |
|---|---|
| `GET /v1/governance/health` | Control-plane snapshot: connections, inbox, queue, open reconciliations, metering |
| `POST /v1/governance/workspaces` | Provision the organization/workspace pair (idempotent per tenant) |
| `GET\|POST /v1/governance/connections` | List / create connections |
| `GET\|DELETE /v1/governance/connections/{id}` | Read / delete (after revoke) |
| `POST /v1/governance/connections/{id}/verify\|pause\|resume\|rotate\|revoke` | Lifecycle |
| `POST /v1/governance/integration-events` | Internal ingest (deduped, never executes inline) |
| `GET /v1/governance/integration-events` | Inbox records |
| `GET /v1/governance/jobs` | Job queue |
| `POST /v1/governance/jobs/drain` | One worker sweep for this tenant (`job:operate`) |
| `GET /v1/governance/reconciliations` | Reconciliation records |
| `POST /v1/governance/reconciliations/{id}/decide` | Resolve or dismiss (single shot) |
| `GET /v1/governance/usage` | Control-plane metering |

Every route is tenant-scoped to the authenticated principal's tenant and gated
by the governance capability matrix. A route never decides authorization beyond
naming the capability it needs.

### Roles

| Role | Intended for | Notable limits |
|---|---|---|
| `owner` | Account owner | Only role that may rewrite the organization boundary |
| `admin` | Platform administration | Everything except `organization:write` |
| `operator` | Day-to-day queue work | **Cannot decide approvals** |
| `approver` | Authorizing and reconciling | **Cannot change connections, members, or cases** |
| `auditor` | Review | Read-only |
| `viewer` | Stakeholders | Cases, approvals, audit only |

`support_agent` is the only default mapping that yields `operator`; a principal
whose roles grant nothing still gets nothing — there are no implicit grants.

## Configuration

| Variable | Meaning |
|---|---|
| `OSAS_STORAGE`, `DATABASE_URL` | `postgres` binds the control plane to PostgreSQL; otherwise in-memory |
| `OSAS_GOVERNANCE_EVENT_KEY` | Internal key for event ingest. **Absent = endpoint disabled.** |
| `OSAS_GOVERNANCE_EVENT_CONSUMER` | `none` (default) or `record-only` |

### About `record-only`

The reference API can register a *record-only* event consumer that advances the
inbox state machine and performs **no business action**. It is off by default and
must be enabled explicitly, because a consumer that reports success without
doing work is exactly the kind of lie this codebase refuses to tell implicitly.
A real deployment registers a handler that does the work.

## What M1 does not do

- No policy editing or approval queue UI (M2).
- No audit search over governance operations, and no new audited event types —
  extending the normative `eventType` enum requires an RFC (M2).
- No execution. The control plane provisions connections and routes work; it
  never performs a business action.
- No provider probes shipped: verification requires a deployment-supplied probe
  and fails closed (`NO_PROBE_CONFIGURED`) without one.

## Verifying it

```bash
pnpm --filter @osas/governance run test        # domain, RBAC, lifecycle, ingest, jobs
pnpm --filter @osas/api run test               # HTTP surface and tenant isolation
DATABASE_URL=... pnpm --filter @osas/store-postgres run test   # store parity on PostgreSQL
```

The PostgreSQL suite is gated on `DATABASE_URL`: without it those tests skip, so
`pnpm test` needs no service.
