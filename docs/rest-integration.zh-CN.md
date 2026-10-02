# REST 集成指南

[English](rest-integration.md)

OSAS 是传输中立的。20 个 MCP 工具是一种表面；本指南是另一种：直接对参考 API
发起普通 HTTP 调用。这里的任何内容都不需要 MCP 客户端。

## 发现

```bash
curl -s http://localhost:3001/.well-known/osas   # specVersion、能力清单、端点
curl -s http://localhost:3001/v1/openapi.json    # OpenAPI 3.1 文档
```

`/v1/openapi.json` 描述稳定的 v1 表面。它的 `components.schemas` 在请求时从权威
`schemas/` 清单加载——与运行时校验器使用同一来源——因此文档不可能与服务端实际
强制的规则漂移。可以把它喂给任何 OpenAPI 3.1 工具链（客户端生成器、契约测试、
文档查看器）。

## 认证与租户

每个请求都携带主体与租户：

| 模式 | 请求头 |
|---|---|
| `OSAS_AUTH_MODE=demo`（本地默认） | `x-osas-role`、`x-osas-actor-id`、`x-tenant-id` |
| `OSAS_AUTH_MODE=jwt` | `Authorization: Bearer <OIDC token>`，含 `sub` / `tenant_id` / `roles` 声明 |

路径中的租户必须与主体的租户一致，否则 API 返回 403 `TENANT_MISMATCH`。
外部主体永远拿不到 `execute` 权限。

## REST 形态的提案流水线

写路径与规范一致：**提案 → 评估 →（审批）→ 执行**，每一步都有审计事件。

```bash
# 1. 创建提案（幂等：用相同 idempotencyKey 重放会返回已存提案，
#    带 replayed: true，无任何副作用）。
curl -s -X POST http://localhost:3001/v1/proposals \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent' \
  -d '{
    "tenantId": "tenant_demo",
    "caseId": "case_refund",
    "profile": "ecommerce",
    "actionType": "refund",
    "reasonCode": "damaged",
    "params": { "orderId": "ord_small" },
    "requestedPermission": "request-approval",
    "requestedBy": { "actorType": "human", "actorId": "agent_1" },
    "amount": { "currency": "USD", "minorUnits": 2500 },
    "evidenceIds": ["ev_order_small"],
    "idempotencyKey": "my-unique-key-001"
  }'

# 2. 对租户策略做确定性评估（产生 policy_evaluated 审计事件）。
curl -s -X POST http://localhost:3001/v1/proposals/prp_1/evaluate \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent'

# 3a. auto_execute 决策立即可执行。
curl -s -X POST http://localhost:3001/v1/proposals/prp_1/execute \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent'

# 3b. require_approval 决策停在审批队列，等待人工决定。
curl -s "http://localhost:3001/v1/approvals?status=pending" \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent'
curl -s -X POST http://localhost:3001/v1/approvals/apr_1/decide \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_demo' -H 'x-osas-role: support_agent' \
  -d '{ "decision": "approved", "approverId": "agent_1" }'

# 4. 查看哈希链审计轨迹。
curl -s "http://localhost:3001/v1/audit?proposalId=prp_1" \
  -H 'x-tenant-id: tenant_demo'
curl -s "http://localhost:3001/v1/audit/verify" -H 'x-tenant-id: tenant_demo'
```

可以依赖的执行语义：

- **幂等。** 执行以 `(tenantId, idempotencyKey)` 为键；重放返回已存结果，带
  `replayed: true`，无第二次副作用。
- **绝不盲目重试。** `failed` / `rejected` 提案是终态；新尝试等于新提案加新键。
  `uncertain` 执行停在 `reconciliation_required`，直到人工调用
  `/v1/proposals/:id/reconcile`。
- **审批超时失败安全。** 超时后做决定返回 409 `APPROVAL_TIMED_OUT`，提案关闭为
  `rejected`，恰好审计一次。
- **动作绑定。** 审批绑定其授权的精确 `{ actionType, params }`（`actionDigest`）；
  执行边界会重新校验（不一致则 409 `ACTION_BINDING_MISMATCH`）。

## 错误模型

所有错误共用一个形状：

```json
{ "error": { "code": "SCHEMA_INVALID", "message": "...", "details": [] } }
```

常见错误码：404 `*_NOT_FOUND`；403 `TENANT_MISMATCH` / `POLICY_ADMIN_REQUIRED` /
`CAPABILITY_UNSUPPORTED`；409 `POLICY_IMMUTABLE` / `APPROVAL_TIMED_OUT` /
`ACTION_BINDING_MISMATCH`；422 `SCHEMA_INVALID`。schema 校验失败的写入在任何
状态变化之前被拒绝，且永远不会被执行。

## 校验任意实现

在对接一个非参考的 OSAS 实现？用黑盒 runner 给它打分，而不是相信声称：

```bash
pnpm osas:compat -- --target https://their-deployment.example --conformance-key <k>
```

报告中的 `gateOk: true` 才是注册级门槛（见 GOVERNANCE.md 与
conformance/README.md）。