# OSAS v0.3 受控执行 Conformance

v0.2 兼容套件继续负责 Core、Ecommerce、SaaS 的兼容性。受控执行是独立的
v0.3 Draft Profile，未实现 Sandbox 的 v0.2 实现不会因为新增语义而破坏。

## 兼容声明

只有在满足以下条件时，才能声明：

```text
OSAS 0.3 ecommerce-controlled-execution-compatible
```

- 暴露 `specVersion: "0.3"` 执行 Schema；
- 执行模式包含 `sandbox`；
- 发布按动作类型的 `executionContracts`；
- 具备确定性幂等和 Provider Event 去重；
- 生成执行凭证和对账任务；
- 审计链完整；
- 模型没有调用 `execute` 的路径。

## 必测场景

至少证明：

1. Sandbox 成功会生成 Attempt 和 Receipt；
2. 重复幂等键只重放，不重复调用 Provider；
3. Provider 失败是终态，不会无条件重试；
4. Provider 超时生成 `uncertain` 和开放对账任务；
5. 匹配的 Provider Event 只解决一次；
6. 重复 Provider Event 不产生副作用；
7. 跨租户事件不能解决其他租户任务；
8. 缺失 Adapter 能力必须 fail closed；
9. 换货请求仍然只能人工履约；
10. 参考实现配置 `live` 时启动失败。

当前仓库提供 Schema、Sandbox Adapter、API 测试和 PostgreSQL 存储，可作为
独立实现的起点。`implementations/python-reference/` 是接入样板；在它独立
发布成单独仓库并通过测试前，不计入治理席位。

## 运行黑盒 Profile

先用仅测试用途的 Conformance Mode、Sandbox 和 Provider Event Key 启动参考 API，
再单独生成 v0.3 Draft 报告：

```bash
OSAS_EXECUTION_MODE=sandbox \
OSAS_CONFORMANCE_MODE=true \
OSAS_CONFORMANCE_KEY=local-conformance-key \
OSAS_PROVIDER_EVENT_KEY=local-provider-key \
pnpm dev:api

pnpm osas:compat -- \
  --target http://localhost:3001 \
  --profile controlled-execution \
  --conformance-key local-conformance-key \
  --provider-event-key local-provider-key \
  --out controlled-execution-report.json
```

该报告与 `tests/compat/report/latest.json` 分离，包含
`specVersion: "0.3"` 和 `profile: "ecommerce-controlled-execution"`。
