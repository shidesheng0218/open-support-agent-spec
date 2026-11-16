# P0-1 路由授权修复总结

## 修改的文件

- `apps/api/src/routes/approvals.ts`
- `apps/api/src/routes/proposals.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/handoffs.ts`
- `SHADOW_MVP_CHECKLIST.md`（新增）

## 修复的问题

### 1. 审批路由授权缺口（高危）

**问题**：
- `POST /v1/approvals/:id/decide` 没有角色检查
- `approverId` 来自请求体，未绑定到已认证主体
- 任何角色（包括 `auditor`）都能批准提案并触发 sandbox 执行

**修复**：
- 添加 `requireRole(req, "policy_admin")` 检查
- `approverId` 现在从 `principal.actorId` 取，移除请求体参数
- 更新请求 schema：`{ decision: "approved" | "rejected", comment?: string }`

### 2. 提案创建授权缺口

**问题**：
- `POST /v1/proposals` 没有角色检查
- 任何角色都能创建提案

**修复**：
- 添加 `requireRole(req, "policy_admin", "support_agent")` 检查

### 3. Chat 路由授权缺口

**问题**：
- `POST /v1/chat` 没有角色检查
- 任何角色都能触发模型调用和提案创建

**修复**：
- 添加 `requireRole(req, "support_agent", "policy_admin")` 检查

### 4. 接管路由授权缺口

**问题**：
- `POST /v1/handoffs/:id/claim` 和 `/resolve` 没有角色检查

**修复**：
- 添加 `requireRole(req, "support_agent", "policy_admin")` 检查

## 验证

### 类型检查
```bash
$ pnpm typecheck
✓ All 24 workspace projects passed
```

### 功能验证（建议手动测试）

```bash
# 用 auditor 角色尝试批准提案（应返回 403）
curl -X POST http://localhost:3001/v1/approvals/appr_xxx/decide \
  -H "x-osas-role: auditor" \
  -H "x-osas-tenant: tenant_demo" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approved"}'
# 预期: {"error":{"code":"FORBIDDEN",...}}

# 用 policy_admin 角色批准提案（应成功）
curl -X POST http://localhost:3001/v1/approvals/appr_xxx/decide \
  -H "x-osas-role: policy_admin" \
  -H "x-osas-actor: approver_alice" \
  -H "x-osas-tenant: tenant_demo" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approved","comment":"Approved after review"}'
# 预期: {"approval":{...,"approverId":"approver_alice",...}}
```

## 影响范围

### Shadow 模式
- **修复前**：`auditor` 可以批准提案，污染审批记录和审计链
- **修复后**：只有 `policy_admin` 可以批准；审批人 ID 来自已认证主体，可信且可追溯

### Sandbox 模式
- **修复前**：`auditor` 可以触发合成执行
- **修复后**：只有 `policy_admin` 可以批准并触发执行

### Live 模式（项目默认禁用）
- 如果未来启用，此修复能防止低权限角色触发真实写操作

## 后续工作

参见 `SHADOW_MVP_CHECKLIST.md`：
- P0-3：持久化边界（实现或文档化）
- P0-4：审计链重启修复（实现或文档化）
- P0-2/P0-5：可延后到 sandbox 之前

## 测试建议

1. 单元测试（建议补充）：
   - 测试 `auditor` 调用 `/v1/approvals/:id/decide` 返回 403
   - 测试 `policy_admin` 调用成功且 `approverId` 正确
   - 测试 `support_agent` 可以调用 `/v1/chat` 和 `/v1/proposals`

2. 集成测试：
   - 启动 API，用不同角色调用受保护路由
   - 验证审批人 ID 出现在审计事件中

3. E2E 测试：
   - Chatwoot webhook → shadow worker → 提案 → 审批 → ShadowRun
   - 验证整个流程的角色检查
