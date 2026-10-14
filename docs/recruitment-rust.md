# 招募：Rust 语言 OSAS 实现维护者

## 🎯 目标

我们正在寻找独立维护者来实现 OSAS 的 Rust 语言版本，以推进 v1.0 多方治理目标（需要 ≥3 个独立实现）。

## 🎁 你将获得什么

- **治理席位**：按 [GOVERNANCE.md](../GOVERNANCE.md)，通过独立实现的组织在 v1.0 获得正式治理席位（具体构成将由 RFC 在 v1.0 前确定）
- **技术领导力**：塑造 AI Agent 安全规范的未来
- **注册表登记**：通过后登记在 `conformance/implementations.json`
- **完整工具链**：7 天教程、测试向量、兼容性测试器已就绪

## 📋 要求

### 技术要求
- 熟练掌握 Rust（async/await、error handling）
- 了解 JSON Schema 验证（推荐 `jsonschema` crate）
- HTTP 服务开发经验（推荐 `axum` 或 `actix-web`）
- 理解哈希链和策略引擎概念（教程中会详细说明）

### 独立性要求
- 不同于 OSAS 规范维护者的组织/个人
- 独立的 GitHub 仓库（如 `yourorg/osas-rust`）
- 持续维护承诺（保持与规范版本同步）

### 时间投入
- **初始实现**：粗略估计 1-2 周（未经第三方验证）
- **维护**：需跟随规范更新保持兼容（工作量取决于规范变更）

## 🚀 实现路径

### Week 1: Core Implementation（按 7 天教程）
```
Day 1: HTTP 框架 + 发现端点
  选择框架：axum (推荐，Tower 生态) 或 actix-web
  /.well-known/osas
  /v1/capabilities
  /v1/meta/tools
  /v1/schemas/*

Day 2: Schema 验证
  集成 jsonschema crate
  /v1/validate 端点
  
Day 3: 策略引擎（核心算法）
  evaluate_proposal() 确定性实现
  使用 policy-evaluation.json 测试向量验证
  
Day 4: 审计链
  SHA-256 (sha2 crate) + stable-json 排序
  使用 audit-chain.json 测试向量验证
  
Day 5: 策略生命周期
  draft → approved → active → retired
  RBAC 检查
  
Day 6: 执行引擎
  幂等性（tenantId + idempotencyKey）
  sandbox 模式
  
Day 7: 兼容性测试
  运行 @osas/compat-runner
  修复直到 gateOk: true
```

### Week 2: Polish & Submit
- 添加 README 和文档
- 设置 CI（GitHub Actions + conformance tests）
- 提交兼容性声明（此仓库的 Issue）

## 📚 资源

### 必读
- [7 天实现教程（中文）](../../docs/implementing-osas-7days.zh-CN.md)
- [实现者自检清单](../../docs/implementer-checklist.zh-CN.md)
- [OpenAPI 规范](../../docs/openapi-v0.2.json)

### 测试向量（跨语言）
- [stable-json.json](../../conformance/test-vectors/stable-json.json) - 键排序序列化
- [audit-chain.json](../../conformance/test-vectors/audit-chain.json) - 哈希链验证
- [policy-evaluation.json](../../conformance/test-vectors/policy-evaluation.json) - 策略决策

### 工具
- [兼容性测试器](../../packages/compat-runner/) - 黑盒 HTTP 测试
- [JSON Schemas](../../schemas/) - 权威 schema 定义

### Rust 推荐 Crates
```toml
[dependencies]
# HTTP 框架
axum = "0.7"              # 推荐：Tower 生态，类型安全
tokio = { version = "1", features = ["full"] }
tower = "0.4"

# 或者
actix-web = "4"           # 备选：成熟稳定

# JSON Schema 验证
jsonschema = "0.17"       # draft 2020-12 支持

# 序列化
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# 哈希
sha2 = "0.10"

# 日期时间
chrono = { version = "0.4", features = ["serde"] }
```

## 🤝 支持

我们将提供：
- 实现过程中的技术答疑（GitHub Issues；本仓库未开启 Discussions）
- 审查和反馈（PR review）
- 兼容性测试支持

## ✅ 成功标准

1. **功能完整**：通过兼容性测试 `gateOk: true`（零跳过检查）
2. **独立性**：不同组织维护，独立仓库
3. **文档**：README + 基本使用说明
4. **CI**：自动运行兼容性测试
5. **开源**：Apache-2.0 或 MIT 许可证

## 🎯 Rust 特别优势

Rust 实现可以突出以下优势：
- **类型安全**：编译时捕获策略引擎逻辑错误
- **零成本抽象**：高性能策略评估（关键路径）
- **内存安全**：无 GC 停顿，适合高吞吐场景
- **并发安全**：Fearless concurrency 避免数据竞争

## 📞 如何参与

**有兴趣？** 在此 Issue 下留言，包括：
- 你的背景（Rust 经验、AI/LLM 经验）
- 组织/个人身份
- 预计时间线
- 任何问题或需要的支持

**或者** 使用 [Maintainer Interest 模板](../.github/ISSUE_TEMPLATE/maintainer-interest.yml) 提交正式申请。

---

**标签**：`help-wanted` `good-first-issue` `language:rust` `v1.0-gate`
