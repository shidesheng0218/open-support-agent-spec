# 维护者入职指南

[English](maintainer-onboarding.md)

本文面向新任维护者与评审者：仓库如何拼合、你被托付守护的不变量、以及如何在
CI 之前在本地跑通每一道门。贡献者请先从 [CONTRIBUTING.md](../CONTRIBUTING.zh-CN.md)
开始。

## 一段话架构

**Schema**（`schemas/`，JSON Schema draft 2020-12）是机器可校验的权威——
文字与 schema 冲突时以 schema 为准。`@osas/core` 承载类型、枚举、状态机与
`detectInjection`；`@osas/schema-validator` 是 schema 之上的 Ajv 装载器；
`@osas/policy-engine` 是确定性决策点（评估、权限阶梯、执行编排、审计哈希链）。
核心之外：`@osas/model-gateway`（供应商抽象、预算、遥测）、`@osas/adapter` 及
mock/Zendesk/Shopify/Chatwoot 适配器实现、`@osas/mcp-server`（20 个工具的 MCP
表面）、`apps/api`（Fastify HTTP）、`apps/web`（控制台），以及验证体系
（`tests/compat`、`@osas/compat-runner`、`evals/`、`tests/e2e`）。
[CONTRACTS.md](../CONTRACTS.md) 是让独立构建的各部分不产生漂移的单一共享契约——
改动任何结构性内容之前先读它。

## 你守护的不变量

以下性质是 OSAS 值得被信任的原因。任何削弱它们的 PR 都是安全回退，
而不是"设计选择"：

1. **模型永不执行。** 模型主体的上限是 `request-approval`；`executeAction` 永远
   不是 MCP 工具；只有服务端能把提案推进到 `executing`。
2. **处处 fail closed。** demo 认证拒绝生产环境；`live` 执行拒绝启动；
   conformance 模式拒绝生产环境；未配置的适配器宁可报错也不伪造成功；
   成本未知时记为 unknown，绝不编造。
3. **绝不盲目重试。** 提案终态保持终态；`uncertain` 进入人工对账；新尝试等于
   新提案加新幂等键。
4. **默认拒绝。** 未匹配的动作一律阻断；策略默认决策为 `block`。
5. **审计链解释一切。** 每次状态变化都产生哈希链审计事件；日志脱敏路径
   保持完好。
6. **Schema、文档与代码同批变更。** 发布门禁要求 schema、中英双语文档、
   参考实现与 compat 测试在同一 PR 中。

## 各道门与本地复现

| 门 | 命令 | 证明什么 |
|---|---|---|
| 版本一致性 | `pnpm check:versions` | 单一锁步版本、SPEC_VERSION、文档中无过期工具计数或版本声明 |
| CI 工作流形态 | 含于 `pnpm test` | CI 先 test 后 typecheck；compat 先构建 |
| DCO | `pnpm check:dco` | PR 中每个提交都有匹配的 Signed-off-by |
| 构建 + 单测 | `pnpm test` | 全工作区严格 TS；所有包的测试套件 |
| 白盒 compat | `pnpm test:compat` | 345 项检查：schema、工具映射、状态机、策略矩阵、幂等 |
| 黑盒 compat | `pnpm osas:compat -- --target <url> --conformance-key <k>` | 注册级 `gateOk`（走 HTTP） |
| 离线评测 | `pnpm eval:policy`（及 `:after-sales`、`:controlled`） | 硬门槛：schema 100% 有效、策略 100% 一致、越权/重复/绕过分项为 0 |
| 发布就绪 | `pnpm check:publish` | 四个公共包打包干净（dist、README、LICENSE、NOTICE；无残留 `workspace:*`） |
| 完整发布门 | `bash scripts/verify.sh` | 以上全部，外加 Docker 与 e2e |

CI 以任务形式镜像这些门（`build-test`、`compat`、`python-compat`、`docker`、
`e2e`、`publish-dry-run`，PR 上还有 `dco`）。CI 失败时先按上表在本地复现，
再请别人介入。

## RFC 流程

破坏性变更与新语义（schema、状态机、评估算法、权限阶梯、MCP 工具表面、
适配器接口）必须在实现**之前**先有 RFC：

`Draft` → 维护者评审 → `Accepted` / `Rejected` → schema + 实现 + 测试 +
双语文档全部合入 → `Implemented`。`Superseded` 表示该 RFC 已被更新的取代。
只有 `Accepted` 状态的 RFC 可以进入实现。模板见
[rfcs/0000-template.md](../rfcs/0000-template.md)。

## 发布

发布由创始维护者按规范性发布门禁执行（见 CONTRIBUTING.md）：schema + 双语文档
+ 实现 + compat 测试同一 PR；没有可运行示例与通过测试就不发稳定版；`main` 上
CI 全绿。机械性的发布步骤见
[docs/release-checklist.md](release-checklist.md)。

## 第一周清单

- [ ] 从干净检出运行 `pnpm install && pnpm test && pnpm eval:policy`。
- [ ] 跑通三个演示场景（`docker compose up --build`，打开控制台 `/demo`），
      并阅读它们产生的审计链（`/platform`）。
- [ ] 读规范 §4–§6（权限阶梯、评估算法、执行），然后读
      `packages/policy-engine/src/evaluate.ts`——代码应当读起来像删去散文的规范。
- [ ] 读威胁模型，并为每一行威胁找到对应的测试。
- [ ] 按上面的不变量（而非个人口味）评审一个开放的 PR。
- [ ] 在 `pnpm check:versions`、单测与评测门全部本地通过之前，不合入任何内容。

## 权威位置速查

| 问题 | 权威位置 |
|---|---|
| 数据形态 | `schemas/`（机器可校验）+ `docs/spec-v0.2.zh-CN.md`（文字） |
| 工程不变量 | [CONTRACTS.md](../CONTRACTS.md) |
| 决策规则、版本策略、v1.0 门槛 | [GOVERNANCE.md](../GOVERNANCE.md) |
| 安全基线与报告渠道 | [SECURITY.md](../SECURITY.md) |
| 威胁 → 防御 → 测试 | [docs/threat-model.zh-CN.md](threat-model.zh-CN.md) |
| 发布机械步骤 | [docs/release-checklist.md](release-checklist.md) |
| 生产部署路径 | [docs/production-hardening.zh-CN.md](production-hardening.zh-CN.md) |