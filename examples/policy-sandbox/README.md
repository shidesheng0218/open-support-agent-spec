# OSAS policy sandbox

**One file. No install. The real engine.**

[`policy-sandbox.html`](policy-sandbox.html) is a single self-contained HTML file
(~21 kB, zero external requests) that runs `@osas/policy-engine` in the browser.
Download it, open it, and the decision boundary becomes something you can feel:
drag the refund amount past $50 and the gate closes.

It exists because "the model proposes, the policy decides" is easy to say and hard
to picture. Here you can *find* the boundary instead of reading about it.

## What it shows

| You do | The engine says | Reason code |
|---|---|---|
| $25 damaged-item refund | `auto_execute` | — (all checks passed) |
| drag the amount past $50 | `require_approval` | `OVER_THRESHOLD` |
| tick "the customer message contains instructions" | `block` | `PROMPT_INJECTION_SUSPECTED` |
| tick "let the model ask for execute" | `block` | `PERMISSION_OVERREACH` |
| tick "the evidence is 30 days old" | `block` | `EVIDENCE_STALE` |

Every verdict comes from `evaluateProposal()` — the same function the API and MCP
layers call. The UI decides nothing; it paints what the engine returns, and the
"raw engine output" panel shows that JSON verbatim.

## Rebuild

```bash
pnpm install && pnpm build
pnpm --filter @osas-examples/policy-sandbox run build   # rewrites policy-sandbox.html
pnpm --filter @osas-examples/policy-sandbox run test    # 15 tests
```

The committed HTML is rebuilt into a scratch file and compared **byte for byte**,
so it cannot drift from `src/`: editing the source without rebuilding fails CI.

## Why `node:crypto` is stubbed

The policy-engine barrel re-exports its audit-chain and action-binding modules,
which import `node:crypto` for SHA-256. The sandbox exercises neither, but a
bundler still has to resolve the whole import graph, so `build.mjs` substitutes a
stub — one that **throws**.

It deliberately does not ship a hand-rolled SHA-256. A security project's demo must
not contain a fake implementation of the primitive it is demonstrating; if a future
scenario ever reaches those paths it fails loudly instead of hashing wrongly.

## 中文版

`policy-sandbox.html` 是一个**单文件、零依赖**的 HTML（约 21 kB，不发起任何外部请求），
下载后用浏览器打开即可运行真实的 `@osas/policy-engine`。拖动退款金额越过 $50，闸门会合上；
勾选"客户消息里含有指令"，它会直接拒绝。

之所以做这个，是因为"模型提议、策略决定"这句话好说、难看见——这里你可以**自己找出边界**，
而不是读一段文字。

页面上的每个判定都来自 `evaluateProposal()`，与 API / MCP 层调用的是同一个函数；界面只负责
显示，不做任何决策，底部"引擎原始输出"面板会原样展示那份 JSON。

重新构建：`pnpm --filter @osas-examples/policy-sandbox run build`；测试：
`pnpm --filter @osas-examples/policy-sandbox run test`。已提交的 HTML 会与重新构建的结果逐字节
比对，因此不会与 `src/` 脱节。
