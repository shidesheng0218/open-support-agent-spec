# Open Support Agent Spec（OSAS）v0.2 —— 草案

[English version](spec-v0.2.md)

**状态：** 草案（Draft）
**规范版本：** `0.2`（`SPEC_VERSION = "0.2"`）
**许可证：** Apache-2.0

本文档是 OSAS v0.2 的规范性文本。OSAS 是一份面向客服场景 AI Agent 的开放互操作规范。

> **权威性声明。** [`schemas/`](../schemas/) 目录下的 JSON Schema（JSON Schema
> draft 2020-12，清单见 `schemas/manifest.json`）是本文档所定义全部数据结构的
> 机器可校验权威形式。**当文字描述与 Schema 不一致时，以 Schema 为准。**
> 除非明确说明，所有对象均适用 `additionalProperties: false`。

> **草案声明。** 这是一份开放规范草案，并非已确立的行业标准。在 v1.0 之前可能发生
> 不兼容变更（见 [GOVERNANCE.md](../GOVERNANCE.md)）。

本文档中的关键词 **必须（MUST）**、**不得（MUST NOT）**、**应该（SHOULD）**、
**不应该（SHOULD NOT）**、**可以（MAY）** 按 RFC 2119 / RFC 8174 解释。

---

## 1. 范围与约定

OSAS 定义：(a) 客服工作的核心领域模型；(b) 按 Profile 划分的扩展对象；(c) 权限阶梯与
拦截一切写入的确定性策略求值算法；(d) 执行、幂等与对账规则；(e) 工具表面（MCP）与
模型网关契约；(f) 对实现的安全要求。

全局约定：

- **金额** 为 `{ currency: string, minorUnits: integer }`，其中 `currency` 是
  ISO 4217 三位大写字母代码。**不得**使用浮点数表示金额。
- **时间戳** 为 ISO 8601 字符串（`format: "date-time"`）。
- **ID** 为不透明字符串。实现**不得**对 ID 结构赋予语义。
- 所有持久化对象都有 `id: string`、`specVersion: "0.2"`（Schema 层 `const`）和
  `createdAt: date-time`；大多数还有 `updatedAt`。
- Profile：`Profile = "core" | "ecommerce" | "saas"`。

## 2. 核心领域模型

### 2.1 Case（工单）

客服工作的基本单元。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tenantId` | string | 是 | 所属租户 |
| `customerId` | string | 是 | 客户引用 |
| `profile` | Profile | 是 | 所属 Profile |
| `channel` | enum | 是 | `email` \| `chat` \| `phone` \| `social` \| `api` |
| `subject` | string | 是 | 简短主题 |
| `status` | CaseStatus | 是 | 见 §3.1 |
| `priority` | enum | 是 | `low` \| `normal` \| `high` \| `urgent` |
| `assigneeType` | enum | 是 | `agent` \| `human` \| `none` |
| `tags` | string[] | 是 | 自由标签 |
| `evidenceIds` | string[] | 是 | 关联证据 |
| `closedAt` | date-time | 否 | 关闭时间 |

### 2.2 Customer（客户）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tenantId` | string | 是 | 所属租户 |
| `displayName` | string | 是 | 显示名 |
| `email` | string | 否 | 联系邮箱（日志中须脱敏，§9） |
| `phone` | string | 否 | 联系电话（日志中须脱敏，§9） |
| `locale` | string | 否 | 偏好语言 |
| `region` | string | 是 | ISO 3166-1 alpha-2 地区码 |
| `identityVerification` | object | 是 | `{ status: "verified"\|"unverified"\|"expired", method?, verifiedAt?, expiresAt? }` |
| `tags` | string[] | 是 | 自由标签 |

### 2.3 Evidence（证据）

证据将建议锚定在可信业务数据上。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tenantId` | string | 是 | 所属租户 |
| `caseId` | string | 否 | 关联工单 |
| `kind` | enum | 是 | `order` \| `shipment` \| `subscription` \| `invoice` \| `knowledge` \| `conversation` \| `policy` \| `identity` \| `other` |
| `source` | object | 是 | `{ system, recordType, recordId, url? }` |
| `summary` | string | 是 | 人类可读摘要 |
| `data` | object | 是 | 结构化载荷 |
| `retrievedAt` | date-time | 是 | 证据获取时间 |
| `expiresAt` | date-time | 否 | 硬性过期时间 |

**金融类**动作（§2.4）的每条建议结论**必须**引用至少一条证据。新鲜度按 `expiresAt`
与策略的 `maxEvidenceAgeSeconds`（自 `retrievedAt` 起算）评估；见 §5 第 10 步。

### 2.4 ActionProposal（动作建议）

Agent 改变业务状态的**唯一**途径。建议是一条结构化、可审计的请求，必须先通过
策略求值（§5）才能执行。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tenantId` | string | 是 | 所属租户 |
| `caseId` | string | 是 | 关联工单 |
| `profile` | Profile | 是 | **必须**与 `actionType` 所属 Profile 一致（§2.5） |
| `actionType` | ActionType | 是 | 动作类型 |
| `reasonCode` | string | 是 | 原因码（与策略规则的 `reasonCodes` 匹配） |
| `params` | object | 是 | 动作特定参数 |
| `requestedPermission` | Permission | 是 | 请求的权限（§4） |
| `requestedBy` | object | 是 | `{ actorType: "model"\|"human"\|"system", actorId, model?: { provider, model } }` |
| `amount` | Money | 否 | 金融类 actionType 必填 |
| `evidenceIds` | string[] | 是 | 支撑证据（金融类动作 ≥1） |
| `idempotencyKey` | string | 是 | 执行去重键（§6） |
| `status` | ProposalStatus | 是 | 见 §3.2 |
| `policyDecision` | PolicyDecision | 否 | 最近一次求值结果（§5） |

### 2.5 动作类型与 Profile

| Profile | ActionType 取值 |
|---|---|
| core | `create_note`、`create_escalation` |
| ecommerce | `refund`、`return_request`、`reshipment`、`cancel_order` |
| saas | `credit_apply`、`subscription_cancel`、`plan_change` |

`profile` **必须**与 actionType 所属 Profile 一致（参考实现中以 `ACTION_TYPE_PROFILE`
映射表达）。不一致构成 `PROFILE_MISMATCH` 违规（§5 第 3 步），并在 Schema 层同样被拒绝。

**金融类 actionType**：`refund`、`reshipment`、`credit_apply`。这三类要求提供 `amount`
并引用至少一条证据。

### 2.6 Approval（审批）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tenantId` | string | 是 | 所属租户 |
| `proposalId` | string | 是 | 被审批的建议 |
| `status` | enum | 是 | `pending` \| `approved` \| `rejected` |
| `approverId` | string | 否 | 做出决定的人 |
| `comment` | string | 否 | 审批备注 |
| `policyVersion` | string | 是 | 发起审批时的策略版本 |
| `requestedAt` | date-time | 是 | 发起时间 |
| `decidedAt` | date-time | 否 | 决定时间 |

### 2.7 TenantPolicy 与 PolicyRule（租户策略与规则）

按租户求值的确定性规则手册。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tenantId` | string | 是 | 所属租户 |
| `version` | string | 是 | 语义化版本字符串；v0.1.1：标识策略生命周期中的不可变版本（§12.2） |
| `effectiveFrom` | date-time | 是 | 生效时间 |
| `duplicateWindowSeconds` | integer | 是 | 重复检测窗口（§5 第 6 步） |
| `maxEvidenceAgeSeconds` | integer | 是 | 自 `retrievedAt` 起算的证据最大年龄（§5 第 10 步） |
| `budget` | object | 否 | `{ dailyUsdCap?: number }` 模型预算提示 |
| `rules` | PolicyRule[] | 是 | 求值规则 |
| `defaultDecision` | const | 是 | 恒为 `"block"` —— 未匹配的动作一律阻断 |

`PolicyRule`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `actionType` | ActionType | 是 | 规则管辖的动作 |
| `reasonCodes` | string[] | 否 | `reasonCode` 允许列表；缺省 = 任意 |
| `decision` | enum | 是 | `auto_execute` \| `require_approval` \| `block` |
| `maxAmount` | Money | 否 | 自动执行金额上限（§5 第 7 步） |
| `requireVerifiedIdentity` | boolean | 否 | 要求已验证身份 |
| `identityMaxAgeSeconds` | integer | 否 | 身份验证最大年龄 |
| `allowedRegions` | string[] | 否 | 地区允许列表（缺省 = 全部允许） |
| `blockedRegions` | string[] | 否 | 地区禁止列表 |

### 2.8 AuditEvent（审计事件）

每个关键步骤都会产生一条只追加的审计事件。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tenantId` | string | 是 | 所属租户 |
| `caseId` / `proposalId` / `approvalId` | string | 否 | 关联引用 |
| `eventType` | AuditEventType | 是 | 见下 |
| `actorType` | enum | 是 | `model` \| `policy_engine` \| `human` \| `system` \| `adapter` |
| `actorId` | string | 是 | 动作主体 |
| `policyVersion` | string | 否 | 当时生效的策略版本 |
| `modelInfo` | object | 否 | `{ provider, model, tier, inputTokens, outputTokens, latencyMs, costUsd }` |
| `detail` | object | 是 | 事件特定载荷 |
| `sequence` | integer | 否 | v0.1.1：在租户审计哈希链中的位置（从 1 开始，§12.3） |
| `previousHash` | string | 否 | v0.1.1：链上前一事件的 `eventHash`（创世事件为 64 个 0） |
| `eventHash` | string | 否 | v0.1.1：对事件稳定 JSON（剔除 `eventHash` 自身）的 SHA-256 |

`AuditEventType` 取值：`proposal_created`、`proposal_validated`、
`proposal_validation_failed`、`policy_evaluated`、`approval_requested`、
`approval_decided`、`execution_started`、`execution_succeeded`、`execution_failed`、
`execution_uncertain`、`reconciliation_opened`、`reconciliation_resolved`、
`handoff_created`、`handoff_resolved`、`prompt_injection_blocked`、
`permission_overreach_blocked`、`budget_exceeded`、`model_call_recorded`，
以及（v0.1.1）`policy_draft_created`、`policy_simulated`、`policy_approved`、
`policy_activated`、`policy_retired`。

### 2.9 HumanHandoff（人工接管）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tenantId` | string | 是 | 所属租户 |
| `caseId` | string | 是 | 关联工单 |
| `proposalId` | string | 否 | 关联建议 |
| `reason` | HandoffReason | 是 | 见下 |
| `status` | enum | 是 | `open` \| `claimed` \| `resolved` |
| `assignedTo` | string | 否 | 认领人 |
| `notes` | string | 否 | 处理备注 |
| `resolvedAt` | date-time | 否 | 解决时间 |

`HandoffReason` 取值：`identity_unverified`、`insufficient_evidence`、
`duplicate_request`、`over_threshold`、`region_blocked`、`policy_conflict`、
`external_uncertain`、`prompt_injection_suspected`、`customer_requested`、`other`。

### 2.10 Profile 扩展对象

Schema 位于 `schemas/profiles/`。

**Order**（ecommerce）：`tenantId`、`customerId`、
`status: "pending"|"paid"|"fulfilled"|"shipped"|"delivered"|"refunded"|"cancelled"`、
`items: [{ sku, name, qty: integer, unitPrice: Money }]`、`total: Money`、`region`、
`createdAt`。

**Shipment**（ecommerce）：`tenantId`、`orderId`、`carrier`、`trackingNumber?`、
`status: "label_created"|"in_transit"|"out_for_delivery"|"delivered"|"exception"`、`eta?`。

**Subscription**（saas）：`tenantId`、`customerId`、`plan`、
`status: "trialing"|"active"|"past_due"|"cancelled"`、`mrr: Money`、`renewsAt`。

**Invoice**（saas）：`tenantId`、`customerId`、`subscriptionId?`、`amount: Money`、
`status: "open"|"paid"|"void"`、`issuedAt`、`dueAt?`。

**CreditBalance**（saas）：`tenantId`、`customerId`、`balance: Money`。

**KnowledgeArticle**（core）：`tenantId`、`title`、`body`、`tags: string[]`。

**CaseNote / Escalation**（core）：简单记录
`{ id, specVersion, tenantId, caseId, body|reason, createdAt }`。

## 3. 状态机

### 3.1 CaseStatus

取值：`open`、`pending_agent`、`pending_customer`、`resolved`、`closed`。

| From ↓ / To → | open | pending_agent | pending_customer | resolved | closed |
|---|---|---|---|---|---|
| open | — | ✓ | ✓ | — | ✓ |
| pending_agent | — | — | ✓ | ✓ | ✓ |
| pending_customer | — | ✓ | — | ✓ | ✓ |
| resolved | — | ✓ | — | — | ✓ |
| closed | — | — | — | — | — |

`closed` 为终态。实现**必须**拒绝任何未标记 ✓ 的迁移
（参考实现：`canTransitionCase` / `transitionCase`，非法迁移抛错）。

### 3.2 ProposalStatus

取值：`proposed`、`policy_rejected`、`pending_approval`、`approved`、`rejected`、
`executing`、`executed`、`failed`、`reconciliation_required`。

| From ↓ / To → | policy_rejected | pending_approval | approved | rejected | executing | executed | failed | reconciliation_required |
|---|---|---|---|---|---|---|---|---|
| proposed | ✓ | ✓ | ✓ | — | — | — | — | — |
| pending_approval | — | — | ✓ | ✓ | — | — | — | — |
| approved | — | — | — | — | ✓ | — | — | — |
| executing | — | — | — | — | — | ✓ | ✓ | ✓ |
| reconciliation_required | — | — | — | — | — | ✓ | ✓ | — |
| policy_rejected / rejected / executed / failed | — | — | — | — | — | — | — | — |

`policy_rejected`、`rejected`、`executed`、`failed` 为终态。被拒绝或失败的建议
**不得**原地重试 —— **禁止盲目重试**：新的尝试 = **携带新 `idempotencyKey` 的新建议**
（参考实现：`canTransitionProposal` / `transitionProposal`）。

## 4. 权限阶梯

`read < draft < request-approval < execute`（有序数组 `PERMISSIONS`；
`permissionAtLeast(a, b)` 用于比较）。

| 权限 | 授予能力 |
|---|---|
| `read` | 读取工单、客户、Profile 对象、知识库 |
| `draft` | 创建工单备注、升级单与动作建议 |
| `request-approval` | 提交须经审批才能执行的建议 |
| `execute` | 对后端执行建议 |

规范性规则：

1. **模型主体的权限上限为 `request-approval`。** 当建议的
   `requestedPermission: "execute"` 且 `requestedBy.actorType === "model"` 时构成
   策略违规：决策 `block`，原因 `PERMISSION_OVERREACH`，建议置为 `policy_rejected`，
   创建原因码为 `policy_conflict` 的 `HumanHandoff`，并产生
   `permission_overreach_blocked` 类型的 `AuditEvent`。
2. **只有策略引擎 / API 后端**可以把建议推进到 `executing`，且只能在
   `auto_execute` 决策或人工批准之后。
3. **模型绝不持有后端凭据。** 所有读写都经由 Adapter 完成，并携带 `Principal`：
   `Permission = "read"|"draft"|"request-approval"|"execute"`；
   `Principal = { actorType: "model"|"human"|"system", actorId: string, permission: Permission }`；
   每次 Adapter 调用都携带 `ToolContext = { tenantId, principal }`。

## 5. 策略求值算法（确定性）

```
evaluateProposal(proposal, ctx: {
  customer: Customer,
  evidence: Evidence[],
  policy: TenantPolicy,
  recentProposals: ActionProposal[],
  injectionSuspected: boolean
}) → PolicyDecision

PolicyDecision = {
  decision: "auto_execute" | "require_approval" | "block",
  reasons: [{ code: string, message: string }],
  policyVersion: string,
  evaluatedAt: date-time
}
```

算法收集**全部**适用原因；最终决策取最严重者：
`block` > `require_approval` > `auto_execute`。按序执行以下步骤：

1. **`PERMISSION_OVERREACH`** —— 模型主体请求 `execute`（§4）→ 阻断。
2. **`PROMPT_INJECTION_SUSPECTED`** —— `ctx.injectionSuspected` 为真 → 阻断，
   并创建人工接管（`prompt_injection_suspected`）、产生 `prompt_injection_blocked`
   事件。
3. **`PROFILE_MISMATCH`** —— actionType 不属于 `proposal.profile` → 阻断
   （Schema 层同样拒绝）。
4. **`NO_RULE`** —— 无规则匹配 `actionType` → 阻断（默认决策为 `block`）。
5. **`REASON_CODE_NOT_ALLOWED`** —— 命中的规则有 `reasonCodes` 列表且建议的
   `reasonCode` 不在其中 → 阻断。
6. **`DUPLICATE_REQUEST`** —— 存在另一条具有相同 `tenantId` + `caseId` +
   `actionType` 且 `params` 深度相等的建议，创建于 `duplicateWindowSeconds` 之内，
   状态为 `executing` / `executed` / `pending_approval` / `approved`
   → 阻断 + 人工接管（`duplicate_request`）。
7. **`OVER_THRESHOLD`** —— 存在 `amount`、规则有 `maxAmount` 且金额超出（同币种）
   → 升级为 `require_approval`。金额与上限**币种不一致**时，以原因
   `CURRENCY_MISMATCH` 升级为 `require_approval`。
8. **`IDENTITY_REQUIRED` / `IDENTITY_UNVERIFIED`** —— 规则要求
   `requireVerifiedIdentity` 而客户身份不是 `verified`，或验证时间早于
   `identityMaxAgeSeconds` → 阻断 + 人工接管（`identity_unverified`）。
9. **`REGION_BLOCKED`** —— `customer.region` ∈ 规则 `blockedRegions`
   → 阻断 + 人工接管（`region_blocked`）。**`REGION_UNLISTED`** —— 规则有
   `allowedRegions` 且 region ∉ 列表 → `require_approval`。
10. **`INSUFFICIENT_EVIDENCE`** —— 金融类 actionType 无 `evidenceIds` → 阻断 +
    人工接管（`insufficient_evidence`）。**`EVIDENCE_STALE`** —— 任一引用证据已过期
    （`expiresAt` < 当前时间）或自 `retrievedAt` 起超过 `maxEvidenceAgeSeconds`
    → `require_approval`。
11. 否则采用命中规则的 `decision`（`auto_execute` 或 `require_approval`）。

副作用（由引擎或 API 层执行）：

- `block` → 建议变为 `policy_rejected`，并按上述位置创建人工接管。
- `require_approval` → 建议变为 `pending_approval`；创建 `Approval`
  （`status: "pending"`，携带 `policyVersion`）；产生 `approval_requested` 事件。
- `auto_execute` → 建议变为 `approved`，可进入执行（§6）。

每次求值**必须**产生携带 `policyVersion` 的 `policy_evaluated` 审计事件。

## 6. 执行、幂等与对账

`ExecutionResult = { status: "succeeded"|"failed"|"uncertain", externalRef?: string, detail?: string }`。

规则：

1. 执行以 `(tenantId, idempotencyKey)` 为键存入 **ExecutionStore**。以相同键重放的
   请求**必须**返回已存储的结果并标记 `replayed: true`，且**不得**产生任何副作用
   （不得重复退款、不得重复关单）。
2. `executeProposal(proposal, adapter, store)` 要求状态为 `approved`。它把建议推进到
   `executing`（产生 `execution_started`），然后调用 `adapter.executeAction`：
   - `succeeded` → `executed` + `execution_succeeded`；存储结果。
   - `failed` → `failed` + `execution_failed`；存储结果。
   - `uncertain`（如超时、后端结果未知）→ `reconciliation_required` +
     `execution_uncertain` + `reconciliation_opened` +
     `HumanHandoff(external_uncertain)`。**绝不自动重试。**
3. `reconcile(proposalId, outcome)` 仅允许从 `reconciliation_required` 发起，把建议
   推进到 `executed` 或 `failed`，并产生 `reconciliation_resolved`。对账是人工驱动
   的恢复路径，不是自动重试。

## 7. 工具 Profile（MCP）

Agent 只能通过 20 个 MCP 工具与后端交互。每个工具的输入 Schema 位于
`schemas/tools/<tool_name>.json`；工具元数据为纯数据导出
`TOOL_DEFINITIONS: ToolDefinition[]`，其中
`ToolDefinition = { name, profile, description, inputSchema, adapterMethod, permissionRequired }`。

| # | 工具 | Profile | Adapter 方法 |
|---|---|---|---|
| 1 | `osas_core_get_case` | core | `getCase` |
| 2 | `osas_core_search_cases` | core | `searchCases` |
| 3 | `osas_core_get_customer` | core | `getCustomer` |
| 4 | `osas_core_search_knowledge` | core | `searchKnowledge` |
| 5 | `osas_core_create_case_note` | core | `createCaseNote` |
| 6 | `osas_core_create_escalation` | core | `createEscalation` |
| 7 | `osas_core_create_action_proposal` | core | `createActionProposal` |
| 8 | `osas_ecom_get_order` | ecommerce | `getOrder` |
| 9 | `osas_ecom_list_orders` | ecommerce | `listOrders` |
| 10 | `osas_ecom_get_shipment` | ecommerce | `getShipment` |
| 11 | `osas_saas_get_subscription` | saas | `getSubscription` |
| 12 | `osas_saas_list_invoices` | saas | `listInvoices` |
| 13 | `osas_saas_get_credit_balance` | saas | `getCreditBalance` |
| 14 | `osas_saas_create_credit_request` | saas | `createActionProposal` |
| 15 | `osas_saas_create_cancellation_request` | saas | `createActionProposal` |
| 16 | `osas_saas_create_plan_change_request` | saas | `createActionProposal` |

规范性规则：

- 三个 `*_request` SaaS 工具（以及基于相同路径构建的电商退款/退货快捷工具）通过
  `createActionProposal` 构造状态为 `proposed`、`requestedPermission` 为
  `request-approval` 的 `ActionProposal`；它们**绝不执行**。
- `executeAction` **绝不**注册为 MCP 工具。执行只能发生在策略求值之后，由策略引擎 /
  API 触发（§5、§6）。
- `TOOL_DEFINITIONS`、Adapter 方法与 `schemas/tools/*.json` 的一一映射由兼容性套件
  强制校验。
- 工具输出为 `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }`。
- Adapter 错误映射为 `AdapterNotFoundError`（→ API 404）与
  `AdapterPermissionError`（→ API 403）。

## 8. 模型网关

网关把 Agent 与 provider 细节隔离，并强制执行成本与输出限制。

```ts
type ModelTier = "classify" | "standard" | "reasoning";
type ModelTask = "classify" | "extract" | "reply" | "propose";

interface ModelRequest {
  tier: ModelTier; task: ModelTask;
  messages: { role: "system"|"user"|"assistant"; content: string }[];
  outputSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}
interface ModelTelemetry {
  provider: string; model: string; tier: ModelTier; task: ModelTask;
  inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number;
  truncated: boolean;
}
interface ModelResponse { text: string; parsed?: unknown; telemetry: ModelTelemetry }
interface ModelProvider {
  name: string;
  supports(tier: ModelTier): boolean;
  complete(req: ModelRequest): Promise<ModelResponse>;
}
```

规范性要求：

1. **按任务的输出上限**（由网关强制执行；触发时设置 `truncated`）：
   `classify` 256、`extract` 512、`reply` 1024、`propose` 1024 tokens。
2. **路由**：每个 tier 路由到配置的 provider；provider 未知或失败时，网关降级到下一个
   支持该 tier 的 provider。
3. **预算**：累计 `costUsd`；超出配置上限时抛出 `BudgetExceededError` 并产生
   `budget_exceeded` 审计事件（经由遥测钩子）。
4. **遥测**：每次模型调用都以完整 `ModelTelemetry` 结构记录
   （`model_call_recorded`）；遥测同时以 `modelInfo` 嵌入审计事件。
5. **注入筛查**：网关输入使用共享的 `detectInjection(text)` 函数筛查（§9）；可疑输入
   在遥测上标记 `rejectedInjection`，并作为 `injectionSuspected` 传入策略求值
   （§5 第 2 步）。

参考实现 `MockModelProvider`（`name = "mock-local"`）是确定性的（相同输入 → 相同输出；
伪 token/延迟由字符串哈希导出）、不使用网络、成本近似为零，是默认 provider
（`MODEL_PROVIDER=mock`）。

## 9. 安全要求

符合本规范的实现**必须**：

1. **模型层不持有任何凭据。** 模型绝不获得后端凭据；所有后端访问都经由 Adapter 并
   携带显式 `Principal`（§4）。
2. **防御提示注入。** 所有不可信文本（客户消息、知识库文章、工具输出）都使用共享
   注入检测进行筛查 —— 至少包括以下大小写不敏感模式：
   "ignore (all|previous|above) instructions"、"system prompt"、"you are now"、
   "do anything now"、"无视(之前|以上|所有)指令"、"立即执行退款"。可疑输入按 §5 第 2 步
   阻断建议并产生 `prompt_injection_blocked`。
3. **日志脱敏 PII。** 日志管道**必须**至少脱敏 `req.headers.authorization`、
   `*.email`、`*.phone` 以及自由文本正文。除经由配置的 Adapter 外，客户数据**不得**
   离开进程。
4. **禁止盲目重试。** 终态建议绝不重新执行；新的尝试需要携带新 `idempotencyKey` 的
   新建议（§3.2、§6）。`uncertain` 结果进入对账，绝不自动重试。
5. **先校验后行动。** Schema 校验失败的建议**必须**被拒绝（API：`422 SCHEMA_INVALID`），
   且**不得**执行。
6. **默认拒绝。** 策略默认决策为 `block`；未被匹配规则显式允许的一切都被阻断
   （§5 第 4 步）。

## 10. 版本管理

- `specVersion: "0.2"` 是每个持久化对象上的 Schema 级常量。
- OSAS 对规范、Schema 与参考实现包采用同步的语义化版本管理
  （见 [GOVERNANCE.md](../GOVERNANCE.md)）。
- 在 v0.x 期间任何变更都可能不兼容；破坏性变更与新语义一律需要 RFC
  （见 [rfcs/](../rfcs/)）。

## 11. 一致性（Conformance）

实现只有在通过对应 Profile 的兼容性套件（`@osas/compat-suite`）后，才能声明该
Profile（`core`、`ecommerce`、`saas`）的**兼容性**。套件校验：Schema 有效/无效样例
校验、跨 Profile 的 actionType 规则、工具定义 ↔ Adapter 方法 ↔ 输入 Schema 的一一
映射、状态机合法性表、策略求值矩阵、幂等与对账行为。套件输出机器可读报告
（`{ specVersion, runAt, suites: [{ name, passed, failed, cases: [...] }], ok: boolean }`）。

## 12. v0.1.1 扩展（向后兼容）

v0.1.1 新增能力声明、策略版本生命周期与审计完整性。所有新增均为向后兼容扩展，
对 0.1.1 之前的实现为可选；这些扩展在 0.1.x 线上引入（`specVersion` 为
`"0.1"`），在当前 0.2.x 线上携带 `specVersion` `"0.2"`。

### 12.1 能力清单（Capability Manifest）

实现**可以**发布 `CapabilityManifest`（`schemas/core/capability-manifest.json`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `specVersion` | const | 是 | `"0.2"` |
| `implementationId` | string | 是 | 稳定的实现标识 |
| `implementationVersion` | string | 是 | 实现版本号 |
| `profiles` | array | 是 | `{ name: core\|ecommerce\|saas, capabilities: Capability[] }` |
| `transports` | array | 是 | `http`、`mcp` 的子集 |
| `executionModes` | array | 是 | `proposal_only`、`shadow`、`live` 的子集 |
| `adapterVersion` | string | 是 | Adapter 契约版本 |

规范定义的 16 种能力：`case.read`、`customer.read`、`knowledge.read`、
`evidence.read`、`note.write`、`escalation.write`、`proposal.write`、
`approval.read`、`approval.decide`、`audit.read`、`ecommerce.order.read`、
`ecommerce.shipment.read`、`ecommerce.refund.propose`、
`ecommerce.refund.execute`、`saas.subscription.read`、`saas.credit.propose`。

Adapter 通过可选的 `getCapabilities` 方法暴露能力清单。一旦声明即生效：
任何所需能力未被声明的 MCP 工具调用或 HTTP 操作**必须**以
`CAPABILITY_UNSUPPORTED` 失败（HTTP 403 / MCP 工具错误）。未提供能力清单的
Adapter 保持宽松行为（向后兼容）。

发现端点：`GET /.well-known/osas`（发现文档）与 `GET /v1/capabilities`
（能力清单；未声明时返回 404 `CAPABILITIES_NOT_DECLARED`）。

### 12.2 策略版本生命周期

线上生效的策略**不得**被原地覆盖。策略变更通过不可变版本进行，生命周期为
`draft → simulated → approved → active → retired`：

- 创建草稿会保留所有历史版本；版本号在租户内唯一。
- **模拟**（`POST /v1/policies/:tenantId/simulate`）用指定版本对提案求值，
  只返回决策与理由；不产生 Approval、Execution、Handoff 或业务写入；
  `draft → simulated` 的状态迁移本身会写入审计。
- **激活**记录操作者、时间、旧版本与新版本；激活新版本会自动退休旧的
  生效版本。
- 仅 `policy_admin` 角色可创建、模拟、批准、激活或退休策略版本
  （demo 模式：`x-osas-role: policy_admin` 请求头；角色来源是单一接缝，
  Milestone 2 将切换为 JWT 声明）。
- 每次策略变更都会写入审计事件（`policy_draft_created`、
  `policy_simulated`、`policy_approved`、`policy_activated`、
  `policy_retired`）。
- `defaultDecision: "block"` 语义保持不变。
- `PUT /v1/policies/:tenantId` 现在以 409 `POLICY_IMMUTABLE` 失败。

生命周期 API：`GET /v1/policies/:tenantId/versions`、
`POST /v1/policies/:tenantId/drafts`、`POST /v1/policies/:tenantId/simulate`、
`POST /v1/policies/:tenantId/versions/:version/approve|activate|retire`。

### 12.3 审计完整性（哈希链）

审计事件**可以**携带哈希链扩展字段 `sequence`、`previousHash`、`eventHash`。
每个租户的审计流构成只追加的链：`sequence` 从 1 开始连续编号，
`previousHash` 链接前一事件的 `eventHash`（创世为 64 个 0），`eventHash`
是对事件稳定（键排序）JSON 序列化（剔除 `eventHash` 自身）的 SHA-256。

`GET /v1/audit/verify` 重算整条链并返回
`{ tenantId, chainLength, intact, firstError? }`，其中 `firstError` 标出首个
被破坏的事件及预期/实际哈希。

这是篡改**检测**能力而非防篡改存储：它能发现修改、删除与乱序，但能整体重写
审计流的攻击者可以重算整条链——它不能替代 WORM 存储。该机制不会把客户敏感
内容纳入日志原文输出，既有日志脱敏规则（email、phone、Authorization）不变。

### 12.4 一致性新增检查

兼容性套件新增检查：能力清单 Schema 有效性、参考实现清单声明全部 16 种能力、
工具→能力映射、只读清单的合法声明、策略版本不可变性与生命周期合法性、
以及审计哈希链篡改检测与跨租户隔离。

## 13. v0.1.1 Milestone 2 —— 运行时基础（向后兼容）

Milestone 2 补齐真实运行所需的基础：认证、持久化存储与 LLM Provider /
成本控制。所有新增均为向后兼容扩展（在 0.1.x 线上引入，当时 `specVersion`
为 `"0.1"`）。

### 13.1 认证与租户隔离

启动时通过 `OSAS_AUTH_MODE=demo | jwt` 选择认证模式：

- **demo**（默认）：基于请求头的演示身份（`x-osas-role`、
  `x-osas-actor-id`、`x-tenant-id`），仅用于本地开发与演示。当
  `NODE_ENV=production` 时 demo 模式**禁止启动**——启动即失败关闭并报
  明确错误。
- **jwt**：通过 JWKS 端点验证 OIDC Bearer Token（`OSAS_JWKS_URL` /
  `OSAS_JWT_ISSUER` / `OSAS_JWT_AUDIENCE`）。已验证 principal 的 `sub`、
  `tenant_id`、`roles` 只取自验证后的 claims；`x-tenant-id` /
  `x-osas-role` 头被忽略。三项配置缺失任意一项即启动失败关闭。

角色为 `support_agent`、`policy_admin`、`auditor`、`system_executor`。
外部请求永远无法获得 `execute` 权限：`system_executor` 是服务端内部
principal，携带该角色的 Token 或请求头会被拒绝。租户隔离在路由层强制
执行——路径中的租户参数必须与 principal 的租户一致（403
`TENANT_MISMATCH`），因此一个租户的 JWT 无法读写另一租户的对象。

### 13.2 PostgreSQL 持久化

存储由 `OSAS_STORAGE=memory | postgres` 选择：

- **memory**（默认）：内存存储，无需外部服务。
- **postgres**：要求 `DATABASE_URL`；数据库不可达时启动失败关闭。迁移为
  纯 SQL，通过 `pnpm db:migrate` 执行（另有 `db:seed`、`db:reset`——reset
  在 `NODE_ENV=production` 下拒绝执行）。表覆盖 tenant、policy
  versions、proposals、approvals、evidence、audit events、execution
  records、shadow runs（语义在 Milestone 3 填充）与 model usage。

所有记录严格按租户隔离。执行台账的主键 `(tenant_id, idempotency_key)`
在数据库层面强制执行幂等；关键执行状态更新与其审计流写入在同一事务中
提交。所有 SQL 均为参数化查询，禁止字符串拼接。

### 13.3 LLM Provider 与成本控制

`OSAS_LLM_PROVIDER=mock | openai-compatible` 选择模型 Provider。mock
（默认）保持确定性与无网络依赖。`openai-compatible` 以纯 HTTP 对接任意
OpenAI 风格 `/chat/completions` 端点（`OSAS_LLM_BASE_URL` /
`OSAS_LLM_API_KEY` / `OSAS_LLM_MODEL_FAST` / `OSAS_LLM_MODEL_STANDARD`），
不绑定厂商 SDK。API key 仅从环境变量读取，绝不打印、写日志或进入审计
原文。

任务→档位路由固定：`classify`、`extract` 使用 fast 模型；`reply`、
`propose` 使用 standard 模型。调用方无法把任务引导到更贵的档位，网关也
不会静默切换到其他（尤其是更贵的）模型。高风险动作决策始终由策略引擎
作出——模型不参与。

成本纪律：

- 未同时配置价格（`OSAS_LLM_INPUT_USD_PER_MTOKEN` /
  `OSAS_LLM_OUTPUT_USD_PER_MTOKEN`）时，成本记为 **unknown**（token、
  provider、model 照常记录）——绝不伪造成本。
- 预算 `OSAS_LLM_DAILY_BUDGET_USD` 与 `OSAS_LLM_CASE_BUDGET_USD` 按已计量
  花费执行：达到上限 80% 时写入 `budget_warning` 审计事件；达到上限时，
  后续模型调用在**触达 Provider 之前**被阻断，并记录 `budget_exceeded`
  事件。
- Provider 失败、结构化输出失败或预算超限时，降级为人工接管或安全模板
  回复；绝不继续执行。
- 结构化输出优先使用 Provider 原生 JSON Schema 响应格式；端点不支持时
  最多重试一次，并用 OSAS Schema Validator 校验结果。

每次模型调用的遥测都会持久化（内存与 PostgreSQL 两路），并可通过仅
operator 可用的 `GET /v1/usage`（`policy_admin` 或 `auditor` 角色）按
tenant、日期、模型、任务筛选查询。`AuditModelInfo.costUsd` 现为可选
（缺省 = 成本未知）。

## 14. v0.1.1 Milestone 3 —— Shadow Mode 与参考 Adapter（向后兼容）

Milestone 3 新增 Shadow Mode 运行时与两个参考 Adapter（Zendesk 工单、
只读 Shopify 电商）。所有新增均为向后兼容扩展（在 0.1.x 线上引入，当时
`specVersion` 为 `"0.1"`）。

### 14.1 执行模式

`OSAS_EXECUTION_MODE=shadow | live`（默认 `shadow`）。

- **shadow**：运行时只能创建 Proposal、运行策略模拟、记录"如果允许自动
  执行将执行什么"（ShadowRun），并接受人工写入的最终处理结果。
- **live**：启动必须拒绝并输出明确错误
  `LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1`。真实执行能力须经未来的 RFC
  决定。

Shadow Mode 绝不把 Proposal 标记为 `executed`：执行端点会拒绝（409）任何
已有 ShadowRun 的 Proposal；一个通过策略的有效动作只会产生 Proposal +
ShadowRun —— 退款/取消订单的写路径绝不会被调用。

### 14.2 ShadowRun

新的核心对象（`schemas/core/shadow-run.json`），按租户存储（内存或
PostgreSQL `shadow_runs` 表）：

| 字段 | 含义 |
|---|---|
| `proposalId` | 被模拟的 Proposal |
| `policyDecision` | §4 确定性策略判定 |
| `wouldAutoExecute` | 严格等于 `policyDecision.decision === "auto_execute"` |
| `suggestedAction` | actionType/reasonCode/params/amount —— 仅记录，绝不执行 |
| `humanOutcome` | `accepted` \| `rejected` \| `modified` \| `pending` |
| `humanComment` / `externalReference` | 审核人评语与外部单据链接 |
| `createdAt` / `reviewedAt` | 生命周期时间戳 |

创建与每次人工接受/拒绝/修改都会写入审计（新增 AuditEvent 类型
`shadow_run_created`、`shadow_run_reviewed`，纳入哈希链）。已审核的
ShadowRun 为终态，重复审核返回 409。由于 `wouldAutoExecute` 派生自 §4
判定，注入攻击、身份未验证/过期、证据过期、金额超限、重复请求这五类
场景永远无法进入 `wouldAutoExecute: true`。

新增 API 端点：

- `POST /v1/proposals/:id/shadow-run` —— 模拟并记录（201）；Proposal
  保持不变。
- `POST /v1/shadow-runs/:id/review` —— `{ outcome, humanComment?,
  externalReference? }`，限 `support_agent` / `policy_admin` 角色。
- `GET /v1/shadow-runs`（及 `GET /v1/shadow-runs/:id`）—— 内嵌
  Proposal 与证据，供控制台展示。

控制台新增 Shadow 页面：待人工审核、Agent 建议动作、策略理由、原始证据
链接与审计链校验结果，刻意不提供任何 live execute UI。

### 14.3 Zendesk 参考 Adapter（`@osas/zendesk-adapter`）

工单 ↔ Case、请求人 ↔ Customer、内部备注（`comment.public = false`）、
人工升级（工单指派到配置的默认组）。证据 source 携带 Zendesk 工单/用户
ID 与坐席控制台 URL。所有写入使用幂等键（进程内回放缓存 +
`X-Idempotency-Key` 头）。端点、凭证与默认升级组通过环境变量配置
（`ZENDESK_BASE_URL` / `ZENDESK_SUBDOMAIN`、`ZENDESK_EMAIL`、
`ZENDESK_API_TOKEN`、`ZENDESK_ESCALATION_GROUP_ID`）；未配置凭证时失败即
关闭（`ZENDESK_NOT_CONFIGURED`），绝不伪造成功。

### 14.4 Shopify 参考 Adapter（`@osas/shopify-adapter`）

只读：订单、按客户查询订单、履约（→ Shipment 物流状态）。订单、物流与
退款资格转换为 OSAS Evidence（source = Shopify ID + admin URL）。
`buildRefundProposalDraft()` 基于实时数据为退款 Proposal 定价：可退金额
（总额减去已记录退款）、币种、订单状态与证据。**没有退款写路径**：
`executeAction` 永远抛出 `CAPABILITY_UNSUPPORTED` 且不发任何 HTTP 调用，
清单中也不声明 `ecommerce.refund.execute`。未来执行能力须独立 RFC 决定。
配置经由环境变量（`SHOPIFY_SHOP_DOMAIN`、`SHOPIFY_ADMIN_ACCESS_TOKEN`、
可选 `SHOPIFY_API_VERSION`）；凭证缺失时失败即关闭。

两个 Adapter 的所有第三方流量都经过可注入 HTTP 客户端，因此其测试套件
使用 mock HTTP 运行、无需任何外部凭证。演示 Docker 环境保留 Mock
Adapter，不需要 Zendesk/Shopify Token。

## 15. v0.2 Phase 4/5 —— 最小售后领域模型（向后兼容）

Phase 4/5 新增四个电商售后对象、一个新 ActionType（`exchange_request`）、
四个能力与四个 MCP 工具。全部为 `specVersion` `"0.2"` 上的向后兼容扩展。
本节内容不执行任何真实操作：售后对象只是记录与提案，`exchange_request`
永远由人工履约。

### 15.1 ShipmentIncident（`schemas/profiles/ecommerce/shipment-incident.json`）

在某个 Shipment 上检测到的物流异常。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | Id | 是 | |
| `specVersion` | const | 是 | `"0.2"` |
| `tenantId` | Id | 是 | |
| `orderId` | Id | 是 | 异常所属订单 |
| `shipmentId` | Id | 是 | 检测到异常的运单 |
| `incidentType` | enum | 是 | `delayed`、`lost`、`delivered_not_received`、`damaged_in_transit` |
| `carrier` | string | 否 | |
| `status` | enum | 是 | `open`、`investigating`、`resolved`、`closed` |
| `expectedAt` | DateTime | 否 | 与异常相关的预计送达时间 |
| `detectedAt` | DateTime | 是 | |
| `evidenceIds` | Id[] | 否 | |
| `createdAt` / `updatedAt` | DateTime | 是 | |

### 15.2 RefundTransaction（`schemas/profiles/ecommerce/refund-transaction.json`）

支付服务商侧一笔真实退款交易的记录。对模型只读：它反映执行结果，
绝不触发执行。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | Id | 是 | |
| `specVersion` | const | 是 | `"0.2"` |
| `tenantId` | Id | 是 | |
| `orderId` | Id | 是 | |
| `proposalId` | Id | 否 | 来源 ActionProposal（如已知） |
| `provider` | string | 否 | 支付服务商 |
| `externalTransactionId` | string | 否 | 服务商侧交易号 |
| `status` | enum | 是 | `requested`、`processing`、`succeeded`、`failed`、`reversed` |
| `amount` | Money | 是 | 整数最小货币单位，禁止浮点 |
| `requestedAt` | DateTime | 是 | |
| `completedAt` | DateTime | 否 | |
| `failureCode` | string | 否 | `failed` 时的服务商失败码 |
| `evidenceIds` | Id[] | 否 | |
| `createdAt` / `updatedAt` | DateTime | 是 | |

### 15.3 ItemClaim（`schemas/profiles/ecommerce/item-claim.json`）

按订单行的售后索赔。以 `submitted` 状态登记并由人工审核；模型永远不
批准、拒绝或了结索赔。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | Id | 是 | |
| `specVersion` | const | 是 | `"0.2"` |
| `tenantId` | Id | 是 | |
| `orderId` | Id | 是 | |
| `lineId` | Id | 是 | 索赔针对的订单行 |
| `claimType` | enum | 是 | `damaged`、`wrong_item`、`missing_item`、`defective` |
| `quantity` | integer | 是 | `>= 1` |
| `evidenceIds` | Id[] | 否 | |
| `status` | enum | 是 | `submitted`、`under_review`、`approved`、`rejected`、`resolved` |
| `createdAt` / `updatedAt` | DateTime | 是 | |

### 15.4 ExchangeRequest（`schemas/profiles/ecommerce/exchange-request.json`）

将某一订单行换货为替代 SKU 的请求。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | Id | 是 | |
| `specVersion` | const | 是 | `"0.2"` |
| `tenantId` | Id | 是 | |
| `orderId` | Id | 是 | |
| `originalLineId` | Id | 是 | 被换的订单行 |
| `replacementSku` | string | 是 | |
| `replacementVariant` | string | 否 | |
| `inventoryStatus` | enum | 否 | `unknown`、`in_stock`、`out_of_stock`、`backordered` |
| `priceDelta` | 类 Money | 否 | 替代价减原价；**可为负**；整数最小货币单位，禁止浮点 |
| `returnRequired` | boolean | 是 | 原商品是否需退回 |
| `status` | enum | 是 | `proposed`、`pending_approval`、`approved`、`rejected`、`fulfilled`、`cancelled` |
| `evidenceIds` | Id[] | 否 | |
| `createdAt` / `updatedAt` | DateTime | 是 | |

### 15.5 `exchange_request` ActionType

`exchange_request`（profile 为 `ecommerce`）加入 ActionType 注册表，并遵守
以下不可协商规则：

- **默认 `require_approval`。** 参考 demo 策略携带
  `{ actionType: "exchange_request", decision: "require_approval" }` 规则；
  无匹配规则时引擎失败即关闭（`NO_RULE` → `block`）。
- **模型永不执行。** `exchange_request` 位于
  `NEVER_AUTO_EXECUTE_ACTION_TYPES`（`@osas/core`）。即使租户规则写成
  `auto_execute`，`evaluateProposal` 也会把决定封顶在 `require_approval`
  （理由码 `NEVER_AUTO_EXECUTE`）；无论是否已批准，`executeProposal` 对它
  一律抛出 `NonExecutableActionError`（`ACTION_NOT_EXECUTABLE`）——不调用
  adapter、不改变状态。履约永远由人工在模型执行路径之外完成。
- **证据必需 / 人工接管。** 作为财务类动作，`exchange_request` 至少要求
  一条指向原订单的证据：缺证据即 `block`（`INSUFFICIENT_EVIDENCE`）。当
  库存状态、价差或原订单证据无法确定时，实现必须给出
  `capability_missing` / `require_approval` / 人工接管——绝不伪造成功。

### 15.6 新能力与工具

能力注册表新增四项（`ecommerce` profile）：

| 能力 | 工具 | permissionRequired | adapterMethod |
|---|---|---|---|
| `ecommerce.shipment_incident.read` | `osas_ecom_get_shipment_incident`（`{ id }`） | `read` | `getShipmentIncident` |
| `ecommerce.refund_status.read` | `osas_ecom_get_refund_status`（`{ orderId }`） | `read` | `getRefundStatus` |
| `ecommerce.item_claim.propose` | `osas_ecom_create_item_claim_request` | `draft` | `proposeItemClaim` |
| `ecommerce.exchange.propose` | `osas_ecom_create_exchange_request` | `request-approval` | `createActionProposal` |

`osas_ecom_create_item_claim_request` 以幂等方式登记一条
`ItemClaim`（`submitted`）交人工审核，从不了结任何事项。
`osas_ecom_create_exchange_request` 是提案快捷方式：仅起草
`exchange_request` ActionProposal（`proposed`、`request-approval`），
永不执行。三个新 adapter 方法在 `SupportAdapter` 上均为可选：未实现的
adapter 不得声明对应能力，相关调用以 `CAPABILITY_UNSUPPORTED` 失败而非
伪造结果。`TOOL_DEFINITIONS`、adapter 方法与 `schemas/tools/*.json` 的
1:1 映射由兼容套件强制（现为 20 个工具、20 个规范能力）。
