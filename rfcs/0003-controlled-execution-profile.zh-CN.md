# RFC 0003：受控执行 Profile

- **状态：** Draft
- **作者：** OSAS founding maintainers
- **创建日期：** 2026-09-09
- **目标版本：** OSAS v0.3 Draft

## 摘要

本 RFC 为电商售后动作定义受控执行 Profile，增加确定性的 `sandbox`
模式、执行尝试与执行凭证、Provider Event 接入、对账任务，以及按动作类型
描述的执行合同。

本 RFC 不开放生产写入。`live` 仍然启动即 fail-closed，必须等后续 RFC 明确
Provider 认证、租户显式开启、回滚/补偿、监控和独立 Live Conformance Suite。

## 执行模式

| 模式 | 含义 | 默认 |
|---|---|---|
| `proposal_only` | 只生成结构化建议 | 否 |
| `shadow` | 只求值并记录“如果执行会怎样” | 是 |
| `sandbox` | 对合成、确定性的 Provider 行为执行 | 否 |
| `live` | 调用真实 Provider 执行 | 本 RFC 拒绝 |

参考 API 接受 `OSAS_EXECUTION_MODE=sandbox`，但只使用合成 fixture；配置
`live` 会在启动时拒绝。

## 规范对象

Schema 位于 `schemas/execution-v0.3/`：

- `ExecutionCapability`
- `ExecutionAttempt`
- `ExecutionReceipt`
- `ReconciliationTask`
- `ProviderEvent`

所有对象都有租户边界、拒绝未知字段，并使用 `specVersion: "0.3"`。

## 安全规则

1. 模型主体最大权限仍是 `request-approval`。
2. 只有服务端系统执行主体可以调用 `execute`。
3. `(tenantId, idempotencyKey)` 是执行重放边界。
4. Provider 返回 `uncertain` 时禁止自动重试。
5. 未知结果为一次执行尝试创建一个开放对账任务。
6. Provider Event 按 `(tenantId, provider, providerEventId)` 去重。
7. 只有幂等键匹配且状态为 `succeeded` 或 `failed` 的事件才能解决对账任务。
8. 所有执行尝试、凭证、Provider Event、对账和补偿判断都必须进入审计流。
9. `exchange_request` 仍然只能人工履约，模型不可执行。
10. 缺能力必须返回 `CAPABILITY_UNSUPPORTED`，不能伪造成功。

## API

扩展：

- `POST /v1/proposals/:id/execute` 返回 `attempt`、`receipt` 和可选的
  `reconciliation`。
- `POST /v1/proposals/:id/reconcile` 支持人工/系统对账。

新增：

- `GET /v1/executions/:id`
- `GET /v1/reconciliation?status=open|resolved`
- `POST /v1/provider-events`

Provider Event 必须携带内部 `x-osas-provider-key`，服务端从
`OSAS_PROVIDER_EVENT_KEY` 读取密钥。密钥不会进入模型上下文或审计详情。

## Adapter 与持久化

`CapabilityManifest.executionContracts` 描述每个动作支持的模式、审批、幂等、
对账和补偿能力。

Mock/Sandbox Adapter 声明 sandbox 能力；Shopify、Zendesk、Chatwoot 继续是
只读/参考集成，不声明 live。

默认 Demo 使用内存存储；PostgreSQL 部署会持久化执行尝试、凭证、对账任务和
Provider Event，并使用租户级唯一索引保护幂等和事件去重。

生产 Live 需要后续 RFC，不能因为通过本 RFC 就被默认开启。
