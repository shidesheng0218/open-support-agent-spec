# Zendesk + Shopify Shadow Mode 指南

[English](zendesk-shopify-shadow.md)

v0.1.1 Milestone 3 提供了 OSAS 对接真实工单系统（Zendesk）与真实电商后端
（Shopify）并以 **Shadow Mode（影子模式）** 运行的参考集成模式：Agent 负责
提议与模拟，人工负责决策与执行。

## 什么是 Shadow Mode

`OSAS_EXECUTION_MODE=shadow | live`（默认 `shadow`）。

- **shadow** —— v0.1.1 唯一支持的模式。运行时只能：
  1. 创建 `ActionProposal`；
  2. 运行确定性的策略模拟（Policy Simulation）；
  3. 记录 `ShadowRun` —— "如果允许自动执行，将会执行什么"
     （`wouldAutoExecute`、`suggestedAction`）；
  4. 由人工写入最终处理结果（`accepted` / `rejected` / `modified`，
     可附评语与外部单据引用）。
- **live** —— 拒绝启动。以 `OSAS_EXECUTION_MODE=live` 启动会立即中止并报
  `LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1`。真实执行能力须经未来的 RFC 决定。

Shadow Mode 不变量（由代码 + 测试强制）：

- Shadow Mode 流程**绝不**把 Proposal 标记为 `executed`；对已有 ShadowRun
  的 Proposal 调用 `POST /v1/proposals/:id/execute` 会被拒绝（409）。
- 注入攻击、身份未验证/过期、证据过期、金额超限、重复请求这五类场景永远
  无法进入 `wouldAutoExecute: true` —— 该字段严格等于
  `policyDecision.decision === "auto_execute"`，任何 §4 的 block/审批理由
  都会使其为 false。
- 人工的接受/拒绝/修改都会写入 `shadow_run_reviewed` 审计事件
  （actorType 为 `human`）；创建时写入 `shadow_run_created`。
- 审计哈希链（`GET /v1/audit/verify`）覆盖以上全部事件。

## 组件

| 组件 | 包 | 职责 |
|---|---|---|
| Zendesk Adapter | `@osas/zendesk-adapter` | 工单 ↔ Case、请求人 ↔ Customer、内部备注、升级到指定组、证据捕获（工单/用户 ID + 控制台链接） |
| Shopify Adapter | `@osas/shopify-adapter` | **只读**：订单/履约 → OSAS Order/Shipment + Evidence；基于实时数据生成退款 Proposal 草稿 |
| Shadow 运行时 | `@osas/ecommerce-shadow` | `ShadowRun` 的生成/审核、存储、`OSAS_EXECUTION_MODE` 加载器 |
| API | `@osas/api` | `POST /v1/proposals/:id/shadow-run`、`POST /v1/shadow-runs/:id/review`、`GET /v1/shadow-runs` |
| 控制台 | `@osas/web` | Shadow 页面：待人工审核、Agent 建议、策略理由、证据链接、审计链校验——无任何 live execute UI |

## 配置

全部通过环境变量（见 `.env.example`）。两个 Adapter 在凭证缺失时**失败即
关闭**——抛出 `ZendeskNotConfiguredError` / `ShopifyNotConfiguredError`，
绝不伪造成功。

```bash
# Shadow Mode（默认；v0.1.1 中 "live" 会拒绝启动）
OSAS_EXECUTION_MODE=shadow

# Zendesk
ZENDESK_BASE_URL=https://acme.zendesk.com   # 或 ZENDESK_SUBDOMAIN=acme
ZENDESK_EMAIL=agent@acme.example
ZENDESK_API_TOKEN=...                        # 绝不打印日志、绝不写入审计
ZENDESK_ESCALATION_GROUP_ID=4242             # 默认人工升级组

# Shopify（只读）
SHOPIFY_SHOP_DOMAIN=acme.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=...               # Admin API Token（只读权限即可）
SHOPIFY_API_VERSION=2025-01                  # 可选，默认固定版本
```

演示用 Docker 环境保留 Mock Adapter，**不需要**任何 Zendesk/Shopify Token；
参考 Adapter 面向类 staging/生产部署及其 mock-HTTP 测试套件。

## 端到端流程

1. **接入。** `ZendeskAdapter.getCase()` 把工单映射为 OSAS Case；
   `getCustomer()` 把请求人映射为 Customer（身份保持 `unverified` ——
   Zendesk 登录不等于 OSAS 身份核验）。
2. **证据。** `captureTicketEvidence` / `captureUserEvidence` 把工单/用户
   存档为 Evidence，`source` 为 Zendesk ID + 控制台链接。
   `ShopifyAdapter.buildRefundProposalDraft(orderId)` 读取订单与履约，
   计算可退金额（总额减去已记录退款），并捕获订单/物流/退款资格证据。
3. **提议。** Agent 创建引用这些证据的退款 `ActionProposal`
   （沿用 `POST /v1/proposals`）。
4. **Shadow Run。** `POST /v1/proposals/:id/shadow-run` 运行 §4 策略模拟
   （纯函数——不改状态、不建审批、不建接管），存储包含 `policyDecision`、
   `wouldAutoExecute`、`suggestedAction` 的 `ShadowRun`，并审计
   `shadow_run_created`。
5. **人工审核。** 人工在 Zendesk/Shopify 中完成真实处理（或拒绝），然后
   调用 `POST /v1/shadow-runs/:id/review` 写入
   `{ outcome, humanComment?, externalReference? }`。已审核的 ShadowRun
   是终态（重复审核 → 409）。审核以审核人 actor id 记录
   `shadow_run_reviewed` 审计事件。
6. **监督。** 控制台 Shadow 页面列出待审核项，展示策略理由与原始证据
   链接，并显示审计链校验结果。

## 说明与限制

- Zendesk 写入（内部备注、升级）是幂等的：幂等键在进程内缓存，并以
  `X-Idempotency-Key` 头转发给上游。
- Shopify Adapter **没有退款写路径**：`executeAction` 永远抛出
  `CAPABILITY_UNSUPPORTED` 且不发任何 HTTP 请求。v0.1.1 刻意不提供真实
  退款执行；未来如需增加，必须经过独立 RFC。
- 工单无法得知客户地区：`ZendeskAdapter` 的 Customer.region 使用占位
  `"ZZ"`，身份始终为 `unverified` —— 要求已验证身份的策略会（正确地）
  阻止自动执行。
