<div align="center">
  <img src="docs/assets/osas-hero.svg" alt="OSAS：受治理的客服智能体" width="100%" />

  <h1>知道自己边界的客服 AI Agent。</h1>

  <p><strong>OSAS</strong>（开放客服智能体规范）是一份面向受治理客服 Agent 的开放契约：
  模型负责提议，策略引擎负责决定，适配器负责执行，审计轨迹负责解释。</p>

  <p>
    <a href="README.md">English</a> ·
    <a href="#六十秒跑通">本地运行</a> ·
    <a href="docs/spec-v0.2.zh-CN.md">阅读规范</a> ·
    <a href="CONTRIBUTING.zh-CN.md">参与贡献</a>
  </p>

  <p>
    <a href="https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml"><img src="https://github.com/shidesheng0218/open-support-agent-spec/actions/workflows/ci.yml/badge.svg" alt="CI 状态" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2563EB?style=flat-square" alt="Apache 2.0 许可证" /></a>
    <a href="docs/spec-v0.2.zh-CN.md"><img src="https://img.shields.io/badge/规范-v0.2%20Draft-F59E0B?style=flat-square" alt="v0.2 草案" /></a>
    <img src="https://img.shields.io/badge/Node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20 或更高" />
  </p>
</div>

<br />

| 20 个 MCP 工具 | 3 个 Profile | 220 条合成评测用例 | 345 项兼容 + 51 项黑盒检查 |
|---|---|---|---|
| Core、电商、SaaS | Schema 驱动契约 | 离线、CI 硬门禁 | HTTP 黑盒一致性 |

> **状态：v0.2 草案。** 这是一份处于活跃开发中的开放规范，不是自称的行业标准。
> v1.0 之前接口仍可能变化——见[路线图](#路线图)。

## 核心主张

一个强大的模型不等于一个安全的操作者。OSAS 把推理与权限分开：模型的输出
先变成一张类型化的 `ActionProposal`，每个提案都必须通过确定性的策略门禁，
而只有服务端才能执行。

| 难题 | OSAS 的答案 |
|---|---|
| 模型可能提出不安全的写操作 | 模型封顶在 `request-approval`，永远拿不到 `execute`。 |
| 每家客服系统的 API 都不一样 | 一个稳定、租户感知的 `SupportAdapter` 接口。 |
| “大概成功了”不是审计轨迹 | 每个提案、决策、模型调用与写入都会成为哈希链上的 `AuditEvent`。 |
| 直接上线风险高 | Shadow 模式是默认姿态：在人类写下最终结果前，什么都不执行。 |

## 六十秒跑通

```bash
git clone https://github.com/shidesheng0218/open-support-agent-spec.git
cd open-support-agent-spec
docker compose up --build
```

然后打开 [localhost:8080](http://localhost:8080) 的控制台，在 `/demo` 页运行
三个引导场景：

| 场景 | 策略结果 | 证明了什么 |
|---|---|---|
| $25 损坏商品退款 | `auto_execute` | 证据齐全的有界动作直接执行。 |
| $120 服务额度 | `pending_approval` | 更高风险的动作停在人工闸门。 |
| 注入指令 | 阻断 + 接管 | 不安全的路径被拒绝，且可见。 |

没有 Docker？`pnpm install && pnpm build && pnpm dev:api && pnpm dev:web`，
然后打开 [localhost:5173](http://localhost:5173)。

## 工作原理

每个 Agent 动作都走同一条管线：

```mermaid
flowchart LR
    A[读取可信数据<br/>经适配器工具] --> B[ActionProposal<br/>附证据]
    B --> C{确定性<br/>策略评估}
    C -->|auto_execute| D[执行边界]
    C -->|pending_approval| H[人工审批]
    C -->|blocked| X[人工接管]
    H --> D
    D --> W[幂等回写]
    W --> E[审计事件轨迹]
    X --> E
```

这条边界就是设计本身：**模型提议，策略决定，适配器执行，审计解释。**
模型从不接触后端凭据；每次适配器调用都携带租户与主体；结果不确定时
进入对账，绝不盲目重试。

### 权限阶梯

| 权限 | 含义 | 谁可以持有 |
|---|---|---|
| `read` | 读取工单、客户、订单、知识库 | 模型、人工、系统 |
| `draft` | 创建备注、升级、提案 | 模型、人工、系统 |
| `request-approval` | 提交提案，待审批后方可执行 | 模型（封顶）、人工、系统 |
| `execute` | 对已批准的提案执行后端写入 | 仅策略引擎 / API 后端 |

模型提案若请求 `execute`，即为策略违规（`PERMISSION_OVERREACH`）：拒绝、
接管、审计。

### 信任是工程产物，不是承诺

- **合规是门禁，不是自称**——黑盒 runner
  （`pnpm osas:compat -- --target <url>`）只通过 HTTP 给任何实现打分；结果
  进入公开[注册表](conformance/implementations.json)。
- **评测离线且被 CI 硬门禁**——220 条合成用例，硬门禁：100% schema 合法、
  100% 策略一致、零越权、零重复执行、零安全边界绕过。
- **每种威胁都有对应测试**——[威胁模型](docs/threat-model.zh-CN.md)把
  十三类攻击逐条映射到证明其防御的具体测试。

## 深入了解

<details>
<summary><strong>运行时配置</strong>——认证、存储、LLM、执行模式、Conformance 模式</summary>

<br />
所有旋钮都是环境变量——带注释的模板见 [.env.example](.env.example)。
全部失败即关闭。

- **认证**（`OSAS_AUTH_MODE`）：`demo`（默认；`x-osas-role` /
  `x-osas-actor-id` / `x-tenant-id` 请求头）或 `jwt`（OIDC Bearer，经
  `OSAS_JWKS_URL` / `OSAS_JWT_ISSUER` / `OSAS_JWT_AUDIENCE` 校验）。
  demo 模式在 `NODE_ENV=production` 下拒绝启动。外部主体永远拿不到
  `execute`。
- **存储**（`OSAS_STORAGE`）：`memory`（默认）或 `postgres`：

  ```bash
  docker compose --profile postgres up -d db migrate
  OSAS_STORAGE=postgres DATABASE_URL=postgres://osas:osas@localhost:5432/osas pnpm dev:api
  ```

- **LLM**（`OSAS_LLM_PROVIDER`）：`mock`（默认；确定性、无网络）或
  `openai-compatible`（`OSAS_LLM_BASE_URL` / `OSAS_LLM_API_KEY` /
  `OSAS_LLM_MODEL_FAST` / `OSAS_LLM_MODEL_STANDARD`）。预算上限
  （`OSAS_LLM_DAILY_BUDGET_USD`、`OSAS_LLM_CASE_BUDGET_USD`）在触网前就
  拦截超额调用；未配置计价的用量记为*未知*，绝不编造。
- **执行模式**（`OSAS_EXECUTION_MODE`）：`shadow`（默认）只做模拟；
  `proposal_only` 只起草；`sandbox` 对合成 provider 跑完整的确定性执行与
  对账路径。`live` 拒绝启动（见
  [受控执行](docs/controlled-execution.zh-CN.md)）。
- **Conformance 模式**（`OSAS_CONFORMANCE_MODE` + `OSAS_CONFORMANCE_KEY`）：
  仅供有状态套件使用的测试端点。生产环境绝不可用——启动即失败即关闭。
  见 [docs/conformance.zh-CN.md](docs/conformance.zh-CN.md)。
- **参考适配器**（未配置时失败即关闭；演示从不需要它们）：Zendesk、只读
  Shopify、Chatwoot——见
  [docs/zendesk-shopify-shadow.zh-CN.md](docs/zendesk-shopify-shadow.zh-CN.md)
  与 [docs/chatwoot-adapter.zh-CN.md](docs/chatwoot-adapter.zh-CN.md)。

</details>

<details>
<summary><strong>控制台</strong>——六个角色，一页总览</summary>

<br />

| 页面 | 角色 | 看什么 |
|---|---|---|
| `/demo` | 所有人 | 一键场景 + 自由输入消息（走 `/v1/chat`） |
| `/developer` | 开发者 | 20 个 MCP 工具、JSON Schema、在线校验 |
| `/agent` | 人工坐席 | 审批队列与人工接管 |
| `/after-sales` | 运营 | 售后 Top-10：立案、证据、审批、sandbox 凭证、对账 |
| `/shadow` | 审查者 | Shadow 运行审核与聚合影子指标 |
| `/platform` | 治理 | 防篡改审计轨迹与兼容报告 |

</details>

<details>
<summary><strong>仓库结构</strong></summary>

<br />

```
schemas/                 权威 JSON Schema（draft 2020-12）+ 清单
  execution-v0.3/        受控执行草案的 Schema
packages/
  core/                  @osas/core             类型、枚举、状态机、detectInjection
  schema-validator/      @osas/schema-validator 基于 schemas/ 的 Ajv 加载与校验
  policy-engine/         @osas/policy-engine    评估、权限阶梯、执行、审计链
  model-gateway/         @osas/model-gateway    provider 接口、路由、预算、遥测
  adapter/               @osas/adapter          SupportAdapter 接口 + BYO 模板
  zendesk-adapter/       @osas/zendesk-adapter  Zendesk 工单参考适配器
  shopify-adapter/       @osas/shopify-adapter  只读 Shopify 参考适配器
  chatwoot-adapter/      @osas/chatwoot-adapter Chatwoot 参考适配器
  ecommerce-shadow/      @osas/ecommerce-shadow Shadow/Sandbox 执行、凭证、对账
  mock-backend/          @osas/mock-backend     合成固件 + MockSupportAdapter
  store-postgres/        @osas/store-postgres   PostgreSQL 存储与迁移
  mcp-server/            @osas/mcp-server       20 个工具定义 + stdio MCP server
  compat-runner/         @osas/compat-runner    黑盒 HTTP 一致性 runner
apps/
  api/                   @osas/api              Fastify 5 HTTP API（端口 3001）
  web/                   @osas/web              React 18 + Vite 控制台（端口 5173）
tests/
  compat/                @osas/compat-suite     白盒兼容套件 + JSON 报告
  e2e/                   @osas/e2e              Playwright 冒烟（E2E=1）
evals/                   @osas/evals            220 条合成策略/售后用例
implementations/
  python-reference/      第二实现（通过黑盒套件）
conformance/             公开实现注册表、徽章、固件权威来源
examples/                embed-policy-engine    @osas/policy-engine 的最小嵌入示例
docs/  rfcs/  .github/workflows/  docker-compose.yml
```

</details>

<details>
<summary><strong>MCP 工具面</strong>——20 个工具，以及为什么 execute 永远不在其中</summary>

<br />

`@osas/mcp-server` 通过 stdio 把全部 agent 能力暴露为 20 个 MCP 工具：

| Profile | 工具 |
|---|---|
| core | `osas_core_get_case`、`osas_core_search_cases`、`osas_core_get_customer`、`osas_core_search_knowledge`、`osas_core_create_case_note`、`osas_core_create_escalation`、`osas_core_create_action_proposal` |
| ecommerce | `osas_ecom_get_order`、`osas_ecom_list_orders`、`osas_ecom_get_shipment`、`osas_ecom_get_shipment_incident`、`osas_ecom_get_refund_status`、`osas_ecom_create_item_claim_request`、`osas_ecom_create_exchange_request` |
| saas | `osas_saas_get_subscription`、`osas_saas_list_invoices`、`osas_saas_get_credit_balance`、`osas_saas_create_credit_request`、`osas_saas_create_cancellation_request`、`osas_saas_create_plan_change_request` |

写类工具只创建 `ActionProposal`（状态 `proposed`，权限 `request-approval`）。
`executeAction`**绝不**注册为工具——执行属于策略引擎与 API 后端。

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

</details>

<details>
<summary><strong>接入你自己的系统</strong></summary>

<br />
参考后端是内存 mock。接入真实系统时，实现 `@osas/adapter` 的
`SupportAdapter` 接口——从 `packages/adapter/templates/byo-adapter.template.ts`
起步。适配器在每次调用时收到携带租户与调用主体的 `ToolContext`，并且失败
即关闭。见[适配器开发指南](docs/adapter-guide.zh-CN.md)；Zendesk、Shopify
与 Chatwoot 适配器是完整参考。

只有 `@osas/core`、`@osas/schema-validator`、`@osas/policy-engine` 发布到
npm；其余包均为私有参考实现——请从仓库检出构建。如果只想在既有系统中采用
治理层，直接嵌入 `@osas/policy-engine`——见可运行的
[examples/embed-policy-engine](examples/embed-policy-engine)。

</details>

<details>
<summary><strong>验证命令</strong></summary>

<br />

```bash
pnpm typecheck      # 全 workspace 严格 TS
pnpm test           # 构建 + 全部单测（含 345 项兼容套件）
pnpm test:compat    # 白盒兼容套件 → tests/compat/report/latest.json
pnpm osas:compat -- --target http://localhost:3001   # 黑盒 runner
pnpm eval:policy    # 带硬门禁的离线策略评测
pnpm verify         # 完整发布门禁（typecheck + 测试 + 评测 + docker + e2e）
```

</details>

## 路线图

OSAS v0.2 仍是**草案**，在 v0.3 受控执行作为独立草案开发期间保持向后兼容。
通往 v1.0 的路径：

- [x] v0.3 受控执行草案通过 Sandbox 一致性套件。
- [x] 第二个实现通过黑盒 runner（v0.2 + v0.3）——仓内
      [Python 参考实现](implementations/python-reference/)，由 CI
      （`python-compat`）把关。它与本仓同属一个组织，不计入下面的独立性门槛。
- [ ] v0.2.1 维护版本不存在文档、Schema、版本号漂移。
- [ ] 至少 **3 个独立实现**通过某一 Profile 的兼容套件——
      [注册标准](conformance/README.md)。
- [ ] 全部规范性文档中英双语齐备，且保持同步更新。
- [ ] 无阻塞核心语义的未决 RFC；治理结构扩展为多方共治
      （见 [GOVERNANCE.md](GOVERNANCE.md)、[RFC 0004](rfcs/0004-multi-party-governance.zh-CN.md)）。

同一路径上的生态与加固事项：

- [ ] [RFC 0006](rfcs/0006-external-policy-decision-point.zh-CN.md)（外部策略
      决策点，只允许从严）被接受，并提供 AGT/OPA 示例。
- [ ] [RFC 0005](rfcs/0005-information-flow-control.zh-CN.md)（信息流控制）
      从设计注记升级为正式提案，并出现首个实现。
- [ ] AG-UI 审批 UX 集成在真实前端中验证
      （[指南](docs/ag-ui-integration.zh-CN.md)）。
- [ ] 威胁模型与安全需求同步维护
      （[docs/threat-model.zh-CN.md](docs/threat-model.zh-CN.md)）。
- [ ] 起草 RFC 0007（live 执行）——前置条件：Provider 认证、租户显式开启、
      回滚/补偿、运维监控、独立 Live 合规套件（见
      [RFC 0003](rfcs/0003-controlled-execution-profile.zh-CN.md)）。

v1.0 之前，次版本之间可能出现不兼容变更——见 [CHANGELOG.md](CHANGELOG.md) 与
[语义化版本策略](GOVERNANCE.md#versioning)。

## 文档

- 规范：[docs/spec-v0.2.md](docs/spec-v0.2.md) · [中文规范](docs/spec-v0.2.zh-CN.md)
- 适配器指南：[docs/adapter-guide.md](docs/adapter-guide.md) · [中文](docs/adapter-guide.zh-CN.md)
- Zendesk + Shopify 影子模式：[docs/zendesk-shopify-shadow.md](docs/zendesk-shopify-shadow.md) · [中文](docs/zendesk-shopify-shadow.zh-CN.md)
- Chatwoot 适配器：[docs/chatwoot-adapter.md](docs/chatwoot-adapter.md) · [中文](docs/chatwoot-adapter.zh-CN.md)
- 实现 OSAS（第三方指南）：[docs/implementing-osas.md](docs/implementing-osas.md) · [中文](docs/implementing-osas.zh-CN.md)
- Conformance 模式：[docs/conformance.md](docs/conformance.md) · [中文](docs/conformance.zh-CN.md)
- 受控执行（v0.3 草案）：[docs/controlled-execution.md](docs/controlled-execution.md) · [中文](docs/controlled-execution.zh-CN.md)
- v0.3 合规 Profile：[docs/conformance-v0.3.md](docs/conformance-v0.3.md) · [中文](docs/conformance-v0.3.zh-CN.md)
- 威胁模型：[docs/threat-model.md](docs/threat-model.md) · [中文](docs/threat-model.zh-CN.md)
- 竞品格局：[docs/competitive-landscape.md](docs/competitive-landscape.md) · [中文](docs/competitive-landscape.zh-CN.md)
- 工程契约：[CONTRACTS.md](CONTRACTS.md)
- 贡献：[CONTRIBUTING.md](CONTRIBUTING.md) · [中文](CONTRIBUTING.zh-CN.md)
- 治理：[GOVERNANCE.md](GOVERNANCE.md) · 安全：[SECURITY.md](SECURITY.md) · 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- RFC：[rfcs/](rfcs/) · 变更日志：[CHANGELOG.md](CHANGELOG.md)

## 许可证

Apache-2.0 —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
