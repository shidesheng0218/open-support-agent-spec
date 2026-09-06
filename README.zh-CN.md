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

### 运行时配置（Milestone 2）

所有配置均为环境变量——带注释的模板见 [.env.example](.env.example)。

- **认证**（`OSAS_AUTH_MODE`）：`demo`（默认；`x-osas-role` / `x-osas-actor-id` /
  `x-tenant-id` 请求头）或 `jwt`（通过 `OSAS_JWKS_URL` / `OSAS_JWT_ISSUER` /
  `OSAS_JWT_AUDIENCE` 验证 OIDC Bearer Token；租户与角色只取自验证后的 claims，
  `x-tenant-id` 被忽略）。在 `NODE_ENV=production` 下 demo 模式**启动即失败关闭**。
  外部 principal 永远无法持有 `execute` 权限；`system_executor` 仅限服务端内部。
- **存储**（`OSAS_STORAGE`）：`memory`（默认）或 `postgres`（需要 `DATABASE_URL`；
  数据库不可达时启动失败关闭）。PostgreSQL 用法：

  ```bash
  docker compose --profile postgres up -d db migrate   # 启动数据库并执行迁移
  pnpm db:migrate && pnpm db:seed                       # 或在宿主机上执行
  OSAS_STORAGE=postgres DATABASE_URL=postgres://osas:osas@localhost:5432/osas pnpm dev:api
  # 或全部走 compose：
  OSAS_STORAGE=postgres docker compose --profile postgres up --build
  ```

  `pnpm db:reset` 重建 schema（仅限开发环境；`NODE_ENV=production` 下拒绝执行）。
- **LLM**（`OSAS_LLM_PROVIDER`）：`mock`（默认，确定性、无网络）或
  `openai-compatible`（`OSAS_LLM_BASE_URL` / `OSAS_LLM_API_KEY` /
  `OSAS_LLM_MODEL_FAST` / `OSAS_LLM_MODEL_STANDARD`）。classify/extract 路由到
  fast 模型，reply/propose 路由到 standard 模型。未同时配置
  `OSAS_LLM_INPUT_USD_PER_MTOKEN` 与 `OSAS_LLM_OUTPUT_USD_PER_MTOKEN` 时，成本记为
  *unknown*（绝不伪造）。`OSAS_LLM_DAILY_BUDGET_USD` / `OSAS_LLM_CASE_BUDGET_USD`：
  达到 80% 写入 `budget_warning` 审计事件；达到上限后模型调用在触达 Provider
  之前被阻断。用量可通过 `GET /v1/usage` 查询（仅 policy_admin/auditor）。

### 运行时配置（Milestone 3）

- **执行模式**（`OSAS_EXECUTION_MODE`）：`shadow`（默认）是唯一支持的模式——
  Proposal 只做模拟，ShadowRun 记录"如果允许自动执行将执行什么"，最终结果由
  人工写入。`live` **拒绝启动**（`LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1`）；
  真实执行能力须经未来的 RFC 决定。
- **参考 Adapter**（未配置时失败即关闭；演示环境不需要）：Zendesk
  （`ZENDESK_BASE_URL`/`ZENDESK_SUBDOMAIN`、`ZENDESK_EMAIL`、
  `ZENDESK_API_TOKEN`、`ZENDESK_ESCALATION_GROUP_ID`）与只读 Shopify
  （`SHOPIFY_SHOP_DOMAIN`、`SHOPIFY_ADMIN_ACCESS_TOKEN`、可选
  `SHOPIFY_API_VERSION`）。详见
  [docs/zendesk-shopify-shadow.zh-CN.md](docs/zendesk-shopify-shadow.zh-CN.md)。

### 运行时配置（Milestone 4）

- **Conformance Mode**（`OSAS_CONFORMANCE_MODE=true` + `OSAS_CONFORMANCE_KEY`）：
  启用仅供测试的端点 `POST /v1/conformance/reset`、
  `POST /v1/conformance/fixtures/load`、`GET /v1/conformance/snapshot`
  （均要求 `X-OSAS-Conformance-Key` 头）。**严禁在生产环境启用**——
  `NODE_ENV=production` 时启动直接失败（fail closed），缺少 key 同样拒绝启动。
  CI 只在一次性的 Docker 测试环境中启用。详见
  [docs/conformance.zh-CN.md](docs/conformance.zh-CN.md)。

## 黑盒兼容性与评测（Milestone 4）

- **`pnpm osas:compat -- --target http://localhost:3001`** —— `@osas/compat-runner`，
  黑盒一致性 Runner：只通过 HTTP 与目标实现通信，校验服务发现
  （`/.well-known/osas`、specVersion、Capability Manifest）、工具与 Schema、
  策略模拟结果；当配置了 Conformance Key（`OSAS_CONFORMANCE_MODE=true` +
  `OSAS_CONFORMANCE_KEY`，或 `--conformance-key`）时运行状态型套件（策略版本
  状态机、幂等执行、权限与租户隔离、审计链完整性）。输出机器可读 JSON 报告，
  任何失败都会以非 0 退出码结束。
- **`pnpm eval:policy`** —— 完全离线，对 `evals/cases/` 中 120 条合成案例
  （30 退款、20 退货、15 补发、15 取消订单、20 普通咨询、20 安全边界）评测
  策略引擎。硬性门禁（进入 CI）：100% Schema 合法、100% 策略一致、0 次越权、
  0 次重复执行、0 次安全边界绕过。
- **`pnpm eval:model`** —— 接入真实 Provider 的端到端评测；仅当显式设置
  `OSAS_LLM_PROVIDER=openai-compatible` 及 base URL/模型时才运行（不进 CI，
  默认 mock 下不运行）。模型的语义准确率独立展示——自动执行门禁从不以模型
  "回答得像不像人"为准。

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
  zendesk-adapter/       @osas/zendesk-adapter  Zendesk 工单参考 Adapter（Milestone 3）
  shopify-adapter/       @osas/shopify-adapter  只读 Shopify 参考 Adapter（Milestone 3）
  ecommerce-shadow/      @osas/ecommerce-shadow Shadow Mode：ShadowRun、存储、执行模式
  mock-backend/          @osas/mock-backend     合成 fixtures + MockSupportAdapter
  store-postgres/        @osas/store-postgres   PostgreSQL 存储 + SQL 迁移（Milestone 2）
  mcp-server/            @osas/mcp-server       16 个工具定义 + stdio MCP 服务器
  compat-runner/         @osas/compat-runner    黑盒 HTTP 一致性 Runner（Milestone 4）
apps/
  api/                   @osas/api              Fastify 5 HTTP API（端口 3001）
  web/                   @osas/web              React 18 + Vite 控制台（端口 5173）
tests/
  compat/                @osas/compat-suite     Schema/兼容套件 + JSON 报告
  e2e/                   @osas/e2e              Playwright 冒烟（E2E=1）
evals/                   @osas/evals            120 条合成评测集 + eval:policy/eval:model
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
每次调用都会收到包含租户与调用主体（Principal）的 `ToolContext`。详见
[Adapter 开发指南](docs/adapter-guide.zh-CN.md)；`@osas/zendesk-adapter` 与
`@osas/shopify-adapter` 是完整的参考实现。

## 文档

- 规范：[docs/spec-v0.1.zh-CN.md](docs/spec-v0.1.zh-CN.md) · [English](docs/spec-v0.1.md)
- Adapter 开发指南：[docs/adapter-guide.zh-CN.md](docs/adapter-guide.zh-CN.md) · [English](docs/adapter-guide.md)
- Zendesk + Shopify Shadow Mode：[docs/zendesk-shopify-shadow.zh-CN.md](docs/zendesk-shopify-shadow.zh-CN.md) · [English](docs/zendesk-shopify-shadow.md)
- Conformance Mode（仅限测试）：[docs/conformance.zh-CN.md](docs/conformance.zh-CN.md) · [English](docs/conformance.md)
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
