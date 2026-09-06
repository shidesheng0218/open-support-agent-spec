# Conformance Mode（Milestone 4）—— 仅限测试

> **严禁在生产环境启用 Conformance Mode。** 它会暴露 reset、fixture 加载与
> 状态快照端点，可清空并重置全部数据。参考 API 失败即关闭：
> `OSAS_CONFORMANCE_MODE=true` 与 `NODE_ENV=production` 同时出现时启动直接
> 中止；启用但未设置 `OSAS_CONFORMANCE_KEY` 同样拒绝启动。

Conformance Mode 存在的唯一目的，是让黑盒 compat runner
（`packages/compat-runner`，`pnpm osas:compat -- --target <url>`）能够在
确定性的基准状态上校验有状态的契约行为——策略版本生命周期、幂等执行、
权限与租户隔离、审计链完整性。

## 启用方式（仅限测试环境）

```bash
OSAS_CONFORMANCE_MODE=true
OSAS_CONFORMANCE_KEY=<test-only-secret>   # 绝不复用任何真实凭据
```

Runner 在自身环境中读到同样的变量，或收到 `--conformance-key <key>` 参数时，
才会运行状态型套件；未配置 key 时只执行只读套件。

## 端点

所有端点要求 `X-OSAS-Conformance-Key: <key>` 请求头（常量时间比较；错误
或缺失 → 403）。模式关闭时端点**根本不注册**（404）。

| 端点 | 行为 |
|---|---|
| `POST /v1/conformance/reset` | 清空全部可变状态并重新载入 CONTRACTS.md §11 演示 fixtures；返回快照。 |
| `POST /v1/conformance/fixtures/load` | 请求体 `{ "name": "demo" \| "empty" }`；`empty` 只保留演示策略（无工单/客户/订单）。 |
| `GET /v1/conformance/snapshot` | 按租户统计（工单、建议、接管单、审计事件、策略版本、ShadowRun、用量记录）及审计链校验结果。 |

当 `OSAS_STORAGE=postgres` 时，reset 会额外清空存储表
（`policy_versions`、`audit_events`、`execution_records`、`shadow_runs`、
`model_usage`）；Adapter 数据集始终是内存 mock。

## 失败即关闭（fail closed）保证

- `NODE_ENV=production` + `OSAS_CONFORMANCE_MODE=true` → 拒绝启动
  （`ConfigError`），与认证模式无关。
- `OSAS_CONFORMANCE_MODE=true` 但缺少 `OSAS_CONFORMANCE_KEY` → 拒绝启动。
- 模式关闭 → 端点不存在（404）。
- Key 错误 → 403；对哈希值做 `timingSafeEqual` 比较。
- CI 只在一次性的 Docker 测试环境中启用该模式
  （`.github/workflows/ci.yml` 的 `docker` job）。
