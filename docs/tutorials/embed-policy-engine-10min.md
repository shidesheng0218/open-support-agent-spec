# Embed the Policy Engine in 10 Minutes

[中文版](embed-policy-engine-10min.zh-CN.md)

The fastest way to adopt OSAS is not the API server — it is the governance layer
alone. `@osas/policy-engine` is a plain TypeScript library: proposals in,
deterministic decisions out. No database, no MCP, no network.

This tutorial walks through the runnable example at
[examples/embed-policy-engine](../../examples/embed-policy-engine). By the end you
will have a tenant policy, three evaluated proposals, and the mental model for
everything else in OSAS.

## 0. What you are building

A refund gate for an existing support tool: the model (or any upstream code)
fills in an `ActionProposal`; the engine returns `auto_execute`,
`require_approval`, or `block` with machine-readable reasons. Your code — never
the model — decides what happens next.

## 1. Install (2 min)

Until the packages hit npm, use them from a repo checkout:

```bash
git clone https://github.com/shidesheng0218/open-support-agent-spec.git
cd open-support-agent-spec
pnpm install && pnpm build
node examples/embed-policy-engine/dist/main.js
```

You should see three decisions printed and `All assertions passed.`

## 2. Define the tenant policy (3 min)

The policy is the deterministic rulebook evaluated per tenant. This one
auto-executes refunds up to $50.00 with an allow-listed reason and blocks
everything unmatched (`defaultDecision` is always `block`):

```ts
const policy: TenantPolicy = {
  // ...id, specVersion: "0.2", tenantId, version, timestamps...
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
};
```

Money is integer minor units — never floats. Every object carries
`specVersion: "0.2"`.

## 3. Evaluate proposals (3 min)

```ts
import { evaluateProposal } from "@osas/policy-engine";

const ctx: EvaluationContext = {
  policy,
  evidence: [],            // loaded evidence objects the proposal references
  recentProposals: [],     // the duplicate-detection window
  injectionSuspected: false,
  now: new Date(),         // injectable: evaluation stays deterministic
};

const decision = evaluateProposal(myRefundProposal, ctx);
// decision.decision: "auto_execute" | "require_approval" | "block"
// decision.reasons: [{ code, message }] — every applicable reason, worst wins
```

Three outcomes from the example:

| Proposal | Decision | Why |
|---|---|---|
| $25.00 refund, within limit | `auto_execute` | all checks passed |
| $500.00 refund, above limit | `require_approval` | `OVER_THRESHOLD` — route to your human queue |
| model requests `execute` | `block` | `PERMISSION_OVERREACH` — models are capped at `request-approval` |

## 4. What the engine checked for you

One `evaluateProposal` call ran the full ladder (spec §5): permission overreach,
prompt-injection flag, profile match, rule match, reason-code allow-list,
duplicate window, amount threshold, identity, regions, evidence freshness.
The final decision is the **worst** applicable outcome — check order cannot be
gamed.

Fail-closed details worth knowing before you rely on them:

- `recentProposals: undefined` (window not loaded) blocks with
  `DUPLICATE_WINDOW_UNAVAILABLE`; an empty array means "loaded and empty".
- A `refund` without `amount`, or a matched rule without `maxAmount`, blocks
  with `AMOUNT_REQUIRED` — omitting the amount is not a way past the threshold.
- Missing or stale evidence blocks with `INSUFFICIENT_EVIDENCE` /
  `EVIDENCE_STALE`.

## 5. Next steps

- Execute decisions through `executeProposal` (idempotency store included) — see
  the source walkthrough in [CONTRACTS.md](../../CONTRACTS.md) §5.
- Wrap proposals in the audit hash chain (`@osas/policy-engine` audit-chain
  module) for tamper-evident records.
- Full runtime (HTTP API, console, MCP tools): the repository root README has
  the sixty-second Docker path.
- **Say so.** If you embedded the engine, add yourself to
  [ADOPTERS.md](../../ADOPTERS.md) via PR — no conformance run is required for
  integration listings.