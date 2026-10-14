# OSAS v0.2 实现工具链就绪公告

> **面向：** 开源社区、AI 开发者、电商/SaaS 平台工程师

## 🎯 TL;DR

[Open Support Agent Spec (OSAS)](https://github.com/shidesheng0218/open-support-agent-spec) v0.2 现已具备完整的第三方实现工具链：

- ✅ **7 天实现教程** - 从零开始的分步指南
- ✅ **跨语言测试向量** - JSON 格式的黄金标准测试用例
- ✅ **黑盒兼容性测试器** - HTTP 级别的自动化验证工具
- ✅ **静态 OpenAPI 规范** - 导入任何工具无需运行代码
- ✅ **Python 参考实现** - 约 1566 行，通过黑盒兼容性测试（同组织，不计入独立实现）

**我们需要你的帮助：** 寻找 ≥3 个独立组织实现 OSAS，解锁 v1.0 多方治理模型。

---

## 🤔 OSAS 是什么？

Open Support Agent Spec 是一个开放规范，用于在客户支持场景中**安全地部署 AI Agent**。它不是聊天机器人产品，而是一套协议，定义了：

- **确定性策略引擎** - LLM 提议，策略引擎决策，适配器执行
- **权限梯度** - `read < draft < request-approval < execute`（模型上限 request-approval）
- **审计链** - SHA-256 哈希链，每个操作可验证
- **受控执行模式** - `proposal_only`、`shadow`、`sandbox`、`live`

**核心价值：** 在 LLM 提议和财务/风险写操作之间增加确定性策略门控。

---

## 📦 新发布的工具链

### 1. 7 天实现教程（662 行）

[`docs/implementing-osas-7days.zh-CN.md`](../implementing-osas-7days.zh-CN.md)

从零开始的分步指南，覆盖：
- Day 1-2: HTTP 框架 + 发现端点
- Day 3: Schema 验证
- Day 4: 策略引擎（核心算法）
- Day 5: 审计链
- Day 6: 执行引擎
- Day 7: 兼容性测试

**目标受众：** Go/Rust/Java/Python 开发者，无需预先了解 OSAS

### 2. 跨语言测试向量（19 个场景）

[`conformance/test-vectors/`](../conformance/test-vectors/)

三类黄金标准测试：
- **stable-json**: 11 个序列化测试（键排序、嵌套、Unicode 等）
- **audit-chain**: 3 个哈希链场景（单事件、三事件链、篡改）
- **policy-evaluation**: 5 个策略决策测试（auto_execute / require_approval / block）

**格式：** 纯 JSON，所有语言可用，由权威实现生成并验证

### 3. 兼容性测试器（黑盒 HTTP）

[`packages/compat-runner/`](../packages/compat-runner/)

```bash
# 完整测试套件（只读 + 状态写入）
pnpm osas:compat -- --target http://localhost:8080 --conformance-key <test-only-key>

# 输出机器可读报告
pnpm osas:compat -- --target http://localhost:8080 --out report.json

# 详细模式（请求/响应调试）
pnpm osas:compat -- --target http://localhost:8080 --verbose
```

**关键特性：**
- 零依赖目标实现代码（仅 HTTP）
- 退出码 0 = 通过，1 = 失败，2 = 用法错误
- `gateOk: true` 要求零跳过检查（注册门槛）

### 4. 静态 OpenAPI 规范（124KB）

[`docs/openapi-v0.2.json`](../openapi-v0.2.json)

从权威 JSON Schema 生成，包含：
- 56 个端点路径
- 25 个完整 schema 定义
- 可导入 Postman/Insomnia/Swagger UI

### 5. 实现者自检清单（80+ 项）

[`docs/implementer-checklist.zh-CN.md`](../implementer-checklist.zh-CN.md)

覆盖：
- HTTP 框架选择标准
- Schema 验证器集成
- 策略引擎算法正确性
- 审计链哈希计算
- 幂等性和并发安全
- 兼容性测试通过标准

---

## 🚀 如何参与

### 实现 OSAS（任何语言）

1. **阅读教程：** [`implementing-osas-7days.zh-CN.md`](../implementing-osas-7days.zh-CN.md)
2. **导入 OpenAPI：** [`openapi-v0.2.json`](../openapi-v0.2.json)
3. **使用测试向量：** [`conformance/test-vectors/`](../conformance/test-vectors/)
4. **运行兼容性测试器：** `pnpm osas:compat -- --target <你的实现>`
5. **提交兼容性声明：** 在仓库提 issue，附上 `report.json`

### 采纳 Python 参考实现

[`implementations/python-reference/`](../implementations/python-reference/)

- ✅ 1566 行完整实现
- ✅ 通过所有兼容性测试（`gateOk: true`）
- ✅ 零外部 API 依赖
- ✅ 确定性 Sandbox 执行

**寻找独立维护者：** 转移到独立仓库 + 独立组织维护 → 计入 v1.0 门槛

### 帮助推广

- 在你的社区分享此公告
- 在 Twitter/Reddit/HN 讨论 AI Agent 安全部署
- 提出改进建议（GitHub Issues）

---

## 🎯 v1.0 路线图

### 当前状态：v0.2.1 Draft

- ⚠️ 规范仍为 Draft（v0.x 任何 minor 版本都可能 breaking）
- ✅ 参考实现通过所有测试
- ✅ 工具链完整
- ⚠️ 仅 2 个实现（同一组织）
- ⚠️ 0 个生产部署

### v1.0 准入门槛

1. **≥3 个独立实现** - 不同组织维护，通过 `gateOk: true`
2. **规范双语同步** - 英文 + 中文同步维护
3. **无阻塞 RFC** - 所有已接受的 RFC 都已实现

### v1.0 治理模型

- 独立实现维护者获得正式治理席位
- 具体构成由 v1.0 前的 RFC 确定
- 详见 [`GOVERNANCE.md`](../GOVERNANCE.md)

---

## 📊 项目统计

```
语言:        TypeScript (核心), Python (参考实现)
代码规模:    ~40,870 行 TS/TSX, ~1,566 行 Python
Schemas:     54 个 JSON Schema (draft 2020-12)
文档:        85 个 Markdown 文件
RFC:         12 个提案
许可证:      Apache-2.0
```

---

## 🔗 资源链接

- **仓库：** https://github.com/shidesheng0218/open-support-agent-spec
- **规范文档：** [`docs/spec-v0.2.zh-CN.md`](../spec-v0.2.zh-CN.md)
- **7 天教程：** [`docs/implementing-osas-7days.zh-CN.md`](../implementing-osas-7days.zh-CN.md)
- **兼容性测试器：** [`packages/compat-runner/`](../packages/compat-runner/)
- **测试向量：** [`conformance/test-vectors/`](../conformance/test-vectors/)
- **OpenAPI 规范：** [`docs/openapi-v0.2.json`](../openapi-v0.2.json)

---

## 💡 常见问题

### Q: OSAS 与 LangChain/AutoGPT 有什么不同？

A: LangChain 是工具编排框架，AutoGPT 是自主代理。OSAS 是**治理规范**，定义策略引擎如何控制 Agent 行为。你可以用 LangChain 构建 Agent，然后用 OSAS 控制其权限。

### Q: 为什么需要独立实现？

A: 多方实现证明规范的中立性和可实施性。v1.0 治理模型要求实现者参与决策，防止单一厂商控制。

### Q: Python 实现可以直接用于生产吗？

A: 目前没有生产部署。参考实现的 live 执行在启动时被禁用，适配器为只读。

### Q: 如何贡献代码？

A: 阅读 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。破坏性变更需要先提 RFC。

### Q: 有商业支持吗？

A: 这是社区驱动的开源项目，目前无官方商业支持。欢迎服务提供商基于 OSAS 提供商业服务。

---

## 🙏 致谢

感谢所有贡献者、RFC 作者和早期测试者。特别感谢：

- 所有提交 issue 和 PR 的社区成员

---

**立即开始：** [`docs/implementing-osas-7days.zh-CN.md`](../implementing-osas-7days.zh-CN.md)

**有问题？** 在 [GitHub Issues](https://github.com/shidesheng0218/open-support-agent-spec/issues) 提问
