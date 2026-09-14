# MCP 2026-07 修订对齐

[English](mcp-2026-07-alignment.md)

- **对应版本：** MCP 规范 **2026-07-28** 修订
- **OSAS 版本：** v0.2
- **状态：** Draft（草案）
- **相关文档：** [RFC 0002](../rfcs/0002-osas-as-mcp-governance-profile.md)、[schemas/tools/README.md](../schemas/tools/README.md)（Annotations 映射规则）

MCP 2026-07 修订引入了三项与 OSAS 密切相关的变化：用 multi-round-trip
（MRTR）取代 elicitation/sampling、server 无状态化、以及扩展的工具注解
词汇表。本文档记录 OSAS 治理 Profile 如何对应这三项变化。本文档是对齐
说明，不产生规范层面的变更。

## 1. MRTR 对齐

2026-07 修订用 **multi-round-trip（MRTR）** 取代了旧的 elicitation 与
sampling 机制：工具调用可以返回 `input_required` 结果类型并携带
`inputRequests`；客户端补齐缺失输入（来自人工或模型）后**重发同一工具
调用**，调用随后正常完成。

OSAS 的 request-approval 交互与 MRTR 天然同构——这一结构在修订落地前
就是如此设计的：

1. 模型调用 `osas_core_create_action_proposal`（或某个 proposal 快捷工
   具），为具有副作用的动作创建提案。
2. 租户策略对提案求值。若需要审批，提案进入 `require_approval`，流程
   停在 `await_approval`——概念上这就是一个 `input_required` 结果：
   待决项告诉客户端*缺什么*（人工审批决定）以及*由谁*补答。
3. 人工客户端（控制台、AG-UI 前端，或经 A2A 的另一 agent）给出答案：
   批准或拒绝。
4. 恢复同一调用上下文——审批决定重新进入确定性策略引擎，提案变为
   `approved` 或 `rejected`，随后按策略允许的范围执行，幂等与审计锚定
   规则不变。

概念时序：

```
model → create_action_proposal（require_approval 动作）
      → 策略判定：require_approval
      → await_approval                     [input_required + inputRequests]
client（人工）补答审批决定
      → 同一提案重新求值                   [MRTR 第 2 轮]
      → approved → 策略引擎执行（或转人工），否则 rejected
```

MRTR 的表述让标准客户端可以用一等公民的方式呈现审批等待，而不必把它
当作针对 API 的临时轮询循环。

## 2. 无状态化

2026-07 修订明确 **server 无状态化**：server 不得在请求之间持有按会话
划分的交互状态；可恢复的状态应放在数据平面。

OSAS 在构造上即满足此要求，并将其作为卖点：MCP server
（`@osas/mcp-server`）**完全不持有会话状态**。每个请求自带
`ToolContext`（租户、principal），而一切可恢复的事物——等待审批的
ActionProposal、审批记录、作出判定的策略版本——都存放在 adapter 边界
之后的 **proposal store**（如 `@osas/store-postgres`）中。server 进程
可以重启、水平扩缩容或由多副本提供服务，进行中的审批状态分毫不丢；
恢复的 MRTR 第 2 轮全部依据 store 作答。

## 3. 工具注解

2026-07 修订扩展了工具注解，新增行为提示词汇表，其中包括
`readOnlyHint` 与 `mutatingHint`。全部 20 个 OSAS 工具 schema 通过顶层 `annotations` 对象
声明其类别，`@osas/mcp-server` 将这些注解透传到 MCP 工具定义上（在
所安装的 SDK 类型化 2026-07 注解集之前，`mutatingHint` 暂经 `_meta`
携带）。完整映射表与治理层警示——注解只是声明式元数据，强制力仍来自
权限阶梯与策略引擎——以
[schemas/tools/README.md](../schemas/tools/README.md) 为准。

## 4. 迁移策略

OSAS 承诺自本文档日期起 **12 个月的双修订支持窗口**：

- 窗口期内，`@osas/mcp-server` 继续服务基于 2026-07 之前修订基线的客
  户端：保留现有 transport 适配，request-approval 流程不强制要求客户
  端具备 MRTR 能力（审批仍可通过既有 API 面读写）。
- 2026-07 注解为增量添加，旧客户端会忽略它们，因此工具列表双向兼容。
- 窗口期结束时项目将重新评估：下线旧路径、再延长一次，或发布迁移
  RFC。本文档不改动任何代码；上述计划是承诺，而非实现。

## 状态

Draft（草案）。一旦至少一个独立实现在互操作测试中确认了 MRTR 映射，
本文档将随相应 RFC 一并晋升。
