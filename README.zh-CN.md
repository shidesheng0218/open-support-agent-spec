# Open Support Agent Spec（OSAS，开放客服 Agent 规范）

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Spec: v0.1 Draft](https://img.shields.io/badge/spec-v0.1%20Draft-orange.svg)](docs/spec-v0.1.zh-CN.md)
[![CI](https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml/badge.svg)](https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml)

[English](README.md)

OSAS 是一份**面向客服场景 AI Agent 的开放互操作规范**：它定义了 Agent 如何读取业务数据、
生成结构化建议、通过策略校验、执行或升级人工，并留下完整审计轨迹的统一契约 ——
不绑定任何特定模型、客服系统或电商平台。

> **当前状态：v0.1 草案（Draft）。** OSAS 是一份**正在积极演进中的开放规范草案**，
> **并非**已确立的行业标准，目前不提供任何稳定性承诺。在 v1.0 之前，接口、Schema 与
> 行为都可能发生变化。详见[状态与路线图](#状态与路线图)。

## 本仓库交付内容

- **规范文本** —— 规范性文档见 [`docs/spec-v0.1.zh-CN.md`](docs/spec-v0.1.zh-CN.md)
  （[English](docs/spec-v0.1.md)）；其机器可校验形式为 [`schemas/`](schemas/) 下的
  JSON Schema（draft 2020-12），具有最高权威性。
- **TypeScript 参考实现 Agent** —— 可运行的 monorepo，实现完整链路：
  模型网关、策略引擎、MCP 工具服务器、HTTP API 与 Web 控制台。
- **三个 Profile** —— `core`（工单、客户、证据、备注、升级），外加两个扩展 Profile：
  `ecommerce`（订单、物流、退款、补发）与 `saas`（订阅、发票、额度余额、额度发放、套餐变更）。
- **Schema 与兼容性测试套件** —— `@osas/compat-suite` 校验 Schema、状态机、策略矩阵、
  工具映射、幂等与对账，并输出机器可读报告。通过该套件是声明 OSAS Profile 兼容的
  必要条件（见 [GOVERNANCE.md](GOVERNANCE.md)）。

## 架构

```
                       ┌──────────────────────────────────────────────┐
                       │                  模型网关                     │
                       │   分层路由 · 输出上限 · 预算 ·                 │
                       │   注入检测 · 遥测                             │
                       └───────────────┬──────────────────────────────┘
                                       │
   大模型（任意 provider / mock）───────┘
        │
        ▼  工具调用（MCP，16 个工具）     ┌───────────────────┐
   ┌─────────┐   读取（工单、订单……）     │     策略引擎       │
   │  Agent  │──────────────────────────▶│  确定性求值（§4）   │
   └────┬────┘                            └─────────┬─────────┘
        │  写入 = 结构化 ActionProposal               │
        ▼                                           │
   ┌───────────┐   auto_execute        ┌────────────▼────────────┐
   │  建议存储  │──────────────────────▶│  通过 Adapter 执行       │
   └───────────┘──────────┐            │  （幂等键去重）          │
        │   require_approval           └────────────┬────────────┘
        │             ▼                             │
        │      ┌─────────────┐                      ▼
        │      │  人工审批 /  │               ┌────────────┐    ┌──────────────┐
        │      │  人工接管    │               │  Adapter   │───▶│ 后端系统      │
        │      └─────────────┘               │ (自带/mock)│    │（客服/电商/  │
        ▼                                    └─────┬──────┘    │   SaaS）     │
   ┌──────────────────────────────────────────────▼─────┐      └──────────────┘
   │  审计轨迹：每条建议、决策、执行、接管、模型调用        │
   │  → AuditEvent（可通过 API 查询）                     │
   └─────────────────────────────────────────────────────┘
```

模型绝不持有后端凭据。所有读写都经由 `SupportAdapter` 接口完成，调用方以携带明确权限的
`Principal` 身份发起；所有写入都是结构化的 `ActionProposal`，必须先通过确定性的策略
求值才能执行。

## 快速开始

环境要求：Node >= 20（推荐 Node 22）、pnpm 11、Docker（可选）。

### 本地运行（pnpm）

```bash
pnpm install && pnpm build
pnpm dev:api        # API 运行于 http://localhost:3001（SEED_DEMO 演示数据）
pnpm dev:web        # 控制台运行于 http://localhost:5173（代理 /v1 与 /health 到 :3001）
```

常用检查：

```bash
curl http://localhost:3001/health
pnpm typecheck      # 整个 workspace 的严格 TS 检查
pnpm test           # 构建 + 全部单元测试
pnpm test:compat    # Schema/兼容套件 → tests/compat/report/latest.json
```

### Docker 运行

```bash
docker compose up --build    # 或：pnpm docker:up
```

- 控制台：http://localhost:8080
- API：http://localhost:3001（`GET /health` → `{ status: "ok", ... }`）

Docker 构建上下文为**仓库根目录**（两个 Dockerfile 都复制整个 pnpm workspace）；
仓库刻意不提供 `.dockerignore`，以保持 workspace 目录结构完整。

## 三条演示路径

打开控制台（http://localhost:5173 或 http://localhost:8080），选择一个角色：

1. **开发者**（`/developer`）—— 浏览 16 个 MCP 工具定义（`/v1/meta/tools`）、
   查阅 JSON Schema（`/v1/schemas`），并在 playground 中用任意 Schema 校验任意
   JSON 载荷（`POST /v1/validate`）。
2. **客服坐席**（`/agent`）—— 处理审批队列（`/v1/approvals?status=pending`，
   支持带备注的批准/拒绝），认领并解决人工接管单（`/v1/handoffs`）。
3. **平台运营**（`/platform`）—— 查看审计轨迹（`/v1/audit`，按工单/建议过滤），
   查看机器可读的兼容性报告（`/v1/compat/report`）。

`/demo` 页面通过 `/v1/chat` 一键运行三个端到端脚本化场景：

1. **电商退款（自动执行）** —— 已验证身份客户，$25 退款低于 $50 自动阈值，证据新鲜
   → `auto_execute` → 执行完成，审计轨迹完整。
2. **SaaS 额度（人工审批）** —— `credit_apply` 超过自动阈值 → `pending_approval`
   → 出现在 `/agent` 队列 → 批准后自动执行。
3. **人工接管（被阻断）** —— 身份未验证或消息含注入（"ignore all previous
   instructions…"）→ 建议被阻断 + `/agent` 中可见 `HumanHandoff`。

## 统一执行流

所有 Agent 动作遵循同一条流水线：

```
读取可信业务数据 ─▶ 生成结构化建议 ─▶ 策略校验
 （经由 Adapter 工具）  （ActionProposal + 证据）  （确定性求值）
                                                │
                          ┌─────────────────────┤
                          ▼                     ▼
                       自动执行           人工审批 ─▶ 随后执行
                          │                     │
                          └──────────┬──────────┘
                                     ▼
                          回写结果（幂等）
                                     ▼
                       审计留痕 / 异常对账
              （每一步都产生 AuditEvent；结果不确定时进入
                reconciliation_required，绝不做盲目重试）
```

## 权限阶梯

| 权限 | 含义 | 可持有者 |
|---|---|---|
| `read` | 读取工单、客户、订单、知识库等 | model、human、system |
| `draft` | 创建备注、升级单与建议 | model、human、system |
| `request-approval` | 提交需审批后才能执行的建议 | model（上限）、human、system |
| `execute` | 对已批准/自动批准的建议执行后端写入 | 仅策略引擎 / API 后端 |

模型主体的权限**上限为 `request-approval`**。模型提交请求 `execute` 权限的建议属于
策略违规（`PERMISSION_OVERREACH`）：建议被置为 `policy_rejected`、创建人工接管单，
并产生 `permission_overreach_blocked` 审计事件。只有策略引擎 / API 后端可以把建议
推进到 `executing`。

## 仓库结构

```
schemas/                 权威 JSON Schema（draft 2020-12）+ manifest.json
packages/
  core/                  @osas/core             类型、枚举、状态机、detectInjection
  schema-validator/      @osas/schema-validator 基于 Ajv 的 schemas/ 加载与校验
  policy-engine/         @osas/policy-engine    TenantPolicy 求值、权限阶梯、执行编排
  model-gateway/         @osas/model-gateway    provider 接口、MockModelProvider、路由、预算
  adapter/               @osas/adapter          SupportAdapter 接口 + BYO Adapter 模板
  mock-backend/          @osas/mock-backend     合成 fixtures + MockSupportAdapter
  mcp-server/            @osas/mcp-server       16 个工具定义 + stdio MCP 服务器
apps/
  api/                   @osas/api              Fastify 5 HTTP API（端口 3001）
  web/                   @osas/web              React 18 + Vite 控制台（端口 5173）
tests/
  compat/                @osas/compat-suite     Schema/兼容套件 + JSON 报告
  e2e/                   @osas/e2e              Playwright 冒烟（E2E=1）
docs/  rfcs/  .github/workflows/  docker-compose.yml
```

## 使用 MCP 服务器

`@osas/mcp-server` 通过 stdio 将 Agent 全部能力暴露为 16 个 MCP 工具。客户端配置示例
（先执行 `pnpm build`）：

```json
{
  "mcpServers": {
    "osas": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"]
    }
  }
}
```

工具清单：

| Profile | 工具 |
|---|---|
| core | `osas_core_get_case`、`osas_core_search_cases`、`osas_core_get_customer`、`osas_core_search_knowledge`、`osas_core_create_case_note`、`osas_core_create_escalation`、`osas_core_create_action_proposal` |
| ecommerce | `osas_ecom_get_order`、`osas_ecom_list_orders`、`osas_ecom_get_shipment` |
| saas | `osas_saas_get_subscription`、`osas_saas_list_invoices`、`osas_saas_get_credit_balance`、`osas_saas_create_credit_request`、`osas_saas_create_cancellation_request`、`osas_saas_create_plan_change_request` |

写入类工具只会创建 `ActionProposal`（状态 `proposed`，权限 `request-approval`），
绝不直接执行。`executeAction` **永远不会**被注册为工具。

## 接入自有 Adapter

参考实现的后端是内存 Mock。对接真实系统（客服平台、电商、计费）时，实现
`@osas/adapter` 的 `SupportAdapter` 接口即可 —— 从
`packages/adapter/templates/byo-adapter.template.ts` 开始，每个方法都有 TODO 指引。
Adapter 抛出 `AdapterNotFoundError`（→ API 404）/ `AdapterPermissionError`（→ 403），
每次调用都会收到包含租户与调用主体（Principal）的 `ToolContext`。

## 文档

- 规范：[docs/spec-v0.1.zh-CN.md](docs/spec-v0.1.zh-CN.md) · [English](docs/spec-v0.1.md)
- 工程契约：[CONTRACTS.md](CONTRACTS.md)
- 贡献指南：[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) · [English](CONTRIBUTING.md)
- 治理：[GOVERNANCE.md](GOVERNANCE.md)
- 安全策略：[SECURITY.md](SECURITY.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- RFC：[rfcs/](rfcs/)（从 [0001-v0.1-core](rfcs/0001-v0.1-core.md) 开始）
- 变更日志：[CHANGELOG.md](CHANGELOG.md)

## 状态与路线图

OSAS v0.1 是**草案（Draft）**。通往 v1.0 的路径：

- [ ] 至少 **3 个独立实现**（本参考实现之外）通过某一 Profile 的兼容性套件。
- [ ] 全部规范性文档中英双语齐备，且保持同步更新。
- [ ] 无阻塞核心语义的未决 RFC；治理结构扩展为多方共治
      （见 [GOVERNANCE.md](GOVERNANCE.md)）。

在此之前，次版本之间可能出现不兼容变更；详见 [CHANGELOG.md](CHANGELOG.md) 与
[语义化版本策略](GOVERNANCE.md#versioning)。

## 许可证

Apache-2.0 —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
