# OSAS Adapter 开发指南

[English](adapter-guide.md)

本指南说明如何实现 `SupportAdapter`，把 OSAS 接入真实的客服/电商/计费系统。
v0.2.0 附带三个参考实现：`@osas/zendesk-adapter`（工单系统）、
`@osas/shopify-adapter`（只读电商）与 `@osas/chatwoot-adapter`（开源客服台）
——建议对照源码阅读本指南。

## 契约

所有模型与 API 流量都经过 `SupportAdapter` 接口
（`packages/adapter/src/types.ts`）。每次调用都会收到 `ToolContext`：

```ts
interface ToolContext {
  tenantId: string;
  principal: { actorType: "model" | "human" | "system"; actorId: string; permission: Permission };
}
```

- **绝不信任调用方。** 用 `@osas/adapter` 的 `requirePermission` 强制权限阶梯
  （`read < draft < request-approval < execute`）。模型永远拿不到 `execute`。
- **一切按租户隔离。** 每次读写都限定 `ctx.tenantId`；跨租户访问必须不可能发生。
- **模型绝不持有后端凭证。** API 密钥只存在于 Adapter 配置（环境变量）中，
  仅作为 HTTP 头发送，绝不出现在日志、错误信息、审计事件或证据载荷里。

## 错误映射

| Adapter 错误 | API 结果 |
|---|---|
| `AdapterNotFoundError` | 404 `NOT_FOUND` |
| `AdapterPermissionError` | 403 `FORBIDDEN` |
| `AdapterCapabilityError` | 403 `CAPABILITY_UNSUPPORTED` |
| 其他 | 500 `INTERNAL_ERROR` |

上游 404 映射为 `AdapterNotFoundError`。其他上游失败包装为 Adapter 专属错误
（如 `ZendeskApiError`、`ShopifyApiError`），携带 HTTP 状态码，但**绝不**包含
请求头或请求体（可能含 Token 或 PII）。

## 失败即关闭（fail closed）

配置不完整的 Adapter 必须在构造/启动时抛错（参考实现中的
`ZendeskNotConfiguredError`、`ShopifyNotConfiguredError`），绝不伪造成功响应。
单个操作同理：未配置默认升级组（`ZENDESK_ESCALATION_GROUP_ID`）时，
`ZendeskAdapter.createEscalation` 直接抛错。

## 能力清单（Capability Manifest）

实现 `getCapabilities(ctx)` 发布 `CapabilityManifest`。一经声明即具约束力：
API 会对未声明的能力拒绝并返回 `CAPABILITY_UNSUPPORTED`。只声明真正支持的
能力——Shopify Adapter 刻意**不**声明 `ecommerce.refund.execute`。

不支持的操作抛 `AdapterCapabilityError`（参考两个 Adapter 中的
`unsupported(...)` 帮助函数模式）。

## HTTP 访问：可注入客户端

所有第三方流量都经过可注入的 HTTP 客户端：

```ts
interface HttpRequest { method: string; url: string; headers?: Record<string, string>; body?: unknown }
interface HttpResponse { status: number; body: unknown }
type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;
```

默认实现包装全局 `fetch`；测试注入 mock 客户端记录请求并返回预设响应。
Adapter 单元测试必须在**无外部凭证、无网络**的条件下通过——断言请求构造
（方法/URL/头/体）、错误映射与到 OSAS 对象的映射。

## 幂等写入

每个写入入参都带 `idempotencyKey`。参考 Adapter 的做法：

1. 在进程内按 key 缓存首个结果，重试时直接回放（不发第二次 HTTP 写）；
2. 同时把 key 以 `X-Idempotency-Key` 头转发给上游。

若上游原生支持幂等，优先使用原生机制。

## 证据（Evidence）

为决策读取外部记录时，将其转换为 OSAS `Evidence`：`source.system`
（如 `"zendesk"`、`"shopify"`）、`source.recordType` / `source.recordId`
（外部主键）与 `source.url`（人工可打开的控制台链接）。策略引擎基于证据做
判定；新鲜度（`retrievedAt` / `expiresAt`）由 §4 规则 10 强制。

## 执行纪律

`executeAction` 仅限 execute 权限，且永不注册为 MCP 工具。在 v0.2.0 Shadow
Mode 下，参考集成不得实现任何真实金融写操作：Shopify Adapter 的
`executeAction` 永远抛出 `CAPABILITY_UNSUPPORTED`，且不发任何 HTTP 请求。
新增真实执行能力必须经过独立 RFC 决策。

## 测试清单

- Mock-HTTP 测试在零凭证、零网络下通过。
- 未配置时 Adapter 抛错（fail closed）——且不发任何 HTTP 请求。
- 写入在 key 重放下幂等（断言恰好一次 HTTP 写）。
- 错误信息不泄露 Token（对错误字符串做断言）。
- `getCapabilities()` 与实际方法面一致。
