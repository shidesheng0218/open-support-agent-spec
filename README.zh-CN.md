# Open Support Agent Spec（OSAS，开放客服 Agent 规范）

<div align="center">
  <img src="docs/assets/osas-hero.svg" alt="OSAS：面向客服业务的可治理 AI Agent" width="100%" />

  <p><strong>面向客服业务的可治理、可互操作 AI Agent。</strong><br />
  一份 Schema 优先的统一契约：读取可信数据、生成结构化建议、执行策略门禁、<br />
  默认 Shadow Mode，并解释每一个结果。</p>

  <p>
    <a href="README.md">English</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="docs/spec-v0.2.zh-CN.md">阅读规范</a> ·
    <a href="CONTRIBUTING.zh-CN.md">参与贡献</a>
  </p>
</div>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2563EB?style=flat-square" alt="Apache 2.0 许可证" /></a>
  <a href="docs/spec-v0.2.zh-CN.md"><img src="https://img.shields.io/badge/spec-v0.2%20Draft-F59E0B?style=flat-square" alt="v0.2 草案" /></a>
  <a href="https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml"><img src="https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml/badge.svg" alt="CI 状态" /></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20 或更高" />
  <img src="https://img.shields.io/badge/pnpm-11-F69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm 11" />
</p>

> **当前状态：v0.2 草案（Draft）。** OSAS 是正在积极演进中的开放规范草案，**并非**
> 已确立的行业标准。在 v1.0 之前，接口、Schema 与行为都可能发生变化，详见
> [状态与路线图](#状态与路线图)。

## 为什么需要 OSAS？

生产级客服 Agent 不能只有“会回答”的模型，还需要一份把推理与权限分开、把模型输出
变成类型化建议，并让安全路径成为默认路径的统一契约。

| 难题 | OSAS 的回答 |
|---|---|
| 模型可能建议危险写入 | 模型权限上限是 `request-approval`，永远拿不到 `execute`。 |
| 每个客服/电商系统 API 都不同 | `SupportAdapter` 提供稳定、携带租户上下文的工具接口。 |
| “大概成功了”无法审计 | 建议、决策、模型调用、人工接管和写入都变成 `AuditEvent`。 |
| 直接上线风险高、难复现 | 默认 `shadow`；兼容性与策略门禁可确定、可离线复现。 |

## 一眼看懂

| 20 个 MCP 工具 | 3 个 Profile | 120 条策略 + 20 条售后案例 | 307 项兼容检查 |
|---|---|---|---|
| Core、电商、SaaS | Schema 驱动契约 | 离线安全评测 | HTTP 黑盒一致性 |

仓库同时提供规范文本、机器可校验 JSON Schema、TypeScript 参考实现、Web 控制台、参考
Adapter、兼容性套件与可复现的策略评测。

## 架构

```mermaid
flowchart LR
    M[大模型或 Mock Provider] --> G[模型网关<br/>路由 · 预算 · 注入检测]
    G --> T[MCP 工具面<br/>20 个类型化工具]
    T --> A[Support Adapter<br/>自定义 · Mock · Zendesk · Shopify]
    A --> B[(客服 / 电商 / SaaS 后端)]
    G --> P[确定性策略引擎]
    P -->|auto_execute| X[Shadow Run / 执行边界]
    P -->|pending_approval| H[人工审批或接管]
    H --> X
    X --> A
    G -. 每次调用 .-> E[(AuditEvent 审计轨迹)]
    P -. 每次决策 .-> E
    X -. 每个结果 .-> E

    classDef model fill:#312E81,stroke:#A78BFA,color:#fff
    classDef gate fill:#164E63,stroke:#67E8F9,color:#fff
    classDef adapter fill:#065F46,stroke:#6EE7B7,color:#fff
    classDef audit fill:#78350F,stroke:#FCD34D,color:#fff
    class M,G,T model
    class P,H,X gate
    class A,B adapter
    class E audit
```

模型绝不持有后端凭据。所有读写都经由 `SupportAdapter` 接口完成，调用方以携带明确权限的
`Principal` 身份发起；所有写入都是结构化的 `ActionProposal`，必须先通过确定性的策略
求值才能执行。

边界设计只有一句话：**模型负责提议，策略负责决策，Adapter 负责执行，审计负责解释**。

## 快速开始

从 clone 到看到一个带策略门禁的演示，大约只需要一分钟。环境要求：Node >= 20
（推荐 Node 22）、pnpm 11；想体验一键环境时再安装 Docker。

### 最快路径：Docker

```bash
git clone https://github.com/shidesheng0218/open-support-agent-spec.git
cd open-support-agent-spec
docker compose up --build
```

然后打开：

| 入口 | 地址 | 可以看什么 |
|---|---|---|
| Web 控制台 | [`localhost:8080`](http://localhost:8080) | `/demo`、`/developer`、`/agent`、`/platform` |
| API 健康检查 | [`localhost:3001/health`](http://localhost:3001/health) | 服务与规范状态 |
| 工具目录 | [`localhost:3001/v1/meta/tools`](http://localhost:3001/v1/meta/tools) | 20 个类型化 MCP 工具 |

<details>
<summary><strong>演示到底证明了什么？</strong></summary>

| 场景 | 策略结果 | 说明 |
|---|---|---|
| $25 电商退款 | `auto_execute` | 证据新鲜且符合租户策略，可以执行有边界的动作。 |
| 超阈值 SaaS 额度 | `pending_approval` | 风险更高的动作先停在人审门禁。 |
| 未验证身份或提示注入 | `policy_rejected` + 接管 | 不安全路径被阻断，并进入可见的人工处理流。 |

</details>

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
  `ZENDESK_API_TOKEN`、`ZENDESK_ESCALATION_GROUP_ID`）、只读 Shopify
  （`SHOPIFY_SHOP_DOMAIN`、`SHOPIFY_ADMIN_ACCESS_TOKEN`、可选
  `SHOPIFY_API_VERSION`）与 Chatwoot（`CHATWOOT_BASE_URL`、
  `CHATWOOT_ACCOUNT_ID`、`CHATWOOT_API_TOKEN`、可选
  `CHATWOOT_ESCALATION_TEAM_ID`）。详见
  [docs/zendesk-shopify-shadow.zh-CN.md](docs/zendesk-shopify-shadow.zh-CN.md)
  与 [docs/chatwoot-adapter.zh-CN.md](docs/chatwoot-adapter.zh-CN.md)。

### 运行时配置（Milestone 4）

- **Conformance Mode**（`OSAS_CONFORMANCE_MODE=true` + `OSAS_CONFORMANCE_KEY`）：
  启用仅供测试的端点 `POST /v1/conformance/reset`、
  `POST /v1/conformance/fixtures/load`、`GET /v1/conformance/snapshot`
  （均要求 `X-OSAS-Conformance-Key` 头）。**严禁在生产环境启用**——
  `NODE_ENV=production` 时启动直接失败（fail closed），缺少 key 同样拒绝启动。
  CI 只在一次性的 Docker 测试环境中启用。详见
  [docs/conformance.zh-CN.md](docs/conformance.zh-CN.md)。

## 黑盒兼容性与评测（Milestone 4）

OSAS 把安全当作发布属性，而不是 README 里的口号：

```mermaid
flowchart TB
    C[干净 checkout] --> I[pnpm install --frozen-lockfile]
    I --> B[pnpm build]
    B --> T[pnpm test]
    T --> TC[pnpm typecheck]
    TC --> E[pnpm eval:policy]
    E --> K{所有门禁通过？}
    K -->|是| D[Docker 一致性 + Playwright E2E]
    K -->|否| S[在集成前停止]
    D --> R[输出机器可读报告]

    classDef good fill:#065F46,stroke:#6EE7B7,color:#fff
    classDef stop fill:#7F1D1D,stroke:#FCA5A5,color:#fff
    class B,T,TC,E,D,R good
    class S stop
```

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

1. **开发者**（`/developer`）—— 浏览 20 个 MCP 工具定义（`/v1/meta/tools`）、
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

```mermaid
flowchart LR
    A[读取可信数据<br/>经由 Adapter 工具] --> B[生成 ActionProposal<br/>附带证据]
    B --> C{确定性策略求值}
    C -->|auto_execute| D[Shadow Run / 执行边界]
    C -->|pending_approval| H[人工审批]
    C -->|blocked| X[人工接管]
    H --> D
    D --> W[幂等回写]
    W --> E[AuditEvent + 异常对账]
    X --> E

    classDef input fill:#312E81,stroke:#A78BFA,color:#fff
    classDef gate fill:#164E63,stroke:#67E8F9,color:#fff
    classDef outcome fill:#065F46,stroke:#6EE7B7,color:#fff
    classDef blocked fill:#7F1D1D,stroke:#FCA5A5,color:#fff
    class A,B input
    class C,H gate
    class D,W,E outcome
    class X blocked
```

不确定结果会进入 `reconciliation_required`；参考实现不会对结果未知的写入做盲目重试。

## 安全边界一览

| 边界 | 默认行为 |
|---|---|
| 模型权限 | `read` → `draft` → `request-approval`，永远不能 `execute` |
| 执行模式 | v0.2 只有 `shadow`；`live` 模式拒绝启动 |
| 凭据 | 后端密钥留在 Adapter 之后，不进入模型上下文 |
| 提示注入 | 检测、阻断、人工接管并写入审计 |
| 成本控制 | 达到每日/单 case 上限时，在调用 Provider 前阻断 |
| 一致性端点 | 仅测试用途、需要 key，生产环境拒绝启动 |

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
  chatwoot-adapter/      @osas/chatwoot-adapter Chatwoot（开源客服平台）参考 Adapter
  ecommerce-shadow/      @osas/ecommerce-shadow Shadow Mode：ShadowRun、存储、执行模式
  mock-backend/          @osas/mock-backend     合成 fixtures + MockSupportAdapter
  store-postgres/        @osas/store-postgres   PostgreSQL 存储 + SQL 迁移（Milestone 2）
  mcp-server/            @osas/mcp-server       20 个工具定义 + stdio MCP 服务器
  compat-runner/         @osas/compat-runner    黑盒 HTTP 一致性 Runner（Milestone 4）
apps/
  api/                   @osas/api              Fastify 5 HTTP API（端口 3001）
  web/                   @osas/web              React 18 + Vite 控制台（端口 5173）
tests/
  compat/                @osas/compat-suite     Schema/兼容套件 + JSON 报告
  e2e/                   @osas/e2e              Playwright 冒烟（E2E=1）
evals/                   @osas/evals            120 条合成评测集 + eval:policy/eval:model
examples/                embed-policy-engine    @osas/policy-engine 最小独立嵌入示例
docs/  rfcs/  .github/workflows/  docker-compose.yml
```

## 使用 MCP 服务器

`@osas/mcp-server` 通过 stdio 将 Agent 全部能力暴露为 20 个 MCP 工具。客户端配置示例
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
[Adapter 开发指南](docs/adapter-guide.zh-CN.md)；`@osas/zendesk-adapter`、
`@osas/shopify-adapter` 与 `@osas/chatwoot-adapter` 是完整的参考实现。关于发布策略：
仅 `@osas/core`、`@osas/schema-validator`、`@osas/policy-engine` 发布到 npm；
各 Adapter 及其余 workspace 包均为 private 参考实现 —— 无法通过 npm 安装
（例如 `npm install @osas/chatwoot-adapter` 不可行），请从仓库源码构建或复制改造。
如果只想在
既有系统中引入治理层，可直接嵌入 `@osas/policy-engine` —— 见
[包 README](packages/policy-engine/README.zh-CN.md) 与可运行示例
[examples/embed-policy-engine](examples/embed-policy-engine)。

## 文档

- 规范：[docs/spec-v0.2.zh-CN.md](docs/spec-v0.2.zh-CN.md) · [English](docs/spec-v0.2.md)
- Adapter 开发指南：[docs/adapter-guide.zh-CN.md](docs/adapter-guide.zh-CN.md) · [English](docs/adapter-guide.md)
- Zendesk + Shopify Shadow Mode：[docs/zendesk-shopify-shadow.zh-CN.md](docs/zendesk-shopify-shadow.zh-CN.md) · [English](docs/zendesk-shopify-shadow.md)
- Chatwoot Adapter：[docs/chatwoot-adapter.zh-CN.md](docs/chatwoot-adapter.zh-CN.md) · [English](docs/chatwoot-adapter.md)
- 第三方实现指南：[docs/implementing-osas.zh-CN.md](docs/implementing-osas.zh-CN.md) · [English](docs/implementing-osas.md)
- Conformance Mode（仅限测试）：[docs/conformance.zh-CN.md](docs/conformance.zh-CN.md) · [English](docs/conformance.md)
- 工程契约：[CONTRACTS.md](CONTRACTS.md)
- 贡献指南：[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) · [English](CONTRIBUTING.md)
- 治理：[GOVERNANCE.md](GOVERNANCE.md)
- 安全策略：[SECURITY.md](SECURITY.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- RFC：[rfcs/](rfcs/)（从 [0001-v0.1-core](rfcs/0001-v0.1-core.md) 开始；定位：[0002-osas-as-mcp-governance-profile](rfcs/0002-osas-as-mcp-governance-profile.md)）
- 变更日志：[CHANGELOG.md](CHANGELOG.md)

## 状态与路线图

OSAS v0.2 是**草案（Draft）**。通往 v1.0 的路径：

- [ ] 至少 **3 个独立实现**（本参考实现之外）通过某一 Profile 的兼容性套件。
- [ ] 全部规范性文档中英双语齐备，且保持同步更新。
- [ ] 无阻塞核心语义的未决 RFC；治理结构扩展为多方共治
      （见 [GOVERNANCE.md](GOVERNANCE.md)）。

在此之前，次版本之间可能出现不兼容变更；详见 [CHANGELOG.md](CHANGELOG.md) 与
[语义化版本策略](GOVERNANCE.md#versioning)。

## 许可证

Apache-2.0 —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
