# @osas/agent-guard

A small gate in front of any support-agent write action.

```
model proposes -> policy decides -> (human approves) -> your executor runs
```

Built on [`@osas/policy-engine`](../policy-engine). No server, database or LLM call.

> **Not yet published to npm.** Build it from a checkout: `pnpm install && pnpm build`.

## Use

```ts
import { createAgentGuard } from "@osas/agent-guard";

const guard = createAgentGuard({
  policyFor: (tenantId) => loadTenantPolicy(tenantId), // a TenantPolicy
  executor: {
    async executeAction(ctx, proposal) {
      // Your real write path. Called only for allowed actions.
      const re = await billing.refund(proposal.params.orderId, proposal.amount);
      return { status: "succeeded", externalRef: re.id };
    },
  },
});

const r = await guard.propose({
  tenantId: "tenant_acme",
  caseId: "case_1",
  actionType: "refund",
  reasonCode: "damaged",
  params: { orderId: "ord_1" },
  amount: { currency: "USD", minorUnits: 2500 },
  evidence: [orderEvidence],
  idempotencyKey: "case_1:refund:1",
  requestedBy: { actorType: "model", actorId: "support-agent-1" },
});

if (r.outcome === "pending_approval") {
  // Show r.pending.actionDigest to a human, then:
  await guard.decide(r.pending, { approve: true, approverId: "alice" });
}
```

## Outcomes

| outcome | meaning |
| --- | --- |
| `executed` | Policy allowed it (and a human, if required). Your executor ran once. |
| `pending_approval` | Policy needs a human. Nothing ran. |
| `blocked` | Policy said no. Nothing ran. |
| `execution_failed` | Your executor reported failure. |
| `needs_reconciliation` | Your executor reported an uncertain result. It is never retried. |

## What it guarantees

- A model can ask for at most `request-approval`; asking for `execute` is blocked.
- An approval covers exactly one action: `decide` needs the `actionDigest` from
  the pending approval, and execution re-checks it.
- A pending approval is decided once, expires after `approvalTtlSeconds`
  (default 24h), and is scoped to its tenant.
- The same `idempotencyKey` never reaches your executor twice (within the
  execution store you give it).
- Evidence from another tenant is ignored.

## Limits

- Pending approvals and recent proposals are held in memory. After a restart
  they are gone. The default execution store is also in memory; pass your own
  `ExecutionStore` if replay protection must survive restarts.
- It does not authenticate approvers. Check who may call `decide` yourself.
- Tested with a fake executor only, not against a real payment or helpdesk system.
