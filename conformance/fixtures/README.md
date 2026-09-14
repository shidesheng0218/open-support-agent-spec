# Demo tenant fixtures (machine-readable)

`demo-tenant.json` is the authoritative machine-readable form of the demo
dataset described in [CONTRACTS.md §11](../../CONTRACTS.md). The compat
runner's stateful suite assumes the target's conformance-mode `reset` seeds
exactly this dataset (`tenant_demo`, `cus_verified`, `ord_small`, `pol_demo`
with the $50 refund auto-execute threshold, and so on).

Independent implementations should load this file and seed their conformance
mode from it rather than transcribing the prose contract.

## Timestamp encoding

Fixture timestamps must stay relative so the dataset never goes stale (e.g.
`ev_ord_small` evidence must still be fresh, `ev_expired` must still be
expired, whenever a conformance run happens). Every timestamp field is
therefore a token, never an absolute date:

| Token | Meaning |
|---|---|
| `"now"` | the moment the fixtures are materialized |
| `"now-<N><unit>"` | N units before now |
| `"now+<N><unit>"` | N units after now |

`<unit>` is one of `s` (seconds), `m` (minutes), `h` (hours), `d` (days).
Materialized timestamps are ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`).

Pseudo-code:

```text
materialize(value, base):
  if value matches /^now([+-]\d+[smhd])?$/ → base + signed offset, as ISO
  arrays/objects → recurse
  anything else → unchanged
```

The TypeScript reference materializes tokens in
`packages/mock-backend/src/demo-tenant-fixture.test.ts` (drift guard) and the
Python reference in `implementations/python-reference/server.py`.

## Regenerating

The TypeScript fixtures (`packages/mock-backend/src/fixtures.ts`) are the
runtime source. After editing them:

```bash
pnpm --filter @osas/mock-backend build
pnpm --filter @osas/mock-backend fixtures:emit
```

The drift-guard test in `@osas/mock-backend` fails if the committed JSON no
longer matches the runtime fixtures.
