# 最小可行 Shadow 配置清单

**目标**：在不执行任何真实写操作的前提下，记录模型建议、策略决策与审批流程，用于准确率评估和策略校准。

**已完成**：P0-1 路由授权修复（见本次提交）

---

## 一、必须完成（Shadow 也会被污染）

### ✅ 1. P0-1 路由授权与审批人绑定（已修复）

**修复内容**：
- `apps/api/src/routes/approvals.ts:48-60`：`POST /v1/approvals/:id/decide` 现在要求 `policy_admin` 角色，`approverId` 从已认证主体取，不再信任请求体
- `apps/api/src/routes/proposals.ts:35-37`：`POST /v1/proposals` 要求 `policy_admin` 或 `support_agent` 角色
- `apps/api/src/routes/chat.ts:165-167`：`POST /v1/chat` 要求 `support_agent` 或 `policy_admin` 角色
- `apps/api/src/routes/handoffs.ts:16-29`：`POST /v1/handoffs/:id/claim` 和 `/resolve` 要求 `support_agent` 或 `policy_admin` 角色

**验证方式**：
```bash
# 用 auditor 角色尝试批准提案应返回 403
curl -X POST http://localhost:3001/v1/approvals/appr_xxx/decide \
  -H "x-osas-role: auditor" \
  -H "x-osas-tenant: tenant_demo" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approved"}'
# 预期: {"error":{"code":"FORBIDDEN",...}}
```

### 2. P0-3 持久化边界（二选一）

**方案 A：实现 Postgres SupportAdapter**（推荐，但工作量大）
- 创建 `packages/store-postgres/src/support-adapter.ts`
- 实现 `proposals/approvals/evidence/cases/customers/handoffs` 的 CRUD
- 使用现有 `store-postgres` 包的 pool 和迁移
- 在 `apps/api/src/app.ts:141-143` 根据 `OSAS_STORAGE=postgres` 选择适配器

**方案 B：明确文档边界**（快速，但接受重启风险）
- 在 `README.md`、`docker-compose.yml.example`、启动日志中添加：
  ```
  警告：当前 Postgres 模式仅持久化执行账本、策略版本、审计镜像、
  治理控制面、ShadowRun 和模型用量。
  提案、审批、证据、工单、客户、接管和售后案例仍保存在进程内存中，
  重启后丢失。生产部署前需实现持久化适配器。
  ```
- 在 `apps/api/src/index.ts` 启动时打印：
  ```typescript
  if (storageMode === 'postgres' && adapter instanceof MockSupportAdapter) {
    logger.warn('⚠️  Postgres mode: execution/policy/governance persistent, proposals/approvals IN MEMORY');
  }
  ```

**快速验证**：
```bash
# 启动 API
OSAS_STORAGE=postgres DATABASE_URL=postgres://... pnpm start:api
# 创建提案 → 重启 → 尝试 GET /v1/proposals → 应返回空（方案B）或原记录（方案A）
```

### 3. P0-4 审计链重启修复

**修复内容**（`packages/policy-engine/src/audit-chain.ts` 或 `packages/mock-backend/src/mock-adapter.ts`）：
```typescript
// 在适配器启动时，如果 auditStore 是 Postgres，从数据库 hydrate 链头
async function hydrateAuditChainHeads(
  store: PostgresAuditStore,
  tenantIds: string[]
): Promise<Map<string, { sequence: number; previousHash: string }>> {
  const heads = new Map();
  for (const tenantId of tenantIds) {
    const latest = await store.getLatestEvent(tenantId);
    if (latest) {
      heads.set(tenantId, {
        sequence: latest.sequence,
        previousHash: latest.hash
      });
    }
  }
  return heads;
}
```

**或简化方案**（如果暂不修改 MockAdapter）：
- 在 `apps/api/src/app.ts` 启动日志警告：
  ```
  ⚠️  审计链在进程内存，重启后 sequence 从 1 开始。
  /v1/audit/verify 读取内存链头，无法验证 Postgres 镜像完整性。
  ```

---

## 二、可延后（不影响 Shadow 试点）

### 4. P0-2 证据语义绑定

**影响**：Shadow 模式下证据缺失会导致策略 `block`，但不影响真实数据安全。你可以先积累"策略认为证据不足"的案例，人工复盘后再补充绑定逻辑。

**延后依据**：
- 当前 Chatwoot 可选 Shopify 证据只检查邮箱匹配，不检查可退余额、订单归属、币种
- `apps/api/src/routes/chat.ts:57-116` 的自动捕获证据未校验语义
- Shadow 不写真实退款，因此不会造成资金风险

**何时必须做**：进入 sandbox 模式（合成执行）之前。

### 5. P0-5 依赖漏洞

**当前漏洞**：
- 1 critical：proxy-addr 2.0.7（IPv6 trust 绕过）
- 6 high：MCP SDK 1.30.0（OAuth/tasks/memory）、zod 4.5.4、body-parser 2.3.0

**延后依据**：
- API 不对公网暴露，仅内网/VPN 访问
- 不使用 MCP HTTP server（stdio 不受影响）
- 不使用受影响的 Express 反向代理特性

**修复方式**（公网试点前必须完成）：
```bash
# 升级受影响依赖
pnpm add @modelcontextprotocol/sdk@^1.32.0 zod@^4.6.6
pnpm add body-parser@^2.4.0 proxy-addr@^2.0.8
pnpm audit --prod
```

---

## 三、Shadow 配置与启动

### 环境变量配置

```bash
# .env.shadow
NODE_ENV=development
PORT=3001

# 执行模式：shadow（记录不执行）
OSAS_EXECUTION_MODE=shadow

# 认证：JWT 或 demo
OSAS_AUTH_MODE=jwt  # 或 demo（仅内网测试）
OSAS_JWKS_URL=https://YOUR_IDP/.well-known/jwks.json
OSAS_JWT_ISSUER=https://YOUR_IDP/
OSAS_JWT_AUDIENCE=osas-api

# 存储：postgres（推荐）或 memory（接受重启丢失）
OSAS_STORAGE=postgres
DATABASE_URL=postgres://osas:PASSWORD@localhost:5432/osas

# 不加载演示数据
SEED_DEMO=false

# 模型：真实或 mock
OSAS_LLM_PROVIDER=openai-compatible  # 或 mock
OSAS_LLM_BASE_URL=https://YOUR_LLM_ENDPOINT/v1
OSAS_LLM_API_KEY=sk-...
OSAS_LLM_MODEL_FAST=gpt-4o-mini
OSAS_LLM_MODEL_STANDARD=gpt-4o
OSAS_LLM_INPUT_USD_PER_MTOKEN=0.15
OSAS_LLM_OUTPUT_USD_PER_MTOKEN=0.60
OSAS_LLM_DAILY_BUDGET_USD=10
OSAS_LLM_CASE_BUDGET_USD=0.50

# 渠道集成（可选）
# Zendesk 只读
OSAS_ZENDESK_ENABLED=true
OSAS_ZENDESK_SUBDOMAIN=your-subdomain
OSAS_ZENDESK_EMAIL=agent@example.com
OSAS_ZENDESK_API_TOKEN=...

# 或 Chatwoot shadow worker
OSAS_GOVERNANCE_EVENT_CONSUMER=chatwoot-shadow
CHATWOOT_BASE_URL=https://app.chatwoot.com
CHATWOOT_ACCOUNT_ID=123
CHATWOOT_API_TOKEN=...
OSAS_CHATWOOT_WEBHOOK_SECRET_TENANT_DEMO__CONN_XXX=长度≥16的随机字符串

# 可选 Shopify 只读证据
SHOPIFY_SHOP_DOMAIN=your-shop.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_...

# Slack 审批卡片（可选）
OSAS_SLACK_BOT_TOKEN=xoxb-...
OSAS_SLACK_SIGNING_SECRET=...
OSAS_SLACK_CHANNEL_ID=C...
OSAS_SLACK_APPROVERS=U123:tenant_demo:approver_alice,U456:tenant_demo:approver_bob
```

### 启动步骤

```bash
# 1. 数据库迁移（如果用 postgres）
pnpm db:migrate

# 2. 启动 API
pnpm start:api

# 3. 验证健康检查
curl http://localhost:3001/health
# 预期: {"status":"ok","specVersion":"0.2.0","version":"0.2.1"}

# 4. 验证执行模式
curl http://localhost:3001/.well-known/osas
# 预期: {"executionMode":"shadow",...}
```

### Shadow 试点工作流

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 真实客户消息 → Zendesk/Chatwoot                          │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Webhook → Governance Inbox → Chatwoot Shadow Worker      │
│    或 手动 POST /v1/chat                                     │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. ModelGateway.complete() → ActionProposal                 │
│    注入检测 → 可疑直接 handoff，不调用策略引擎              │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. evaluateProposal() → PolicyDecision                      │
│    - block → 记录 reason codes + HumanHandoff               │
│    - require_approval → 创建 Approval                       │
│    - auto_execute → ⚠️ shadow 不执行，只记录"本来会做"       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. ShadowRun 记录                                           │
│    - wouldAutoExecute: true/false                           │
│    - decision / reasons / evidence                          │
│    - humanReview: accept / modify / reject / pending        │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. 人工复盘（每天/每周）                                     │
│    GET /v1/shadow/runs?tenantId=...&status=pending          │
│    - 模型建议是否正确？                                      │
│    - 策略 reason codes 是否合理？                           │
│    - 证据是否充分？                                         │
│    POST /v1/shadow/runs/:id/review                          │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. 积累校准数据                                             │
│    - 准确率：accept / (accept + modify + reject)           │
│    - 误拦截率：reject 中实际应通过的比例                    │
│    - 策略调整：修改 TenantPolicy 规则、金额阈值、证据要求    │
└─────────────────────────────────────────────────────────────┘
```

---

## 四、验收标准

### Shadow 试点可以开始的条件

- [x] P0-1 路由授权修复已部署，typecheck 通过
- [ ] P0-3 持久化边界已实现（方案A）或已明确文档化（方案B）
- [ ] P0-4 审计链重启已修复或已文档化风险
- [ ] 环境变量配置完成，`OSAS_EXECUTION_MODE=shadow`
- [ ] 数据库迁移完成（如果用 postgres）
- [ ] 健康检查返回 `"executionMode":"shadow"`
- [ ] 至少一个真实渠道（Zendesk 或 Chatwoot）配置完成
- [ ] 人工复盘流程已设计（每天/每周查看 ShadowRun）

### Shadow 试点成功的指标

**准确率目标**（建议运行 2-4 周后评估）：
- 模型建议准确率 ≥ 80%（人工复盘标记为 `accept` 的比例）
- 策略误拦截率 ≤ 10%（`block` 中实际应通过的比例）
- 审批响应时间中位数 ≤ 2 小时（require_approval → 人工决定）

**达标后才考虑**：
- 进入 sandbox 模式（合成执行，非真实写操作）
- 补充 P0-2 证据语义绑定
- 补充 P0-5 依赖漏洞修复
- 真实 Shopify/Stripe/支付渠道集成（需要 live 模式，目前该模式被项目禁用）

---

## 五、常见问题

### Q1: Shadow 和 Sandbox 的区别？
- **Shadow**：模型建议 + 策略评估 + 审批流程全真实，但**绝不调用适配器的 executeAction**，只记录"本来会做什么"到 ShadowRun。
- **Sandbox**：会调用 `SandboxSupportAdapter.executeAction()`，返回合成的成功/失败，适用于测试幂等/对账逻辑，但仍**不写真实退款/额度/订单**。

### Q2: 为什么 P0-2 证据绑定可以延后？
Shadow 不执行真实写操作，证据不足只会导致策略 `block`，不会造成资金风险。你可以先积累"策略认为证据不足但人工判断实际充分"的案例，用于校准证据规则，再实现绑定逻辑。

### Q3: 如果我只有 Zendesk，没有 Chatwoot，怎么做 Shadow？
Zendesk 没有 stock webhook worker，你需要：
1. 自己实现 Zendesk webhook handler（参考 `apps/api/src/webhooks/chatwoot.ts`）
2. 或用 `POST /v1/chat` 手动提交工单消息，模拟客户请求
3. 或写一个定时任务，每 5 分钟查询 Zendesk 新工单，调用 `/v1/chat`

### Q4: 控制台显示"Approve & execute"，Shadow 会执行吗？
不会。`apps/web/src/pages/Agent.tsx:104-106` 的按钮文本是误导性的；实际执行逻辑在 `apps/api/src/routes/approvals.ts:129-162`，只有 `app.executionMode.mode === "sandbox"` 才调用 `runExecution()`。Shadow 模式下，审批只会更新 `proposal.status = "approved"`，不会调用适配器。

### Q5: 重启后审计链会断吗？
**当前会**。`MockSupportAdapter` 的链头在进程内存，重启后 `sequence` 从 1 开始，可能与 Postgres 镜像里的 `(tenantId, sequence)` 冲突。P0-4 修复或文档化风险后，你可以选择：
- 方案 A：实现 hydrate，启动时从 Postgres 读取每个租户的最新 sequence/hash
- 方案 B：接受审计链重启断裂，在运维文档中标注"重启后审计 sequence 从 1 开始，/v1/audit/verify 仅验证本次运行的事件"

---

## 六、下一步

1. **立即验证 P0-1 修复**：
   ```bash
   cd /Users/eastbuy/Documents/出海going/a社开源agent/open-support-agent-spec
   pnpm typecheck  # 应全部通过
   pnpm --filter @osas/api run test  # 验证授权测试
   ```

2. **选择 P0-3 方案**：
   - 方案 A（实现 Postgres SupportAdapter）：工作量约 2-3 天，但彻底解决持久化问题
   - 方案 B（文档化边界）：工作量约 2 小时，但接受重启丢失提案/审批

3. **选择 P0-4 方案**：
   - 实现 hydrate：工作量约 4 小时
   - 文档化风险：工作量约 1 小时

4. **配置环境变量**：复制本清单的"环境变量配置"，填写你的 IDP、数据库、LLM、渠道凭证

5. **启动并验证**：
   ```bash
   pnpm db:migrate  # 如果用 postgres
   pnpm start:api
   curl http://localhost:3001/.well-known/osas | jq '.executionMode'
   # 应返回 "shadow"
   ```

6. **设计人工复盘流程**：
   - 每天/每周定时查看 `GET /v1/shadow/runs?status=pending`
   - 对照真实工单，标记 `accept/modify/reject`
   - 记录误拦截/漏放案例，用于策略调整

7. **运行 2-4 周后评估准确率**，达标后再考虑进入 sandbox 或补充 P0-2/P0-5。

---

**总结**：当前 P0-1 已修复，P0-3/P0-4 需要你选择快速方案（文档化）或完整方案（代码实现），P0-2/P0-5 可延后到 sandbox 之前。Shadow 试点的核心价值是**积累真实准确率数据**，而不是追求完美的持久化或证据校验——那些是进入 sandbox/live 之前的门槛。
