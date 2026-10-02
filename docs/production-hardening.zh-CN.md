# 生产加固指南

[English](production-hardening.md)

> **本文档是什么。** 参考实现是演示级的（见 [SECURITY.md](../SECURITY.md)）：
> 它存在的意义是让规范可运行、可测试。本指南提供的是从演示到可承载真实流量部署的
> **路径**——它并不声称下面的任何阶段能把参考代码变成经过审计的生产系统。
>
> **本文档不是什么。** 实时执行（`OSAS_EXECUTION_MODE=live`）被规范本身禁用，
> 启动会直接拒绝。本文任何内容都不会开启它；那需要未来的 RFC（见 README 路线图）。

## 三个阶段

| 配置项 | 阶段 1 · 演示 | 阶段 2 · 预发 | 阶段 3 · 生产 |
|---|---|---|---|
| `OSAS_AUTH_MODE` | `demo` | `jwt` | `jwt` |
| `OSAS_STORAGE` | `memory` | `postgres` | `postgres` |
| `OSAS_LLM_PROVIDER` | `mock` | `openai-compatible` | `openai-compatible` |
| `OSAS_LLM_*_BUDGET_USD` | 不设置 | 设置 | 设置 + 告警 |
| `OSAS_EXECUTION_MODE` | `shadow` | `shadow` 或 `sandbox` | `shadow` 或 `sandbox` |
| `OSAS_CONFORMANCE_MODE` | 关闭 | 关闭 | **永远关闭** |
| `NODE_ENV` | 任意 | 任意 | `production` |
| 数据 | 合成 fixtures | 合成 / 脱敏 | 真实、最小化 |

阶段 1 就是 `docker compose up --build`。阶段 2 用合成数据验证你的身份提供方、
数据库与模型供应商接线。阶段 3 叠加下面的运维控制。不要跳过阶段 2：参考 API 的
每一项 fail-closed 守卫都应在接触真实客户数据之前被验证过。

## 生产环境"绝不能"清单

下面每一项在启动时都是 fail-closed 的——API 宁可拒绝启动也不在弱配置下运行。
不要通过 fork 移除这些守卫；一个"照样能启动"的 fork 就是安全回退
（见威胁模型 docs/threat-model.zh-CN.md）。

1. **绝不能**在 `NODE_ENV=production` 下使用 `OSAS_AUTH_MODE=demo`。demo 头是
   自我声明的身份：任何能访问端口的人可以声称自己是任何人。
2. **绝不能**在一次性 CI 环境之外开启 `OSAS_CONFORMANCE_MODE`。reset/fixtures
   端点按设计会清空状态。
3. **绝不能**尝试 `OSAS_EXECUTION_MODE=live`。启动会以
   `LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1`（保留的历史错误码名）中止。
4. **绝不能**让令牌或请求头声称 `system_executor` 角色——按设计它会被拒绝；
   如果你看到它被接受，那就是漏洞：请按 SECURITY.md 私下报告。
5. **绝不能**把真实客户数据放进 fixtures、issue 或评测用例。
6. **绝不能**记录 `OSAS_LLM_API_KEY`、适配器令牌或 `Authorization` 头。参考
   日志器会脱敏 `req.headers.authorization`、`*.email`、`*.phone` 与自由文本 body
   （`apps/api/src/plugins.ts`）；修改日志时保持这些脱敏路径完好。

阶段 3 的可复制起点见
[docker-compose.prod.yml.example](../docker-compose.prod.yml.example)——所有占位符都标有
`CHANGE_ME`，CI 会对该文件做静态校验（`docker compose -f ... config`），保证其不会腐化。

## 阶段 3 控制项

### 身份与访问

- 在 IdP 侧完成 OIDC 终结；配置 `OSAS_JWKS_URL`、`OSAS_JWT_ISSUER`、
  `OSAS_JWT_AUDIENCE`。缺任何一项都会 fail-closed 拒绝启动。
- 把 IdP 角色映射到四个 OSAS 角色（`support_agent`、`policy_admin`、`auditor`；
  `system_executor` 是服务端内部角色，绝不能出现在令牌里）。
- 保持租户声明的权威性：跨租户访问在路由层以 403 `TENANT_MISMATCH` 拒绝；
  不要削弱 `assertTenantAccess`。

### 存储与持久性

- `OSAS_STORAGE=postgres`，使用托管 PostgreSQL。部署时、新版本 API 承接流量之前
  先应用迁移（`pnpm db:migrate`）。
- 执行账本主键 `(tenant_id, idempotency_key)` 在数据库层面强制幂等——保留它，
  不要用应用层检查替代。
- 执行状态更新与其审计流写入在同一事务中提交。任何自定义存储都要保持这一性质。
- 备份数据库并演练恢复。审计链的持久性等同于其存储的持久性。

### 审计链：防篡改检测 ≠ 防篡改

SHA-256 哈希链（`sequence` / `previousHash` / `eventHash`，由
`GET /v1/audit/verify` 校验）能检测**已存储**事件流的修改、删除与重排。
但能整体重写存储的攻击者也能重算整条链。请与 WORM 存储配合：

- 在写入时把审计事件流出到箱外（追加式日志服务，或开启 Object Lock / 不可变性
  的对象存储）；或
- 部署外部定时任务，按租户调用 `GET /v1/audit/verify`，对 `intact: false` 告警，
  并定期做离线快照、锚定其哈希。

### 模型供应商与预算

- 两个价格旋钮（`OSAS_LLM_INPUT_USD_PER_MTOKEN`、`OSAS_LLM_OUTPUT_USD_PER_MTOKEN`）
  要么都设要么都不设——不设时成本记录为 unknown，绝不编造，但预算强制也无从计量。
- 设置 `OSAS_LLM_DAILY_BUDGET_USD` 与 `OSAS_LLM_CASE_BUDGET_USD`。到达上限时调用
  在触及供应商**之前**被阻断；80% 时写入 `budget_warning` 审计事件。对该事件告警。
- 把 `GET /v1/usage`（`policy_admin` / `auditor` 角色）接入你的指标系统。

### 边缘与运行时

- 在 API 前放置终结 TLS 的反向代理；参考服务器只说明文 HTTP。
- 在代理层加限流。参考 API 本身没有限流。
- 只有使用 PostgreSQL 存储时才可运行多副本——内存存储是进程级的，多副本会分叉。
- 关注启动日志：API 会打印**安全姿态摘要**（auth / storage / execution /
  conformance / LLM provider 每个旋钮一行）。生产进程若报告了上面矩阵中
  阶段 3 之外的任何值，应当触发告警。
- 用 `/health` 做健康检查；它无需认证，只返回 `{ status, specVersion, version }`。

### 密钥

- 所有凭据只从环境变量读取：`OSAS_LLM_API_KEY`、`ZENDESK_API_TOKEN`、
  `SHOPIFY_ADMIN_ACCESS_TOKEN`、`CHATWOOT_API_TOKEN`、`OSAS_PROVIDER_EVENT_KEY`、
  `DATABASE_URL`。使用平台的密钥管理；按计划轮换；绝不烘进镜像或 compose 文件。

## 上线前检查清单

- [ ] `OSAS_AUTH_MODE=jwt`；租户 A 的令牌读不到租户 B（探测应得 403）。
- [ ] `OSAS_STORAGE=postgres`；迁移已应用；恢复演练已完成。
- [ ] 预算已设置；人为触发一次 `budget_warning` 并确认到达告警渠道。
- [ ] `GET /v1/audit/verify` 返回 `intact: true`；外部校验任务已排期。
- [ ] conformance 端点返回 404（模式关闭）；`/v1/usage` 对非 admin/auditor
      角色返回 403。
- [ ] 启动姿态日志只显示阶段 3 的值；弱配置组合产生的 WARN 有人阅读。
- [ ] 租户策略已评审：`defaultDecision` 为 `block`；阈值、地区、身份要求
      符合你的风险偏好。
- [ ] 审批超时已配置（`approval.timeoutSeconds`），使待定审批 fail-safe
      （仅拒绝）而非悬置。
- [ ] 日志管道已验证保持脱敏路径完好。
- [ ] 回滚方案：如何在不拖垮客服系统的前提下关停智能体写入
      （吊销适配器凭据）。

## 仍然由你负责的部分

渗透测试、真正的 WORM sink、SIEM 集成、数据驻留控制以及你所处的任何合规体系，
都属于部署侧关切。规范给你的是防篡改检测、租户隔离、确定性策略与完整审计链——
把它们变成你的合规叙事，是你的工作。