# OSAS 常见问题（FAQ）

> Open Support Agent Spec v0.2 中文常见问题解答

---

## 基础概念

### Q: OSAS 是什么？

OSAS（Open Support Agent Spec）是 Anthropic 开源的**客服 AI Agent 规范与参考实现**。它定义了一个"知道自己边界"的 AI Agent 如何：
- 提议动作（issue refund、send message 等）
- 通过策略引擎获得批准
- 执行动作并生成审计日志

核心设计原则：**模型提议 → 策略决定 → 适配器执行 → 审计解释**

### Q: OSAS 适合什么场景？

✅ **适合：**
- 电商客服自动化（退款、换货、折扣）
- SaaS 客服支持（账户管理、计费问题）
- 内部 IT 支持台（权限管理、工单处理）
- 学习 AI Agent 架构设计

❌ **不适合：**
- 金融交易决策（需更严格监管）
- 医疗诊断建议（需专业资质）
- 法律咨询服务（需人类专家）
- 关键基础设施控制（安全风险高）

### Q: v0.2 Draft 意味着什么？

当前版本是**草案阶段**，距离 v1.0 stable 还有以下差距：
- ✅ 已有 TypeScript + Python 实现
- 🔄 需要 ≥3 个独立实现（缺 1 个）
- 🔄 规范接口可能破坏性变更
- ❌ 不建议用于关键生产业务

建议在**影子模式（shadow mode）**下试用，等待 v1.0 再考虑生产部署。

---

## 安全与权限

### Q: 参考实现可以直接用于生产吗？

**不可以。** 参考实现是 **demo 级别**，需要完成以下硬化工作：

```bash
# 1. 启用 JWT 认证（禁用 demo 模式）
OSAS_AUTH_MODE=jwt
OSAS_JWKS_URL=https://your-idp.auth0.com/.well-known/jwks.json

# 2. 配置 PostgreSQL（不用内存存储）
OSAS_STORAGE=postgres
DATABASE_URL=postgres://user:pass@host:5432/osas

# 3. 设置 LLM 预算上限
OSAS_LLM_DAILY_BUDGET_USD=100.00
OSAS_LLM_CASE_BUDGET_USD=5.00

# 4. 添加速率限制（Nginx）
limit_req_zone $binary_remote_addr zone=osas:10m rate=10r/s;

# 5. 启用监控和告警（Prometheus + Grafana）
```

详见：`docs/production-playbook.md`

### Q: 如何防止模型执行危险操作？

OSAS 采用**三重保护**：

1. **权限封顶**：模型最高权限是 `request-approval`，永远无法获得 `execute` 权限
2. **策略引擎**：每个提案必须通过确定性策略评估，不依赖模型"自觉"
3. **适配器隔离**：执行层独立，模型无法直接调用后端 API

```typescript
// 模型输出的提案
{
  "actionType": "issue_refund",
  "parameters": { "amount": { "value": 100, "currency": "USD" } }
}

// 策略引擎决策
if (amount > 50 && identityStatus !== 'verified') {
  return { outcome: 'blocked', reason: 'amount_exceeds_auto_threshold' };
}

// 只有通过策略的提案才会到达适配器
```

### Q: 已知的安全漏洞有哪些？

截至 2024-10-21，依赖包存在以下漏洞（参见 `SECURITY.md`）：

| 严重性 | 组件 | 影响 | 缓解措施 |
|-------|------|------|---------|
| Critical | vitest | 开发工具 | 生产环境禁用 UI 端点 |
| Critical | proxy-addr | 运行时 | 添加 IPv4-mapped IPv6 校验 |
| High | @modelcontextprotocol/sdk | 运行时 | 审查中，考虑固定版本 |

**注意：** 大部分漏洞在开发依赖中，不影响生产运行时。

### Q: 如何审计 Agent 的操作？

每个提案、决策、执行都会生成**审计事件**，存储在 PostgreSQL：

```sql
-- 查询被拒绝的提案
SELECT 
  proposal_id,
  action_type,
  outcome_reason,
  created_at
FROM audit_events
WHERE outcome = 'blocked'
ORDER BY created_at DESC
LIMIT 100;

-- 查询高金额退款
SELECT 
  case_id,
  parameters->>'amount' as amount,
  evidence,
  outcome
FROM audit_events
WHERE action_type = 'issue_refund'
  AND (parameters->>'amount')::numeric > 100
ORDER BY created_at DESC;
```

审计日志自动脱敏 PII（邮箱、电话、body 字段）。

---

## 集成与适配

### Q: 如何对接自己的客服系统？

实现 `SupportAdapter` 接口，参考模板：

```typescript
// packages/adapter/templates/byo-adapter.template.ts
import type { SupportAdapter } from '@osas/core';

export function createMyAdapter(config: MyConfig): SupportAdapter {
  return {
    async getOrder(ctx, orderId) {
      // 调用你的订单 API
      const order = await myApi.orders.get(orderId);
      return {
        id: order.id,
        customer: { email: order.customerEmail, ... },
        totalAmount: { value: order.total, currency: 'USD' },
        status: order.status,
        createdAt: new Date(order.createdAt),
      };
    },

    async issueRefund(ctx, params) {
      // 调用你的退款 API
      const refund = await myApi.refunds.create({
        orderId: params.orderId,
        amount: params.amount.value,
        reason: params.reason,
      });
      return { refundId: refund.id, status: 'success' };
    },

    // ... 实现其他方法
  };
}
```

详见：`docs/adapter-guide.zh-CN.md`

### Q: Shadow 模式下能看到什么？

在 **Chatwoot 集成**中，shadow 模式会在会话中添加一条**私有备注**（客户看不到）：

```markdown
🤖 OSAS Shadow Proposal

Action: issue_refund
Parameters:
  - Order: #12345
  - Amount: $50.00 USD
  - Reason: customer_request

Policy Decision: ✅ auto-approved
Evidence:
  - Identity: verified (email)
  - Order history: 3 previous orders
  - Region: US

If this were live mode, the refund would be issued automatically.
[View full audit log →]
```

在**影子模式下不会真实执行动作**，只记录提案。

### Q: 为什么有订单证据还是被拦截？

常见原因：

1. **身份未验证**
   ```typescript
   // Chatwoot 网页挂件联系人默认 unverified
   identityVerification: { status: 'unverified', region: 'ZZ' }
   
   // 策略要求 verified
   if (identityStatus !== 'verified' && amount > 25) {
     return 'blocked';
   }
   ```

   **解决方案**：集成身份验证系统（OAuth、邮箱验证码等），更新联系人状态。

2. **金额超过阈值**
   ```typescript
   // 默认策略：>$50 需要人工审批
   if (amount > 50) {
     return 'request-approval';
   }
   ```

   **解决方案**：调整策略阈值或提供更多证据（订单历史、VIP 等级）。

3. **地区限制**
   ```typescript
   // 某些地区需要更严格审查
   if (region === 'ZZ' || region === 'CN') {
     return 'blocked';
   }
   ```

   **解决方案**：正确识别客户地区（从订单地址、IP 等）。

### Q: 支持哪些客服平台？

当前已实现：
- ✅ **Zendesk**（完整集成）
- ✅ **Chatwoot**（Shadow Worker 模式）
- ✅ **Shopify**（只读，获取订单信息）

计划支持：
- 🔄 **Intercom**
- 🔄 **Freshdesk**
- 🔄 **Help Scout**

欢迎社区贡献新的适配器！

---

## 部署与运维

### Q: 如何运行预检查？

```bash
# 安装依赖并构建
pnpm install
pnpm build

# 创建生产配置
cp .env.production.example .env.production
# 编辑 .env.production 填入真实值

# 运行预检脚本
./scripts/production-readiness.sh
```

**预检项目：**
- ✓ NODE_ENV=production
- ✓ JWT 认证配置
- ✓ PostgreSQL 连接
- ✓ LLM 提供商和预算
- ✓ 依赖安全漏洞扫描
- ✓ TypeScript 编译
- ✓ Webhook 密钥长度

如果所有检查通过，会显示 `✅ Production readiness check PASSED`。

### Q: 如何监控 Agent 运行状态？

API 暴露 Prometheus 指标（需实现）：

```prometheus
# 提案结果统计
osas_proposals_total{outcome="blocked|approved|executed"}

# 策略评估延迟
osas_policy_eval_duration_ms

# LLM 花费
osas_llm_cost_usd

# Token 使用量
osas_llm_tokens_total{model="fast|standard"}
```

**推荐告警规则：**

```yaml
# 高拒绝率
- alert: HighPolicyRejectionRate
  expr: rate(osas_proposals_total{outcome="blocked"}[5m]) / rate(osas_proposals_total[5m]) > 0.5
  for: 10m

# 预算接近上限
- alert: LLMBudgetNearLimit
  expr: osas_llm_cost_usd > (osas_llm_daily_budget_usd * 0.9)

# 慢策略评估
- alert: SlowPolicyEvaluation
  expr: histogram_quantile(0.95, osas_policy_eval_duration_ms) > 500
```

### Q: 数据库怎么维护？

```sql
-- 检查审计事件增长
SELECT 
  COUNT(*) as event_count,
  pg_size_pretty(pg_total_relation_size('audit_events')) as size
FROM audit_events;

-- 归档 90 天前的事件（如需长期保存，先导出到 S3/GCS）
DELETE FROM audit_events 
WHERE created_at < NOW() - INTERVAL '90 days';

-- 回收空间
VACUUM ANALYZE audit_events;

-- 查看慢查询（需启用 pg_stat_statements）
SELECT 
  query,
  calls,
  mean_exec_time,
  max_exec_time
FROM pg_stat_statements
WHERE query LIKE '%audit_events%'
ORDER BY mean_exec_time DESC
LIMIT 10;
```

**推荐备份策略：**
- 每日全量备份（pg_dump）
- 启用 WAL 归档（PITR）
- 定期测试恢复流程

### Q: 如何处理突发流量？

1. **水平扩展**
   ```yaml
   # Kubernetes
   apiVersion: autoscaling/v2
   kind: HorizontalPodAutoscaler
   spec:
     minReplicas: 3
     maxReplicas: 20
     metrics:
     - type: Resource
       resource:
         name: cpu
         target:
           type: Utilization
           averageUtilization: 70
   ```

2. **连接池调优**
   ```ini
   # PgBouncer
   default_pool_size = 25
   max_client_conn = 1000
   pool_mode = transaction
   ```

3. **速率限制**
   ```nginx
   # Nginx
   limit_req_zone $binary_remote_addr zone=osas:10m rate=10r/s;
   limit_req zone=osas burst=20 nodelay;
   ```

---

## 开发与贡献

### Q: 如何本地开发？

```bash
# 克隆仓库
git clone https://github.com/anthropics/open-support-agent-spec.git
cd open-support-agent-spec

# 安装依赖
pnpm install

# 构建所有包
pnpm build

# 运行所有测试
pnpm test

# 启动 API（demo 模式）
cd apps/api
pnpm dev

# 访问 API
curl http://localhost:3001/v1/meta/tools
```

### Q: 如何贡献独立实现？

v1.0 需要 **≥3 个独立实现**，当前缺 1 个（Java/Go/Rust）。

**要求：**
1. 通过 `@osas/compat-runner` 黑盒测试
2. `gateOk: true` 表示核心 profile 通过
3. 开源协议（Apache 2.0 或兼容）
4. 维护 ≥6 个月

**Bounty 计划（提案）：**
- $2,000 USD：首个 Go/Java/Rust 实现
- $500 USD：额外 profile（ecommerce/saas）

详见：`docs/recruitment-java.md`、`docs/recruitment-go.md`

### Q: 如何报告安全漏洞？

通过 **GitHub Security 私有报告**：

1. 前往 https://github.com/anthropics/open-support-agent-spec/security
2. 点击 "Report a vulnerability"
3. 提供详细信息（复现步骤、影响范围、建议修复）

**请勿在公开 Issue 中讨论未修复的安全漏洞。**

---

## 常见错误

### Q: `🛑 Cannot start in production with failed checks`

**原因：** 生产预检失败（缺少必需配置）

**解决：**
```bash
# 查看具体错误
NODE_ENV=production node apps/api/dist/index.js

# 常见错误修复
# 1. demo 认证被禁止
OSAS_AUTH_MODE=jwt  # 改为 jwt

# 2. 内存存储被禁止
OSAS_STORAGE=postgres  # 改为 postgres
DATABASE_URL=postgres://...

# 3. 缺少 JWT 配置
OSAS_JWKS_URL=https://...
OSAS_JWT_ISSUER=https://...
OSAS_JWT_AUDIENCE=osas-api
```

### Q: `Database connection pool exhausted`

**原因：** 并发请求超过数据库连接池大小

**解决：**
```bash
# 1. 使用 PgBouncer 连接池
# 2. 增加池大小
default_pool_size = 25  # 改为 50

# 3. 优化慢查询
SELECT * FROM pg_stat_activity WHERE state = 'active';

# 4. 水平扩展 API 实例（但控制总连接数）
```

### Q: `LLM budget exceeded`

**原因：** 超过每日或单案例 LLM 预算

**解决：**
```bash
# 1. 提高预算
OSAS_LLM_DAILY_BUDGET_USD=200.00  # 从 100 提高到 200

# 2. 查询高消耗案例
SELECT case_id, SUM(token_cost_usd) as cost
FROM usage_records
WHERE date = CURRENT_DATE
GROUP BY case_id
ORDER BY cost DESC
LIMIT 10;

# 3. 优化提示词（减少 token 使用）
# 4. 使用更便宜的模型（gpt-4o-mini）
```

---

## 路线图

### Q: 什么时候发布 v1.0？

**v1.0 准入标准：**
- [x] ≥3 个独立实现（当前 2 个）
- [x] 兼容性测试通过
- [x] 双语文档（EN + ZH）
- [ ] 多方治理委员会成立
- [ ] 第三方安全审计通过

**预计时间：** 6-12 个月

### Q: 未来功能计划？

- 🔄 **Live 执行模式**（v0.3）
- 🔄 **更多适配器**（Intercom、Freshdesk）
- 🔄 **多租户隔离增强**
- 🔄 **速率限制内置**
- 🔄 **Metrics 和 Tracing**（OpenTelemetry）
- 🔄 **可视化策略编辑器**

---

## 更多资源

- **规范文档**：`docs/spec-v0.2.md`
- **生产部署**：`docs/production-playbook.md`
- **适配器指南**：`docs/adapter-guide.zh-CN.md`
- **威胁模型**：`docs/threat-model.md`
- **架构决策**：`docs/architecture-*.md`
- **GitHub 讨论**：https://github.com/anthropics/open-support-agent-spec/discussions

---

**有其他问题？** 欢迎在 GitHub Discussions 提问或提交 Pull Request 补充本 FAQ。
