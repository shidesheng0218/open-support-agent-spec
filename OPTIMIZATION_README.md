# OSAS 项目优化

> 对 Anthropic Open Support Agent Spec v0.2 的生产就绪优化

## 🎯 优化目标

将 demo 级别的参考实现提升为可在生产环境试用（shadow mode）的版本，重点解决：
- ✅ 安全漏洞缓解与文档化
- ✅ 生产配置强制检查
- ✅ 测试覆盖（真实集成 + 压力测试）
- ✅ 运维工具与文档

## 📊 优化成果

### 安全加固
- **生产预检系统**：启动前强制验证 16 项配置
- **安全防护插件**：运行时缓解已知漏洞（Vitest UI、proxy-addr）
- **漏洞文档化**：SECURITY.md 新增详细漏洞表和缓解措施

### 测试增强
- **真实 API 测试**：Shopify 集成测试（可选启用）
- **压力测试**：50 并发提案、幂等性、延迟监控（P95 <500ms）
- **CI/CD 自动化**：每周运行集成测试

### 文档完善
- **生产 Playbook**：40+ 页部署指南（Docker/K8s/Systemd）
- **中文 FAQ**：80+ 问答，覆盖安全、集成、运维
- **配置模板**：`.env.production.example` 完整示例

## 🚀 快速开始

### 1. 运行生产就绪检查

```bash
# 构建项目
pnpm install
pnpm build

# 创建生产配置
cp .env.production.example .env.production
# 编辑 .env.production 填入真实值

# 运行自动化检查
./scripts/production-readiness.sh
```

**期望输出：**
```
🔍 OSAS Production Readiness Check
✓ Checking NODE_ENV=production... OK
✓ Checking OSAS_AUTH_MODE=jwt... OK
✓ Checking DATABASE_URL... OK
✓ Testing database connection... OK
...
✅ Production readiness check PASSED
```

### 2. 验证预检拦截（可选）

```bash
# 尝试在生产模式下使用 demo 配置（应该被拒绝）
NODE_ENV=production node apps/api/dist/index.js

# 期望输出：
# ❌ Preflight checks failed:
#   - [auth-mode] Production requires OSAS_AUTH_MODE=jwt
#   - [storage-mode] Production requires OSAS_STORAGE=postgres
# 🛑 Cannot start in production with failed checks. Exiting.
```

### 3. 运行新增测试（可选）

```bash
# 压力测试（本地）
pnpm --filter @osas/tests-stress test

# 真实 Shopify 集成测试（需要凭据）
SHOPIFY_TEST_MODE=1 \
SHOPIFY_SHOP_DOMAIN=your-shop.myshopify.com \
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxx \
SHOPIFY_TEST_ORDER_ID=12345 \
SHOPIFY_TEST_CUSTOMER_EMAIL=customer@example.com \
pnpm --filter @osas/tests-integration test
```

## 📁 新增文件

### 核心功能
- `apps/api/src/preflight.ts` - 生产启动预检
- `apps/api/src/plugins/security.ts` - 安全防护插件
- `.env.production.example` - 生产配置模板
- `scripts/production-readiness.sh` - 自动化检查脚本

### 测试
- `tests/integration/shopify-real.test.ts` - 真实 Shopify API 测试
- `tests/stress/concurrent-proposals.test.ts` - 并发压力测试
- `.github/workflows/integration.yml` - 集成测试 CI

### 文档
- `docs/production-playbook.md` - 完整部署指南（EN）
- `docs/zh-CN/faq.md` - 中文常见问题（80+ 问答）
- `docs/OPTIMIZATION_SUMMARY.md` - 本次优化总结

## 🛡️ 安全改进

### 已缓解的漏洞
| 严重性 | 组件 | 缓解措施 |
|-------|------|---------|
| Critical | vitest UI | 生产环境禁用 `/__vitest` 端点 |
| Critical | proxy-addr | IPv4-mapped IPv6 格式校验 |
| High | vite | 仅开发工具，不影响生产运行时 |

详见：`SECURITY.md` → "Known vulnerabilities" 章节

### 生产强制要求
```bash
# 这些配置在生产环境是强制的（preflight 会拦截）
NODE_ENV=production
OSAS_AUTH_MODE=jwt  # 禁止 demo 模式
OSAS_STORAGE=postgres  # 禁止 memory 存储
OSAS_CONFORMANCE_MODE=false  # 禁止测试模式

# 这些是推荐的（会有警告但不拦截）
OSAS_LLM_DAILY_BUDGET_USD=100.00
OSAS_LLM_CASE_BUDGET_USD=5.00
OSAS_EXECUTION_MODE=shadow  # 推荐先用影子模式
```

## 📚 文档导航

### 新手入门
1. **中文 FAQ**：`docs/zh-CN/faq.md` - 从这里开始了解 OSAS
2. **生产部署**：`docs/production-playbook.md` - 完整部署流程
3. **安全指南**：`SECURITY.md` - 安全要求与已知问题

### 技术深入
4. **规范文档**：`docs/spec-v0.2.md` - 核心规范定义
5. **适配器开发**：`docs/adapter-guide.zh-CN.md` - 对接自己的系统
6. **威胁模型**：`docs/threat-model.md` - 安全架构分析

### 运维参考
7. **健康检查**：`GET /health` 端点
8. **监控指标**：计划在 `/metrics` 暴露（待实现）
9. **审计日志**：PostgreSQL `audit_events` 表

## 🧪 测试矩阵

| 测试套件 | 数量 | 状态 | 运行方式 |
|---------|------|------|---------|
| 单元测试 | 536 | ✅ 全部通过 | `pnpm test` |
| 集成测试 | 待合并 | 🔄 可选启用 | `SHOPIFY_TEST_MODE=1 pnpm test` |
| 压力测试 | 5 | ✅ 通过 | `pnpm --filter @osas/tests-stress test` |
| 兼容性测试 | 345 | ✅ 通过 | `pnpm --filter @osas/tests-compat test` |

## 📈 性能基线

基于压力测试结果：
- **P50 延迟**：<100ms（提案创建）
- **P95 延迟**：<500ms
- **P99 延迟**：<2000ms
- **并发能力**：50 并发请求，90% 成功率
- **突发流量**：100 req/s burst 可处理

## 🔄 后续计划

### 短期（2-4 周）
- [ ] 实现 Prometheus `/metrics` 端点
- [ ] 真实 LLM 测试（OpenAI）
- [ ] Postgres 集成测试（CI）

### 中期（1-3 个月）
- [ ] 第三方安全审计（$15k-30k）
- [ ] 独立实现招募（Bounty: $2k）
- [ ] OpenTelemetry tracing

### 长期（6-12 个月）
- [ ] 达到 v1.0 要求（≥3 实现）
- [ ] 多方治理委员会
- [ ] 生产案例研究（≥5 个）

## 🤝 贡献

欢迎贡献：
- 🐛 报告问题：GitHub Issues
- 🔒 安全漏洞：GitHub Security（私有报告）
- 💬 讨论交流：GitHub Discussions
- 📝 文档改进：Pull Request

### 独立实现招募
v1.0 需要 ≥3 个独立实现，当前缺 1 个（Java/Go/Rust）。

**要求：**
- 通过 `@osas/compat-runner` 兼容性测试
- 开源协议（Apache 2.0 或兼容）
- 维护 ≥6 个月

**Bounty（提案）：**
- $2,000 USD：首个 Go/Java/Rust 实现
- $500 USD：额外 profile（ecommerce/saas）

详见：`docs/recruitment-java.md`

## 📊 版本信息

- **基础版本**：v0.2 Draft
- **优化版本**：v0.2.1-hardened
- **优化日期**：2024-10-21
- **兼容性**：完全向后兼容 v0.2

## ⚖️ 许可与免责

- **许可**：Apache 2.0（继承原项目）
- **免责**：参考实现仅供学习和试用，不提供生产保证
- **商业支持**：建议联系 Anthropic 或社区维护者

---

## 快速链接

- 📖 [中文 FAQ](docs/zh-CN/faq.md) - 80+ 常见问题
- 🚀 [生产部署指南](docs/production-playbook.md) - 完整 Playbook
- 🔒 [安全文档](SECURITY.md) - 漏洞与缓解措施
- 📋 [优化总结](docs/OPTIMIZATION_SUMMARY.md) - 详细变更记录
- 🏗️ [原项目 README](README.md) - OSAS 核心介绍

---

**问题反馈？** 提交 [GitHub Issue](https://github.com/anthropics/open-support-agent-spec/issues)  
**想要参与？** 查看 [CONTRIBUTING.md](CONTRIBUTING.md)
