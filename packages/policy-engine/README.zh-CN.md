# @osas/policy-engine

[English README](./README.md)

面向客服 AI Agent 写入动作的**确定性治理层**。

LLM 擅长提议动作（"给订单 ord_5001 退款 $25"），但不应被信任直接执行。这个包就是中间的边界：模型负责**提议**，`evaluateProposal` 负责**决策**——确定性的、带理由代码的决策——只有策略放行，动作才能到达你的后端写路径。

它是 [Open Support Agent Spec (OSAS)](https://github.com/shidesheng0218/open-support-agent-spec) 参考实现的一部分，但设计上可以**独立嵌入**：不需要 OSAS 的 API Server、MCP Server 或数据库。唯一的运行时依赖是 [`@osas/core`](../core)（纯类型、枚举与状态机）。

## 你能得到什么

- **确定性策略求值**（`evaluateProposal`）：输入一个 `ActionProposal` 加 `TenantPolicy` 与上下文，输出 `PolicyDecision`（`auto_execute` / `require_approval` / `block`）及机器可读的理由代码。无 LLM 调用、无 I/O、无副作用。
- **硬性权限阶梯**（`read < draft < request-approval < execute`）：模型主体的上限是 `request-approval`；模型请求 `execute` 一律以 `PERMISSION_OVERREACH` 拒绝。
- **幂等执行编排**（`executeProposal`、`reconcile`）：以 `(tenantId, idempotencyKey)` 为重放保护键，带状态守卫；适配器返回 `uncertain` 时挂起到 `reconciliation_required`——绝不自动重试。
- **策略版本生命周期**（`PolicyStore`、`InMemoryPolicyStore`）：不可变版本沿 `draft → simulated → approved → active → retired` 流转。
- **防篡改审计哈希链**（`hashAuditEvent`、`verifyAuditChain`）：对租户级追加式审计流做 SHA-256 链式哈希。

## 安装

```bash
npm install @osas/policy-engine   # 会自动带入 @osas/core
```

要求 Node.js >= 20。包为纯 ESM，自带 TypeScript 类型声明。

## 快速上手

定义策略，提交一个 `ActionProposal`（你的模型/Agent 想做的动作），读取决策：

```ts
import {
  evaluateProposal,
  type ActionProposal,
  type EvaluationContext,
  type TenantPolicy,
} from "@osas/policy-engine";

const NOW = new Date("2026-09-07T12:00:00.000Z");

// 1. 租户策略：$50.00 USD 以内的退款自动执行；超出则升级人工审批。
//    未匹配的动作默认拒绝（defaultDecision 恒为 "block"）。
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
  now: NOW, // 可注入时钟 → 测试中完全确定性
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

需要处理的三种结果：

| `decision`         | 含义                           | 应用内典型路由                     |
| ------------------ | ------------------------------ | ---------------------------------- |
| `auto_execute`     | 全部检查通过                   | 标记 `approved`，随后执行          |
| `require_approval` | 仅允许人工介入后执行           | 挂起为 `pending_approval` 并通知   |
| `block`            | 违反策略（见 `reasons[].code`）| 标记 `policy_rejected`，记录/转人工|

把金额改成 `50000`，同样的代码会返回 `require_approval`，理由为 `OVER_THRESHOLD`；把 `requestedPermission` 设为 `"execute"`，则返回 `block`，理由为 `PERMISSION_OVERREACH`——模型主体永远无法直接执行。

包含全部三个场景（带断言）的完整可运行示例见
[`examples/embed-policy-engine`](../../examples/embed-policy-engine)：

```bash
pnpm install && pnpm build
node examples/embed-policy-engine/dist/main.js
```

## 求值机制

`evaluateProposal(proposal, ctx)` 按 OSAS CONTRACTS.md §4 的有序检查执行，收集**所有**命中的理由，并返回最严重的一档决策（`block` > `require_approval` > `auto_execute`）：

1. `PERMISSION_OVERREACH`——模型主体请求 `execute` → block
2. `PROMPT_INJECTION_SUSPECTED`——`ctx.injectionSuspected` → block
3. `PROFILE_MISMATCH`——`actionType` 不属于 `proposal.profile` → block
4. `NO_RULE`——没有匹配该 `actionType` 的策略规则 → block（默认拒绝）
5. `REASON_CODE_NOT_ALLOWED` → block
6. `DUPLICATE_REQUEST`——`duplicateWindowSeconds` 内参数深度相等 → block
7. `OVER_THRESHOLD` / `CURRENCY_MISMATCH`（对比 `rule.maxAmount`）→ require_approval
8. `IDENTITY_REQUIRED` / `IDENTITY_UNVERIFIED` → block
9. `REGION_BLOCKED` / `REGION_UNLISTED` → block / require_approval
10. `INSUFFICIENT_EVIDENCE` / `EVIDENCE_STALE` → block / require_approval
11. 否则取命中规则的基准 `decision`

引擎是**纯函数式的**：它不修改 proposal、不写审计事件、不调用适配器。副作用（状态迁移、审批、转人工、审计落盘）由你的嵌入层负责——如果你跑 OSAS 全栈，则由 OSAS API Server 负责。

## 权限阶梯

`read < draft < request-approval < execute`——顺序定义在 `PERMISSIONS` 中，可用 `permissionAtLeast(a, b)` 比较：

| 级别               | 典型持有者          | 允许做什么                                   |
| ------------------ | ------------------- | -------------------------------------------- |
| `read`             | 模型                | 通过适配器读取工单/客户/证据数据             |
| `draft`            | 模型                | 产出提议草稿；不进入审批队列                 |
| `request-approval` | 模型（**硬上限**）  | 提交提议，交由人工/策略决策                  |
| `execute`          | 仅人类/后端         | 对已批准的动作执行真实系统写入               |

执行是结构性强制的，不是劝告式的：只要 `requestedPermission: "execute"` 且 `actorType: "model"`，无论金额、规则、证据如何，一律以 `PERMISSION_OVERREACH` 拒绝。

## API 面

以下符号均从包根导出（`src/index.ts`）。

**求值**

- `evaluateProposal(proposal, ctx) → PolicyDecision`
- `EvaluationContext`、`POLICY_REASON_CODES`、`PolicyReasonCode`

**执行编排**

- `executeProposal(proposal, adapter, store, now?) → Promise<ExecuteOutcome>`
- `reconcile(proposal, outcome)`
- `ActionExecutor`、`ActionExecutorContext`——最小结构化接口；任何带兼容 `executeAction` 方法的对象都满足（不硬依赖 `@osas/adapter`）
- `ExecutionStore`、`InMemoryExecutionStore`、`StoredExecution`
- `ExecutionStatusError`、`ReconcileStatusError`

**策略版本生命周期**

- `PolicyStore`、`InMemoryPolicyStore`、`PolicyVersionRecord`
- `PolicyVersionNotFoundError`、`PolicyVersionConflictError`

**审计哈希链**

- `hashAuditEvent(event) → string`
- `verifyAuditChain(events) → AuditChainVerification`
- `AUDIT_CHAIN_GENESIS_HASH`、`AuditChainError`、`AuditChainErrorReason`

**工具函数**

- 金额（整数最小货币单位，绝不用浮点）：`compareMoney`、`compareMoneySafe`、`sameCurrency`
- 确定性序列化：`stableStringify`、`deepEqual`

**从 `@osas/core` 再导出**（嵌入方通常只需依赖本包）：全部领域类型（`TenantPolicy`、`PolicyRule`、`ActionProposal`、`PolicyDecision`、`Customer`、`Evidence`、`Money`……）、`PERMISSIONS`、`permissionAtLeast`、`ACTION_TYPE_PROFILE`、`FINANCIAL_ACTION_TYPES`，以及 proposal 状态机（`PROPOSAL_TRANSITIONS`、`canTransitionProposal`、`transitionProposal`、`IllegalTransitionError`）。

## 版本策略

所有 `@osas/*` 包与 OSAS 规范共享**同一个语义版本**，lockstep 发布（见
[GOVERNANCE.md](../../GOVERNANCE.md#versioning)）：

- 当前 **0.2.x** 系列实现 `specVersion: "0.2"`——你在每个领域对象上看到的 `specVersion` 字段就是它。
- 处于 **v0.x** 期间，任意 minor 升级都可能包含 breaking change。生产环境请锁定精确版本，升级前阅读 changelog。

## 与 OSAS 全栈的关系

把本包嵌入你的系统**并不等于**你的系统兼容 OSAS，也不得据此宣称"OSAS 兼容"。兼容性是整个实现（API 面、schema、profile、状态机）的属性，只有通过对所声明 profile 跑兼容套件（`@osas/compat-suite`）才能成立——见
[GOVERNANCE.md「Declaring compatibility」](https://github.com/shidesheng0218/open-support-agent-spec/blob/main/GOVERNANCE.md#declaring-compatibility)。

如果你**确实**需要全栈（HTTP API、MCP Server、Postgres 存储、审批队列、审计流水线），全栈用的正是这同一个引擎——见[仓库根目录](../../README.md)。

## 许可证

Apache-2.0。见 [LICENSE](../../LICENSE) 与 [NOTICE](../../NOTICE)。
