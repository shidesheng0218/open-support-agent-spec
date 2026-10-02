# 10 分钟嵌入策略引擎

[English](embed-policy-engine-10min.md)

采用 OSAS 最快的方式不是 API 服务器——而是单独的治理层。`@osas/policy-engine`
是一个纯 TypeScript 库：提案进，确定性决策出。不需要数据库、MCP 或网络。

本教程逐步讲解可运行示例
[examples/embed-policy-engine](../../examples/embed-policy-engine)。读完你将拥有
一个租户策略、三个评估过的提案，以及理解 OSAS 其余部分所需的心智模型。

## 0. 你要构建什么

为现有客服工具加一个退款闸门：模型（或任何上游代码）填写 `ActionProposal`；
引擎返回 `auto_execute`、`require_approval` 或 `block`，附机器可读的原因。
接下来怎么做由你的代码决定——永远不由模型决定。

## 1. 安装（2 分钟）

包发布到 npm 之前，从仓库检出使用：

```bash
git clone https://github.com/shidesheng0218/open-support-agent-spec.git
cd open-support-agent-spec
pnpm install && pnpm build
node examples/embed-policy-engine/dist/main.js
```

你应当看到打印出的三个决策和 `All assertions passed.`。

## 2. 定义租户策略（3 分钟）

策略是按租户评估的确定性规则手册。下面这条对 50 美元以内、理由在允许清单中的
退款自动执行，其余一律阻断（`defaultDecision` 恒为 `block`）：

```ts
const policy: TenantPolicy = {
  // ...id、specVersion: "0.2"、tenantId、version、时间戳...
  duplicateWindowSeconds: 86400,
  maxEvidenceAgeSeconds: 604800,
  rules: [
    {
      actionType: "refund",
      decision: "auto_execute",
      maxAmount: { currency: "USD", minorUnits: 5000 }, // 50.00 美元
      reasonCodes: ["damaged", "wrong_item", "not_received"],
    },
  ],
  defaultDecision: "block",
};
```

金额是整数最小货币单位——绝不用浮点数。每个对象都携带 `specVersion: "0.2"`。

## 3. 评估提案（3 分钟）

```ts
import { evaluateProposal } from "@osas/policy-engine";

const ctx: EvaluationContext = {
  policy,
  evidence: [],            // 提案引用的、已加载的证据对象
  recentProposals: [],     // 重复检测窗口
  injectionSuspected: false,
  now: new Date(),         // 可注入：评估保持确定性
};

const decision = evaluateProposal(myRefundProposal, ctx);
// decision.decision: "auto_execute" | "require_approval" | "block"
// decision.reasons: [{ code, message }]——收集所有适用原因，取最差结果
```

示例中的三个结果：

| 提案 | 决策 | 原因 |
|---|---|---|
| 25 美元退款，限额内 | `auto_execute` | 全部检查通过 |
| 500 美元退款，超限 | `require_approval` | `OVER_THRESHOLD`——路由到人工队列 |
| 模型请求 `execute` 权限 | `block` | `PERMISSION_OVERREACH`——模型上限是 `request-approval` |

## 4. 引擎替你检查了什么

一次 `evaluateProposal` 调用跑完了完整阶梯（规范 §5）：权限越界、提示注入标记、
profile 匹配、规则匹配、理由码白名单、重复窗口、金额阈值、身份、地区、证据
新鲜度。最终决策取**最差**的适用结果——检查顺序无法被利用。

在依赖它们之前值得知道的 fail-closed 细节：

- `recentProposals: undefined`（窗口未加载）以 `DUPLICATE_WINDOW_UNAVAILABLE`
  阻断；空数组表示"已加载且为空"。
- `refund` 缺 `amount`，或命中的规则缺 `maxAmount`，以 `AMOUNT_REQUIRED` 阻断——
  不报金额不是绕过阈值的办法。
- 证据缺失或过期以 `INSUFFICIENT_EVIDENCE` / `EVIDENCE_STALE` 阻断。

## 5. 下一步

- 用 `executeProposal` 执行决策（内置幂等存储）——源码走读见
  [CONTRACTS.md](../../CONTRACTS.md) §5。
- 用审计哈希链（`@osas/policy-engine` 的 audit-chain 模块）包裹提案，获得
  防篡改检测的记录。
- 完整运行时（HTTP API、控制台、MCP 工具）：仓库根 README 有 60 秒 Docker 路径。
- **说出来。** 如果你嵌入了这个引擎，请通过 PR 把自己加入
  [ADOPTERS.md](../../ADOPTERS.md)——集成类条目不需要合规运行。