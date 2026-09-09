# 实现 OSAS —— 第三方实现者指南

[English](implementing-osas.md)

本指南面向希望**独立实现** Open Support Agent Spec（OSAS）的团队——不限语言
与技术栈——并验证、声明兼容性。内容涵盖最小实现路径、使用 compat runner
进行黑盒验证、Conformance Mode、兼容性声明方式，以及实现者参与治理的途径。

独立实现的意义不止于互通：**≥3 个通过兼容性套件的独立实现是宣布 OSAS
v1.0 的硬性门槛**，实现者将在 v1.0 获得正式治理席位（见
[GOVERNANCE.md](../GOVERNANCE.md#path-to-v10)）。

## 权威依据

| 文件 | 作用 |
|---|---|
| [docs/spec-v0.2.zh-CN.md](spec-v0.2.zh-CN.md) | 规范正文（下文按章节号引用） |
| [schemas/manifest.json](../schemas/manifest.json) | 全部 Schema 的权威机器可读清单（`specVersion: "0.2"`） |
| [schemas/](../schemas/) | 权威 JSON Schema（draft 2020-12）；Schema 与正文冲突时以 Schema 为准 |
| [CONTRACTS.md](../CONTRACTS.md) | 工程契约：端点表（§9）、演示 fixtures（§11）、错误码 |
| [docs/conformance.zh-CN.md](conformance.zh-CN.md) | 有状态验证所依赖的 Conformance Mode 契约 |
| [GOVERNANCE.md](../GOVERNANCE.md) | 版本管理、兼容性声明、通往 v1.0 的路径 |

每个持久化对象都带有 Schema 级常量 `specVersion: "0.2"`（规范 §10）。
金额一律为 `{ currency, minorUnits }` 整数；时间戳为 ISO 8601
`date-time`；ID 为不透明字符串。

## 最小实现路径

`schemas/manifest.json` 是权威清单，按 profile 分组：**core**
（`core/` 下 14 项）、**ecommerce**（`profiles/ecommerce/` 下 2 项）、
**saas**（`profiles/saas/` 下 3 项），以及 **tools**（`tools/` 下 20 个
MCP 工具输入 Schema）。v0.3 Draft 的受控执行 Schema 单独列在
`schemas/manifest-v0.3.json`。

### Core profile（所有实现必须具备）

| 领域 | 必须实现的内容 | 规范章节 |
|---|---|---|
| 领域对象 | Case、Customer、Evidence、ActionProposal、Approval、TenantPolicy、AuditEvent、HumanHandoff（及 CaseNote、Escalation、KnowledgeArticle），均可通过 `schemas/core/*.json` 校验 | 规范 §2 |
| 状态机 | CaseStatus 与 ProposalStatus 的合法迁移、终态、禁止盲目重试 | 规范 §3 |
| 权限阶梯 | `read < draft < request-approval < execute`；模型主体封顶 `request-approval` | 规范 §4 |
| 策略求值 | 确定性的 `evaluateProposal` 算法（原因码、取最差决策、默认 block） | 规范 §5 |
| 执行 | 以 `(tenantId, idempotencyKey)` 幂等并重放；`uncertain` 进入对账；绝不自动重试 | 规范 §6 |
| 工具 | `schemas/tools/` 下 7 个 `osas_core_*` 工具输入 Schema | 规范 §7 |
| 安全 | §9 的全部要求（模型不持有凭据、注入防御、日志脱敏、默认拒绝） | 规范 §9 |

### Ecommerce profile（在 core 之上叠加）

- Schema：`profiles/ecommerce/order.json`、`profiles/ecommerce/shipment.json`。
- 动作类型：`refund`、`return_request`、`reshipment`、`cancel_order`
  （`refund`/`reshipment` 为金融动作：必须带金额 + ≥1 条证据）。
- 工具输入 Schema：`osas_ecom_get_order`、`osas_ecom_list_orders`、
  `osas_ecom_get_shipment`。

### SaaS profile（在 core 之上叠加）

- Schema：`profiles/saas/subscription.json`、`profiles/saas/invoice.json`、
  `profiles/saas/credit-balance.json`。
- 动作类型：`credit_apply`、`subscription_cancel`、`plan_change`。
- 工具输入 Schema：`schemas/tools/` 下 6 个 `osas_saas_*` Schema。

### v0.1.1 引入的扩展（通过当前 compat runner 所必需）

这些内容作为向后兼容的扩展引入（规范 §12），但**当前黑盒 runner 会实际
检查它们**，因此现阶段声明兼容性时应视为必需：

- **能力清单**（规范 §12.1）：发布可通过
  `schemas/core/capability-manifest.json` 校验的 CapabilityManifest，
  只声明规范已知能力，经 `/.well-known/osas` 和/或 `/v1/capabilities` 暴露。
- **策略版本生命周期**（规范 §12.2）：不可变版本
  `draft → simulated → approved → active → retired`，生命周期端点，
  对激活策略的 `PUT` 返回 409 `POLICY_IMMUTABLE`。
- **审计哈希链**（规范 §12.3）：按租户追加式 SHA-256 链；
  `GET /v1/audit/verify` 返回 `{ intact: true, ... }`。
- **Shadow Mode**（规范 §14）对兼容性为可选项——runner 不检查。

### v0.3 Draft 受控执行 Profile

`ecommerce-controlled-execution` 与稳定的 v0.2 套件分开验证。实现必须声明
`sandbox` 和按动作类型的 `executionContracts`，并证明 Attempt、Receipt、幂等、
不确定结果对账、Provider Event 去重和策略 fail-closed 边界。运行方式：

```bash
pnpm osas:compat -- --target http://localhost:3001 \
  --profile controlled-execution \
  --conformance-key <test-only-key> \
  --provider-event-key <test-only-key> \
  --out controlled-execution-report.json
```

该报告使用 `specVersion: "0.3"`，不会替代 v0.2 报告。

### Runner 期望的 HTTP 表面

Runner 只通过 HTTP 探测。CONTRACTS.md §9 的端点表是完整参考；下文的
检查清单会逐项标明实际用到的路由。所有错误统一为
`{ error: { code, message, details? } }` 信封。demo 认证模式的目标读取
runner 发送的 `x-tenant-id` / `x-osas-role` 请求头；JWT 模式的目标用
`--token` 驱动（见下文）。

## 用 compat runner 验证

黑盒 runner（`@osas/compat-runner`，`packages/compat-runner/src/`）只通过
HTTP 驱动你的实现——不 import 你的任何代码，并在本地用本仓库的 Schema
校验响应。

### 准备

```bash
pnpm install && pnpm build      # 构建 @osas/core、schema-validator 等 runner 依赖
```

### 只读套件（无需 key）

```bash
pnpm osas:compat -- --target https://your-osas-service.example.com
```

始终执行的检查：

| 套件 | 检查项 |
|---|---|
| `discovery` | `GET /.well-known/osas` → 200 JSON 对象；`specVersion === "0.2"`；CapabilityManifest（内嵌于 `capabilities` 字段或经 `GET /v1/capabilities` 获取）通过 `core/capability-manifest` 校验；manifest 只声明已知 profile（`core`/`ecommerce`/`saas`）与规范已知能力 |
| `schemas-tools` | `GET /v1/schemas` 返回 Schema 清单（须含 `core/action-proposal`）；`GET /v1/schemas/core/action-proposal` 返回 JSON Schema；`GET /v1/meta/tools` 列出带 `name` + `inputSchema` + 已知 `capabilityRequired` 的工具；`POST /v1/validate` 对合法 ActionProposal 返回 `{valid: true}`、对非法返回 `{valid: false}` |
| `policy-read` | `GET /v1/policies/:tenant` 返回可通过 `core/tenant-policy` 校验的激活 TenantPolicy；用未知版本调用 `POST /v1/policies/:tenant/simulate` → 404 |

未提供 conformance key 时，stateful 套件记为**跳过（skip）**，运行结果
仍可为 `ok`——但兼容性声明应有完整 stateful 运行作为支撑（见下文）。

### Stateful 套件（需要你的实现开启 Conformance Mode）

先以 Conformance Mode 启动你的服务，再传入 key：

```bash
pnpm osas:compat -- --target http://localhost:8080 \
  --conformance-key <test-only-key> --out osas-compat-report.json
```

（等价做法：在 runner 自身环境中设置 `OSAS_CONFORMANCE_MODE=true` +
`OSAS_CONFORMANCE_KEY`。）stateful 检查按序如下：

| # | 检查 | 预期 |
|---|---|---|
| 1 | 错误 conformance key | 携带错误 key 调用 `POST /v1/conformance/reset` → 401 或 403 |
| 2 | `POST /v1/conformance/reset` | 恢复演示 fixture 状态；响应含 `snapshot.counts` 且 `cases >= 1` |
| 3 | `GET /v1/conformance/snapshot` | `auditChain.intact === true` |
| 4 | 策略生命周期 | draft → simulate（小额已验证身份退款 → `auto_execute`；超阈值 → `require_approval`；未验证身份 → `block`）→ approve → activate（激活版本切换）→ retire |
| 5 | 非法迁移 | 未 simulate 直接 approve → 409 |
| 6 | 不可变性 | `PUT /v1/policies/:tenant` → 409 `POLICY_IMMUTABLE` |
| 7 | 幂等执行 | 创建 proposal → evaluate（`auto_execute`）→ execute → 用相同 key 再次 execute → `replayed: true`，无第二次副作用 |
| 8 | RBAC | `x-osas-role: support_agent` 创建策略草稿 → 403 |
| 9 | 租户隔离 | 读取其他租户的策略 → 403 `TENANT_MISMATCH` |
| 10 | 审计链 | `GET /v1/audit/verify` → `intact: true`；`/v1/audit` 包含 `policy_draft_created`、`policy_activated`、`execution_succeeded` |
| 11 | 清理 | 最后一次 reset 返回 200 |

注意 fixture 依赖：第 4、7 项检查使用 CONTRACTS.md §11 的演示数据集
（`tenant_demo`、`case_refund`、`cus_verified`、`cus_unverified`、
`ord_small`、`ev_ord_small`，演示策略的退款自动执行阈值为 $50）。你的
`reset` 必须播种等价的确定性数据集——见下一节。

### Runner 参数、报告与退出码

| 参数 / 环境变量 | 含义 |
|---|---|
| `--target <url>` | 你的实现的 Base URL（必填） |
| `--token <token>` | JWT 模式目标的 Bearer token |
| `--tenant <id>` | 租户 id（默认 `tenant_demo`）；同时作为 `x-tenant-id` 发送 |
| `--role <role>` | 特权检查使用的 demo 认证角色（默认 `policy_admin`） |
| `--conformance-key <key>` | 启用 stateful 套件 |
| `--timeout <ms>` | 单请求超时（默认 10000） |
| `--out <file>` | 同时将 JSON 报告写入文件 |

退出码：**0** = 全部通过，**1** = 存在失败检查，**2** = 用法错误。

报告为机器可读 JSON：

```jsonc
{
  "specVersion": "0.2",
  "generator": "@osas/compat-runner@0.2.0",
  "target": "http://localhost:8080",
  "runAt": "2026-09-07T…",
  "mode": { "stateful": true },
  "ok": true,                       // 失败检查数为零
  "totals": { "passed": 22, "failed": 0, "skipped": 0 },
  "suites": [ { "name": "…", "passed": 0, "failed": 0, "skipped": 0, "checks": [ { "name": "…", "status": "pass|fail|skip", "detail": "…" } ] } ]
}
```

`ok: true` 表示**失败检查数为零**（skip 不导致失败，但基于
stateful 被跳过的运行做声明，证据力较弱）。该格式与
[GOVERNANCE.md](../GOVERNANCE.md#declaring-compatibility) 所引用、由仓库
内套件产出到 `tests/compat/report/latest.json` 的报告格式一致：同样的
`ok` / `suites` / 逐项检查语义。

## 在自己的实现中落地 Conformance Mode

要解锁 stateful 套件，需实现
[docs/conformance.zh-CN.md](conformance.zh-CN.md) 中的 Conformance Mode
契约。Runner 只依赖其 HTTP 行为，但强烈建议对齐完整契约：

- **仅限测试。** Conformance Mode 绝不可在生产环境可达。
- **失败即关闭（fail closed）。** 该模式与生产环境同时启用时启动直接
  中止；启用但未设置 key 同样拒绝启动。模式关闭时这些端点**根本不注册**
  （404）。
- **常量时间 key 比较。** 每个请求都要求
  `X-OSAS-Conformance-Key: <key>` 头，并以常量时间比较（参考 API 对
  SHA-256 哈希值使用 `timingSafeEqual`）；key 错误或缺失 → 403。
- **确定性重置。** `POST /v1/conformance/reset` 清空全部可变状态并重新
  播种 CONTRACTS.md §11 的演示 fixtures；
  `POST /v1/conformance/fixtures/load` 支持 `{ "name": "demo" | "empty" }`；
  `GET /v1/conformance/snapshot` 返回按租户计数与审计链校验结果。

| 端点 | 行为 |
|---|---|
| `POST /v1/conformance/reset` | 清空并重新播种演示 fixtures；返回快照 |
| `POST /v1/conformance/fixtures/load` | `{ "name": "demo" \| "empty" }` |
| `GET /v1/conformance/snapshot` | 按租户计数 + `auditChain` 校验结果 |

## 声明兼容性

依据 [GOVERNANCE.md](../GOVERNANCE.md#declaring-compatibility)：

- 仅当当前兼容性工具对你的实现通过、且机器可读报告显示 `ok: true` 时，
  方可声明 **profile 兼容性**（`core`、`ecommerce` 或 `saas`）。
- **声明中必须注明规范版本与 profile**，例如
  "OSAS 0.2 ecommerce-compatible"。你的对象须携带
  `specVersion: "0.2"`；面向未来规范线的声明随其版本号走。
- **留存报告。** 将 runner 输出（完整 stateful 运行的
  `--out osas-compat-report.json`）与声明一并保存，以便复核。
- v0.x 期间 minor 版本可能有破坏性变更——当你对标的 `specVersion` 线
  变化时需重新运行套件（见
  [GOVERNANCE.md §Versioning](../GOVERNANCE.md#versioning)）。

## 参与治理

- **v1.0 门槛与席位。** v1.0 要求 ≥3 个独立实现通过某 profile 的兼容性
  套件；治理扩展后，拥有通过实现的组织将与创始维护者共同持有规范决策
  席位（GOVERNANCE.md §Path to v1.0）。可通过 issue 或 discussion 登记
  你的实现。
- **RFC。** 破坏性变更与新语义需要 RFC：复制
  [rfcs/0000-template.md](../rfcs/0000-template.md) 为
  `rfcs/NNNN-short-name.md`，以 Status `Draft` 提交 PR。实现者在技术栈中
  遇到的新语义，欢迎以 RFC 提出。
- **贡献流程。** [CONTRIBUTING.zh-CN.md](../CONTRIBUTING.zh-CN.md) 涵盖
  PR 检查清单与发布门禁（Schema、中英文档、参考实现、兼容性测试必须在
  同一 PR 中落地）。

## 把参考实现当作已知良好的对标

在测试自己的服务之前，先对本仓库的参考实现运行 runner，端到端观察预期
行为：

```bash
pnpm install && pnpm build
pnpm dev:api                       # 参考 API 位于 http://localhost:3001，
                                   # 默认播种 mock 后端（SEED_DEMO），
                                   # demo 认证（x-osas-role 请求头）
pnpm osas:compat -- --target http://localhost:3001
```

要观察 **stateful** 套件全部通过，先以 Conformance Mode 重启 API，再带
key 运行：

```bash
OSAS_CONFORMANCE_MODE=true OSAS_CONFORMANCE_KEY=test-key pnpm dev:api
pnpm osas:compat -- --target http://localhost:3001 \
  --conformance-key test-key --out reference-report.json
```

`docker compose up --build` 可在容器中获得同样的 API。逐条查看
`reference-report.json` 中的检查——它就是你的实现必须满足的精确契约。
