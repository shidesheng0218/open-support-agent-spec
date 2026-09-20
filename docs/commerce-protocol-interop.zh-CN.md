# 商业协议售后事件互操作（v0.3 Draft）

[English](commerce-protocol-interop.md)

OSAS 用于治理交易完成后的售后动作；它不实现结账、支付，也不实现某个外部
商业协议。本指南定义参考实现接收来自 UCP 或 ACP 接入的事后事件时，所采用的
最小映射边界。

这是一个 **OSAS 映射 Profile**，并不声称符合 UCP、ACP 或任何 Provider 的
Webhook 格式。Adapter 负责上游协议客户端、认证、签名校验和字段提取。

## 信任边界

Adapter 调用内部 `POST /v1/provider-events` 前，必须完成以下工作：

1. 校验上游协议签名、OAuth 声明或双向认证传输；
2. 将外部订单和事件绑定到唯一的 OSAS `tenantId`；
3. 提取稳定的 Provider Event ID 与幂等键；
4. 删除售后证据和对账不需要的数据。

`x-osas-provider-key` / `OSAS_PROVIDER_EVENT_KEY` 是 Adapter 到 OSAS 的内部
凭证，**不能**替代上游签名校验；它绝不能交给模型、浏览器客户端或外部商业
Provider。

## 支持的事件词表

当 `provider` 为 `"ucp"` 或 `"acp"` 时，参考 API 仅接受以下 OSAS 事后事件：

| 领域 | 事件类型 |
|---|---|
| 订单 | `order.created`、`order.cancelled` |
| 履约 | `fulfillment.shipped`、`fulfillment.delayed`、`fulfillment.delivered` |
| 退款 | `refund.requested`、`refund.succeeded`、`refund.failed` |
| 退货 | `return.requested`、`return.received` |

未知事件会以 `422 SCHEMA_INVALID` 失败即关闭；不会写入、审计或用于解决对账任务。

## 规范化

来源 Adapter 完成认证和字段规范化后，使用标准 ProviderEvent 请求体调用内部 API：

```json
{
  "provider": "ucp",
  "providerEventId": "evt_refund_123",
  "eventType": "refund.succeeded",
  "idempotencyKey": "refund_123",
  "occurredAt": "2026-09-20T00:00:00.000Z",
  "payload": {
    "orderId": "ord_123",
    "refundId": "refund_123",
    "status": "succeeded"
  }
}
```

参考实现会保存以下规范化后的 `ProviderEvent.payload`：

```json
{
  "source": {
    "protocol": "ucp",
    "eventType": "refund.succeeded"
  },
  "data": {
    "orderId": "ord_123",
    "refundId": "refund_123",
    "status": "succeeded"
  }
}
```

载荷哈希基于该规范化形式计算。Provider Event 去重键仍是
`(tenantId, provider, providerEventId)`；执行重放键仍是
`(tenantId, idempotencyKey)`。

## 对账与执行边界

只有事件幂等键与开放对账任务所属 Proposal 匹配时，`refund.succeeded` 和
`refund.failed` 才可解决该任务。事件绝不能创建退款、把 Proposal 变成执行请求，
也绝不能赋予模型执行权限。未知 Provider 结果仍为 `reconciliation_required`，
绝不自动重试。

本映射与 Shadow、Sandbox 兼容；`live` 仍保持关闭。

## Adapter 测试清单

- 使用内部 Provider Event Key 前先校验上游签名。
- 外部订单不属于已解析租户时必须拒绝。
- 空事件 ID 和不支持的事件类型必须拒绝。
- 断言重复投递只返回第一次保存的事件，不产生第二次对账或审计状态变化。
- 测试只使用合成或完全脱敏的事件载荷。
