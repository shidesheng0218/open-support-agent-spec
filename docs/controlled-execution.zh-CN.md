# 受控执行 Profile（v0.3 Draft）

OSAS v0.2 仍然以 Shadow 为默认模式。v0.3 Draft 增加确定性的 Sandbox 执行
路径，用于在没有真实电商凭据的情况下验证幂等、执行凭证、Provider Event
和对账流程。

## 快速开始

```bash
OSAS_EXECUTION_MODE=sandbox pnpm dev:api
```

Sandbox 只使用合成 fixture，不调用 Shopify、Zendesk、Chatwoot、支付系统或
任何外部网络。

## 执行响应

`POST /v1/proposals/:id/execute` 除原有 Proposal 和 Execution 外，还会返回：

- `attempt`：请求哈希、模式、状态和时间戳；
- `receipt`：Provider 状态、外部引用和重试安全性；
- `reconciliation`：Provider 返回未知结果时生成的对账任务。

Sandbox 可确定性模拟成功、失败和超时。`simulate: "timeout"` 不修改业务
fixture，并且一定会创建开放对账任务。

## Provider Event

配置内部事件密钥：

```bash
OSAS_PROVIDER_EVENT_KEY=local-sandbox-key
```

请求携带 `x-osas-provider-key`。事件会经过 Schema 校验、哈希、去重和审计，
并通过幂等键匹配对账任务。`payload.status` 为 `succeeded` 或 `failed` 时，
匹配的开放任务会被解决。

## 生产边界

`OSAS_EXECUTION_MODE=live` 仍然会启动失败。参考 Shopify、Zendesk、Chatwoot
Adapter 都不会声明 live。真实生产写入必须等待后续 RFC、Provider 认证、回调
验证、租户显式开启、补偿语义和独立 Live Conformance Suite。

规范细节见 [RFC 0003](../rfcs/0003-controlled-execution-profile.zh-CN.md) 和
`schemas/execution-v0.3/`。
