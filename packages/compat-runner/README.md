# @osas/compat-runner

[中文版](#中文版)

Black-box HTTP conformance runner for the
[Open Support Agent Spec (OSAS)](https://github.com/shidesheng0218/open-support-agent-spec).
It scores **any** OSAS implementation over HTTP — it never imports the target's
code — and produces a machine-readable report. This is the examiner: the registry
gate (`gateOk`) is defined so the party claiming compatibility is never the party
grading it.

## Usage

```bash
# against any OSAS implementation
npx @osas/compat-runner --target http://localhost:3001

# include the stateful suite (required for a registry claim)
npx @osas/compat-runner --target http://localhost:3001 \
  --conformance-key <test-only-key>

# the v0.3 controlled-execution profile
npx @osas/compat-runner --target http://localhost:3001 \
  --profile controlled-execution \
  --conformance-key <test-only-key> \
  --provider-event-key <test-only-key>
```

The target must run its conformance mode (`OSAS_CONFORMANCE_MODE=true` +
`OSAS_CONFORMANCE_KEY`) for the stateful checks. Never point that mode at a
production deployment — the spec forbids it from starting there.

## Reading the report

```jsonc
{
  "specVersion": "0.2",
  "generator": "@osas/compat-runner@0.2.1",
  "target": "http://localhost:3001",
  "mode": { "stateful": true },
  "ok": true,      // zero failed checks
  "gateOk": true,  // zero failed AND zero skipped — the registry gate
  "totals": { "passed": 22, "failed": 0, "skipped": 0 },
  "suites": [ /* per-check detail */ ]
}
```

- `ok: true` — everything that ran, passed. A read-only run (no
  `--conformance-key`) skips the stateful suite and reports `ok: true`.
- `gateOk: true` — additionally requires **zero skipped checks**.
  [GOVERNANCE.md](https://github.com/shidesheng0218/open-support-agent-spec/blob/main/GOVERNANCE.md#declaring-compatibility)
  requires `gateOk: true` for a compatibility registry entry.

Exit codes: `0` = all checks passed (`ok`), `1` = one or more failed, `2` =
usage error.

## What it checks

| Suite | Profile | Checks |
|---|---|---|
| `discovery` | v0.2 | `/.well-known/osas`, `specVersion`, CapabilityManifest validity, known profiles/capabilities |
| `schemas-tools` | v0.2 | schema manifest listing + retrieval, tool surface, `/v1/validate` accept/reject |
| `policy-read` | v0.2 | active TenantPolicy validates, unknown-version simulation 404s |
| `stateful` (key-gated) | v0.2 | conformance reset, audit-chain integrity, policy lifecycle + immutability, idempotent execution replay, RBAC, cross-tenant isolation |
| `controlled-execution` | v0.3 Draft | sandbox execution contracts, attempts/receipts, idempotent replay, timeout → reconciliation, provider-event dedup, policy-blocked actions cannot execute |

Implementers: see
[docs/implementing-osas.md](https://github.com/shidesheng0218/open-support-agent-spec/blob/main/docs/implementing-osas.md)
for the minimal surface per profile.

## Publishing (maintainers)

The runner is published so third-party implementers can self-verify without
checking out the spec repo. Release checklist:

1. `pnpm test && pnpm typecheck` in the repo (version-consistency gate keeps all
   `@osas/*` packages in lockstep).
2. `pnpm --filter @osas/core publish` , `pnpm --filter @osas/schema-validator publish`,
   `pnpm --filter @osas/policy-engine publish` if they have not been published at
   this version yet (the runner depends on them; pnpm rewrites `workspace:*` to
   the real version on publish).
3. `pnpm --filter @osas/compat-runner publish` (`prepublishOnly` rebuilds and
   re-runs the tests).
4. Verify: `npx @osas/compat-runner@latest --help`.

---

## 中文版

`@osas/compat-runner` 是 [Open Support Agent Spec（OSAS）](https://github.com/shidesheng0218/open-support-agent-spec)
的黑盒 HTTP 一致性 runner：它只通过 HTTP 给**任何** OSAS 实现打分，从不 import
目标实现的代码，并产出机器可读报告。它是"考官"——注册表门槛（`gateOk`）的设计
保证了声称兼容的一方绝不是打分的一方。

### 用法

```bash
npx @osas/compat-runner --target http://localhost:3001
npx @osas/compat-runner --target http://localhost:3001 --conformance-key <测试专用 key>
npx @osas/compat-runner --target http://localhost:3001 \
  --profile controlled-execution \
  --conformance-key <测试专用 key> --provider-event-key <测试专用 key>
```

stateful 检查要求目标开启 Conformance 模式（`OSAS_CONFORMANCE_MODE=true` +
`OSAS_CONFORMANCE_KEY`）。该模式绝不可用于生产部署——规范禁止它在生产启动。

### 报告读法

- `ok: true` —— 跑过的检查全部通过。不带 `--conformance-key` 的只读运行会跳过
  stateful 套件，此时 `ok: true`。
- `gateOk: true` —— 额外要求**零跳过**。注册表条目要求 `gateOk: true`。

退出码：`0` = 全部通过（`ok`），`1` = 存在失败，`2` = 用法错误。
