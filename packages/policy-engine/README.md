# @osas/policy-engine

[中文文档](./README.zh-CN.md)

The deterministic governance layer for customer-support agent write actions.

LLMs are good at proposing actions ("refund $25 on order ord_5001") and bad at
being trusted with them. This package is the boundary in between: the model
**proposes**, `evaluateProposal` **decides** — deterministically, with reasons —
and nothing reaches your backend write path unless policy says so.

It is part of the [Open Support Agent Spec (OSAS)](https://github.com/shidesheng0218/open-support-agent-spec)
reference implementation, but it is designed to be embedded **standalone**: no
OSAS API server, MCP server, or database is required. The only runtime
dependency is [`@osas/core`](../core) (pure types, enums, and state machines).

## What you get

- **Deterministic policy evaluation** (`evaluateProposal`): an `ActionProposal`
  plus a `TenantPolicy` and context goes in; a `PolicyDecision`
  (`auto_execute` / `require_approval` / `block`) with machine-readable reason
  codes comes out. No LLM calls, no I/O, no side effects.
- **A hard permission ladder** (`read < draft < request-approval < execute`):
  model principals are capped at `request-approval`; a model asking for
  `execute` is blocked with `PERMISSION_OVERREACH`, always.
- **Idempotent execution orchestration** (`executeProposal`, `reconcile`):
  replay protection keyed by `(tenantId, idempotencyKey)`, status guards, and
  `uncertain` adapter outcomes parked in `reconciliation_required` — never
  auto-retried.
- **Policy version lifecycle** (`PolicyStore`, `InMemoryPolicyStore`):
  immutable versions moving `draft → simulated → approved → active → retired`.
- **Tamper-evident audit chains** (`hashAuditEvent`, `verifyAuditChain`):
  SHA-256 hash chaining over a tenant's append-only audit stream.

## Install

```bash
npm install @osas/policy-engine   # brings in @osas/core
```

Requires Node.js >= 20. The package is ESM-only with bundled TypeScript
declarations.

## Quick start

Define a policy, submit an `ActionProposal` (what your model/agent wants to
do), and read the decision:

```ts
import {
  evaluateProposal,
  type ActionProposal,
  type EvaluationContext,
  type TenantPolicy,
} from "@osas/policy-engine";

const NOW = new Date("2026-09-07T12:00:00.000Z");

// 1. Tenant policy: refunds auto-execute up to $50.00 USD; larger ones
//    escalate to a human. Unmatched actions are blocked by default.
const policy: TenantPolicy = {
  id: "pol_acme",
  specVersion: "0.2",
  tenantId: "tenant_acme",
  version: "1.0.0",
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  duplicateWindowSeconds: 86400,
  maxEvidenceAgeSeconds: 604800,
  rules: [
    {
      actionType: "refund",
      decision: "auto_execute",
      maxAmount: { currency: "USD", minorUnits: 5000 }, // $50.00
      reasonCodes: ["damaged", "wrong_item", "not_received"],
    },
  ],
  defaultDecision: "block",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const ctx: EvaluationContext = {
  policy,
  evidence: [],
  recentProposals: [],
  injectionSuspected: false,
  now: NOW, // injectable clock → fully deterministic in tests
};

const proposal: ActionProposal = {
  id: "prop_1",
  specVersion: "0.2",
  tenantId: policy.tenantId,
  caseId: "case_1001",
  profile: "ecommerce",
  actionType: "refund",
  reasonCode: "damaged",
  params: { orderId: "ord_5001" },
  requestedPermission: "request-approval",
  requestedBy: {
    actorType: "model",
    actorId: "support-agent-1",
    model: { provider: "example-provider", model: "support-llm-v1" },
  },
  amount: { currency: "USD", minorUnits: 2500 }, // $25.00
  evidenceIds: ["ev_order_5001"],
  idempotencyKey: "idem_1",
  status: "proposed",
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

const decision = evaluateProposal(proposal, ctx);
// → { decision: "auto_execute", reasons: [], policyVersion: "1.0.0", ... }
```

Three outcomes to handle:

| `decision`         | Meaning                                  | Typical routing in your app            |
| ------------------ | ---------------------------------------- | -------------------------------------- |
| `auto_execute`     | Every check passed                       | Mark `approved`, then execute          |
| `require_approval` | Allowed only with a human in the loop    | Park as `pending_approval`, notify     |
| `block`            | Policy violation (see `reasons[].code`)  | Mark `policy_rejected`, log/handoff    |

Change the amount to `50000` and the same code returns
`require_approval` with reason `OVER_THRESHOLD`. Set
`requestedPermission: "execute"` and it returns `block` with
`PERMISSION_OVERREACH` — model principals can never execute directly.

A complete runnable version of this example (including all three scenarios,
with assertions) lives in
[`examples/embed-policy-engine`](../../examples/embed-policy-engine):

```bash
pnpm install && pnpm build
node examples/embed-policy-engine/dist/main.js
```

## How evaluation works

`evaluateProposal(proposal, ctx)` runs the ordered checks from OSAS
CONTRACTS.md §4, collects **all** applicable reasons, and returns the worst
decision (`block` > `require_approval` > `auto_execute`):

1. `PERMISSION_OVERREACH` — model principal requested `execute` → block
2. `PROMPT_INJECTION_SUSPECTED` — `ctx.injectionSuspected` → block
3. `PROFILE_MISMATCH` — `actionType` doesn't belong to `proposal.profile` → block
4. `NO_RULE` — no policy rule matches the `actionType` → block (default block)
5. `REASON_CODE_NOT_ALLOWED` → block
6. `DUPLICATE_REQUEST` — deep-equal params within `duplicateWindowSeconds` → block
7. `OVER_THRESHOLD` / `CURRENCY_MISMATCH` vs `rule.maxAmount` → require_approval
8. `IDENTITY_REQUIRED` / `IDENTITY_UNVERIFIED` → block
9. `REGION_BLOCKED` / `REGION_UNLISTED` → block / require_approval
10. `INSUFFICIENT_EVIDENCE` / `EVIDENCE_STALE` → block / require_approval
11. Otherwise the matched rule's baseline `decision`

The engine is **pure**: it never mutates proposals, writes audit events, or
talks to adapters. Side effects (status transitions, approvals, handoffs,
audit emission) are your embedding layer's job — or the OSAS API server's, if
you run the full stack.

## Permission ladder

`read < draft < request-approval < execute` — ordered in `PERMISSIONS`,
comparable via `permissionAtLeast(a, b)`:

| Level              | Typical holder          | Allowed to                                                   |
| ------------------ | ----------------------- | ------------------------------------------------------------ |
| `read`             | model                   | Read case/customer/evidence data through the adapter         |
| `draft`            | model                   | Produce draft proposals; nothing enters the approval queue   |
| `request-approval` | model (**hard cap**)    | Submit proposals for human/policy decision                   |
| `execute`          | humans / backend only   | Execute approved actions against real systems                |

Enforcement is structural, not advisory: a proposal with
`requestedPermission: "execute"` from `actorType: "model"` is blocked with
`PERMISSION_OVERREACH` regardless of amounts, rules, or evidence.

## API surface

Everything below is exported from the package root (`src/index.ts`).

**Evaluation**

- `evaluateProposal(proposal, ctx) → PolicyDecision`
- `EvaluationContext`, `POLICY_REASON_CODES`, `PolicyReasonCode`

**Execution orchestration**

- `executeProposal(proposal, adapter, store, now?) → Promise<ExecuteOutcome>`
- `reconcile(proposal, outcome)`
- `ActionExecutor`, `ActionExecutorContext` — minimal structural interface;
  any object with a compatible `executeAction` satisfies it (no hard
  dependency on `@osas/adapter`)
- `ExecutionStore`, `InMemoryExecutionStore`, `StoredExecution`
- `ExecutionStatusError`, `ReconcileStatusError`

**Policy version lifecycle**

- `PolicyStore`, `InMemoryPolicyStore`, `PolicyVersionRecord`
- `PolicyVersionNotFoundError`, `PolicyVersionConflictError`

**Audit hash chain**

- `hashAuditEvent(event) → string`
- `verifyAuditChain(events) → AuditChainVerification`
- `AUDIT_CHAIN_GENESIS_HASH`, `AuditChainError`, `AuditChainErrorReason`

**Utilities**

- Money (integer minor units, never floats): `compareMoney`,
  `compareMoneySafe`, `sameCurrency`
- Deterministic serialization: `stableStringify`, `deepEqual`

**Re-exported from `@osas/core`** (so embedders usually need only this
package): all domain types (`TenantPolicy`, `PolicyRule`, `ActionProposal`,
`PolicyDecision`, `Customer`, `Evidence`, `Money`, …), `PERMISSIONS`,
`permissionAtLeast`, `ACTION_TYPE_PROFILE`, `FINANCIAL_ACTION_TYPES`, and the
proposal state machine (`PROPOSAL_TRANSITIONS`, `canTransitionProposal`,
`transitionProposal`, `IllegalTransitionError`).

## Versioning

All `@osas/*` packages share **one semantic version** with the OSAS
specification and are released in lockstep (see
[GOVERNANCE.md](../../GOVERNANCE.md#versioning)):

- The current **0.2.x** line implements `specVersion: "0.2"` — the
  `specVersion` field you'll see on every domain object.
- While in **v0.x**, any minor bump may be breaking. Pin exact versions in
  production and read the changelog before upgrading.

## Relationship to OSAS

Embedding this package in your system **does not** make your system
OSAS-compatible, and you must not claim "OSAS compatibility" on that basis.
Compatibility is a property of a whole implementation (API surface, schemas,
profiles, state machines) and is established only by passing the compatibility
suite (`@osas/compat-suite`) for a declared profile — see
[GOVERNANCE.md § "Declaring compatibility"](https://github.com/shidesheng0218/open-support-agent-spec/blob/main/GOVERNANCE.md#declaring-compatibility).

If you *do* want the full stack (HTTP API, MCP server, Postgres stores,
approval queues, audit pipeline), this same engine powers it — see the
[repository root](../../README.md).

## License

Apache-2.0. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
