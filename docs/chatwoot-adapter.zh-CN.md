# Chatwoot Adapter 指南

[English](chatwoot-adapter.md)

`@osas/chatwoot-adapter` 是面向 [Chatwoot](https://www.chatwoot.com/)
（开源客服收件箱）REST API 的参考 `SupportAdapter`。它在结构与纪律上
完全对齐 Zendesk 参考 Adapter，仅覆盖 **core profile**：会话/联系人
读取、私有备注、人工升级与证据捕获。没有任何真实执行路径——仅
Shadow Mode。

> **打包说明：** `@osas/chatwoot-adapter` 是 private 参考实现
> （`"private": true`）——**未发布到 npm**，`npm install @osas/chatwoot-adapter`
> 不可行。请从本仓库源码构建（`pnpm --filter @osas/chatwoot-adapter build`），
> 或将其复制为自有 Adapter 的起点。仅 `@osas/core`、`@osas/schema-validator`、
> `@osas/policy-engine` 为公开 npm 包。

## 语义映射

| Chatwoot | OSAS | 说明 |
|---|---|---|
| Conversation（会话） | `Case`（`cw_conv_{id}`） | `subject` 取 `additional_attributes.mail_subject`（邮件渠道）或第一条公开的客户消息；兜底为 `Chatwoot conversation {id}` |
| Contact（联系人） | `Customer`（`cw_contact_{id}`） | 身份始终保持 `unverified`；`region` 在 `additional_attributes.country_code` 形似 ISO 3166-1 alpha-2 时取之，否则为占位 `"ZZ"` |
| Message（`private: true`） | `CaseNote` | 仅内部备注——绝不发公开回复 |
| 团队指派 + 私有备注 | `Escalation` | 把会话指派给 `CHATWOOT_ESCALATION_TEAM_ID` 并留下 `[OSAS escalation]` 私有备注 |
| 会话/联系人读取 | `Evidence` | `source.system: "chatwoot"`，`recordType` 为 `conversation`/`contact`，`recordId` 为 Chatwoot ID，`url` 为控制台链接 |

### 状态 / 优先级 / 渠道映射

- **状态：** `open → open`、`pending → pending_agent`、`snoozed →
  pending_agent`、`resolved → resolved`。Chatwoot 没有
  `pending_customer` 或 `closed` 状态；已解决的会话会设置 `closedAt`
  （取自 `updated_at`，兜底 `last_activity_at`）。
- **优先级：** `low → low`、`medium → normal`、`high → high`、
  `urgent → urgent`、`null → normal`。
- **渠道：** `Channel::Email → email`；`WebWidget` / `Whatsapp` /
  `TwilioSms` / `Sms` / `Telegram` / `Line → chat`；`FacebookPage` /
  `TwitterProfile` / `Instagram → social`；`Channel::Api → api`；
  未知渠道兜底为 `api`。
- **时间戳：** 会话返回 unix 秒级时间戳，联系人返回 ISO 字符串——
  映射层两者兼容并统一归一化为 ISO 8601。
- **受理人：** 有指派客服即 `assigneeType: "human"`，否则 `"none"`。

## 配置

全部通过环境变量。凭证缺失时 Adapter **失败即关闭**——
`chatwootConfigFromEnv` 抛出 `ChatwootNotConfiguredError`，绝不伪造
成功。

```bash
CHATWOOT_BASE_URL=https://app.chatwoot.com   # 或自建实例源（结尾斜杠会被去掉）
CHATWOOT_ACCOUNT_ID=7                        # API 路径中的数字账户 ID
CHATWOOT_API_TOKEN=...                       # 用户访问令牌；绝不打印日志、绝不写入审计
CHATWOOT_ESCALATION_TEAM_ID=12               # 默认人工升级团队
```

所有请求发往
`{CHATWOOT_BASE_URL}/api/v1/accounts/{CHATWOOT_ACCOUNT_ID}/...`，令牌以
`api_access_token` 请求头传递。令牌绝不出现在错误信息、日志、审计
事件或证据载荷中。

## 使用的端点

| 操作 | Chatwoot 调用 |
|---|---|
| `getCase` | `GET /conversations/{id}` |
| `searchCases`（按客户） | `GET /contacts/{id}/conversations` |
| `searchCases`（全文） | `GET /conversations/search?q=...` |
| `searchCases`（列表） | `GET /conversations` |
| `getCustomer` | `GET /contacts/{id}` |
| `createCaseNote` | `POST /conversations/{id}/messages`，body 为 `{ content, message_type: "outgoing", private: true }` |
| `createEscalation` | `POST /conversations/{id}/assignments`（`{ team_id }`），随后追加一条私有备注 |

`searchCases` 的状态过滤与 Zendesk Adapter 一致：映射后在客户端完成。

## 幂等与失败即关闭的写入

两条写入路径（`createCaseNote`、`createEscalation`）都要求
`idempotencyKey`：

1. 每个键的首个结果在进程内缓存，重试时直接回放——不产生第二次
   HTTP 写入；
2. 键同时以 `X-Idempotency-Key` 请求头转发给上游。

未配置 `CHATWOOT_ESCALATION_TEAM_ID` 时，`createEscalation` 在**不发
任何 HTTP 请求**的情况下抛出 `ChatwootNotConfiguredError`。上游 `404`
映射为 `AdapterNotFoundError`（`NOT_FOUND`）；其他非 2xx 映射为
`ChatwootApiError`，只携带 HTTP 状态码——绝不携带请求头或请求体。

### 幂等边界（参考实现）

这是一个**参考 Adapter**。其幂等缓存是**进程内 `Map`**：只能在单个
进程的生命周期内去重，**重启即丢失**。它不是完整的生产级幂等方案。
跨重启的生产级幂等必须由上游系统提供（在 Chatwoot 支持
idempotency-key 的场景下由其去重——Adapter 始终转发
`X-Idempotency-Key` 请求头），或由 Adapter 前置的外部持久化存储 /
事务性 outbox 提供。

### 升级（Escalation）的部分失败与对账

一次升级包含两次外部写入：团队指派
（`POST /conversations/{id}/assignments`）和随后的私有备注。两个子
操作使用**不同的幂等键**——`{key}:assignment` 与 `{key}:note`——
因此重试绝不会重发已成功的那一段。

- 若**指派段失败**：不写入任何内容、不缓存任何记录，错误照常向上
  抛出。
- 若指派成功但**备注段失败**：升级结果以
  `status: "partial_success"` 返回并缓存，携带人工对账所需的全部
  信息：`assignment: { teamId, response }`（已完成的指派段及其上游
  响应）和 `noteError`（失败段的错误）。使用相同 `idempotencyKey`
  重试时**只补发备注段**——不会再调用指派接口；成功后缓存记录转为
  `status: "success"` 并清除 `noteError`。完全成功后的重复重试不
  产生任何 HTTP 调用。

### 绝不伪造客户

`Case` 必须对应真实客户。当会话没有 sender、sender 为空、或 sender
id 不是正整数时，映射失败即关闭：`getCase` / `searchCases` 抛出
`ChatwootCustomerIdUnavailableError`（`CUSTOMER_ID_UNAVAILABLE`），
绝不会产生 `cw_contact_0` 之类的占位 ID。

## 能力清单

`getCapabilities()` 只声明真正实现的能力，profile 为 `core`：

```json
{
  "implementationId": "osas-chatwoot-adapter",
  "profiles": [{ "name": "core", "capabilities": [
    "case.read", "customer.read", "evidence.read", "note.write", "escalation.write"
  ] }],
  "transports": ["http"],
  "executionModes": ["shadow"]
}
```

其余能力——`searchKnowledge`（本 Adapter 不覆盖 Chatwoot 知识库）、
Proposal、审批、审计、电商/SaaS 读取、`executeAction`——一律抛出
`AdapterCapabilityError`（`CAPABILITY_UNSUPPORTED`），且**不发任何
HTTP 请求**。清单一经声明即具约束力：API 会对需要未声明能力的操作
返回 `403 CAPABILITY_UNSUPPORTED`。

## 测试

`src/chatwoot-adapter.test.ts` 使用可注入的 mock `HttpClient`，记录
请求并回放预置响应——无需凭据、无需网络。断言覆盖请求构造
（method/URL/headers/body）、幂等回放（每个键恰好一次 HTTP 写入）、
错误映射（不泄漏令牌）以及会话/联系人 → Case/Customer 的映射。

```bash
pnpm --filter @osas/chatwoot-adapter build
pnpm --filter @osas/chatwoot-adapter typecheck
pnpm --filter @osas/chatwoot-adapter test
```
