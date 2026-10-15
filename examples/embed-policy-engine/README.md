# embed-policy-engine

The smallest way to put OSAS policy in front of an agent's write actions. It uses
only `@osas/core` and `@osas/policy-engine`. There is no API server, MCP server,
database or LLM call.

## Run

From the repo root:

```bash
pnpm install
pnpm build
pnpm --filter @osas-examples/embed-policy-engine run demo
```

## What it shows

`main.ts` defines one tenant policy (refunds up to $50.00 may auto-execute,
anything unmatched is blocked) and evaluates three proposals:

| proposal | decision | why |
| --- | --- | --- |
| $25.00 refund | `auto_execute` | within the rule limit |
| $500.00 refund | `require_approval` | `OVER_THRESHOLD` |
| model asks for the `execute` permission | `block` | `PERMISSION_OVERREACH` |

The script asserts each result, so a non-zero exit means the behavior changed.

## Next step

To also hold approvals and run your own write path, see
[`@osas/agent-guard`](../../packages/agent-guard), which wraps the same engine
with approval digests, expiry and idempotent execution.
