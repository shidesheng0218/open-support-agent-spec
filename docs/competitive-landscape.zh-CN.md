# 竞品格局：OSAS 的位置

[English](competitive-landscape.md)

> 本文信息基于 **2026-09** 的联网调研快照。Agent 治理领域变化很快，对外引用
> 前请先核对文末列出的原始来源。

OSAS（Open Support Agent Spec）是面向客服 agent 的**治理优先开放规范**：
模型提议、确定性策略引擎决定、适配器执行、审计日志解释。本文梳理周边格局——
谁在做什么、OSAS 的差异化在哪里、风险在哪里。

## 市场的三个层次

### 1. 协议层——解决 agent 如何通信，而非如何被治理

- **MCP（Model Context Protocol）**——已捐赠给 Linux 基金会；2026-07-28 修订
  引入了 MRTR（Multi-Round-Trip Requests，取代 elicitation/sampling）与显式的
  server 无状态化要求。
  MCP 标准化的是模型与工具之间的*能力发现与工具调用*，刻意**不**包含执行决策层：
  MCP 中没有任何机制决定一笔退款可以自动执行、需要审批还是必须阻断。OSAS 与之
  互补——可以作为 MCP 之上的治理 profile 存在（见
  [RFC 0002](../rfcs/0002-osas-as-mcp-governance-profile.md)）。
- **A2A（Agent2Agent）v1.0**——规范 *agent ↔ agent* 的消息与任务委派。与 OSAS
  相邻：接触客户数据的 A2A agent 底层仍需要一层治理与审计。
- **IBM ACP 与 Cisco AGNTCY**——两个项目均已停更或归档，并入 A2A 方向，说明
  协议层的竞争整合速度极快。

### 2. 产品层——能力强但黑盒

- **Sierra、Intercom Fin、Salesforce Agentforce、Zendesk AI**——生产级客服
  agent，具备审批流与审计日志，但治理模型是**黑盒**：策略由厂商定义、决策不可
  移植，客户无法独立验证任何一致性声明。更换厂商意味着从零重建治理层。

### 3. 工具/框架层——有治理原语，但没有领域契约

- **LangGraph**——interrupt/审批原语：agent 图可以暂停等待人工审批。能力强，
  但*策略*（什么可以自动执行）是应用代码，而不是可声明、可审计、按租户隔离的
  契约。
- **OpenAI Agents SDK**——围绕 agent 运行的 guardrails/hooks；属于输入/输出
  校验，不是完整的"决策—审计"生命周期。
- **Microsoft Agent Governance Toolkit + Agent Hooks（2026）**——概念上最接近的
  邻居：框架中立的治理契约、审批超时 fail-safe、可改写 verdict 的 transform
  hook、对标 OWASP agentic 威胁。它是横向的（不限领域），且由微软背书。
- **Invariant Labs 规则引擎**——对 agent trace 做确定性运行时检查；能约束行为，
  但不定义客服领域模型、权限阶梯或审计哈希语义。

## 对位表

| 能力 | OSAS | 微软 AGT | MCP | LangGraph | 客服 SaaS（Sierra/Fin/Agentforce/Zendesk） |
|---|---|---|---|---|---|
| 模型能否直接执行写操作 | **永不**——硬封顶 `request-approval` | 可配置；由 hooks 强制 | 无决策层 | 可以，除非自行编码约束 | 不透明，由厂商定义 |
| 确定性策略引擎 | **有**——声明式 TenantPolicy、worst-of 决策、默认拒绝 | 有——规则 + transform | 无 | 无（应用代码） | 黑盒 |
| 审计语义 | **SHA-256 哈希链**，按租户、防篡改 | 日志/trace | 无 | 应用自定义 | 厂商日志，不可验证 |
| Shadow 模式（先模拟后启用） | **有**——默认姿态 | 部分（可观测性） | 无 | 需自行实现 | 无 |
| 厂商中立/可移植 | **是**——开放规范 + JSON Schema | 框架中立但微软主导 | 是（LF AAIF） | 是（开源） | 否 |
| Conformance 注册表 | **有**——`conformance/implementations.json`、黑盒门禁 | 无 | 松散（SDK 兼容） | 无 | 无 |
| 客服领域模型 | **有**——helpdesk 适配器、20 工具域、多租户 TenantPolicy | 无 | 无 | 无 | 有（专有） |

## OSAS 的差异化

1. **客服垂直域**。Helpdesk 适配器（Zendesk、Shopify、Chatwoot）、20 个工具的
   领域模型、多租户 `TenantPolicy` 都是规范本身的一部分——不需要每个采用者
   重新推导。
2. **权限硬保证**。`read < draft < request-approval < execute` 阶梯是规范性
   的；模型行为体永远不能持有 `execute`。在多数框架中这只是约定，在 OSAS 中
   它是 conformance 测试用例。
3. **防篡改审计**。按租户的 SHA-256 哈希链 + 校验端点，而不是一个只能信其
   "append-only" 的日志。
4. **Conformance 作为门禁**。兼容性声明要过黑盒 runner 与有状态 conformance
   套件，并进入公开注册表——流程更接近 W3C/TC39，而不是框架的 README。

## 风险

- **上游挤压**。如果 MCP/AAIF 长出执行决策层，OSAS 可能被挤向小众。缓解：
  把 OSAS 定位为 agent 协议的治理 *profile*（RFC 0002），而非竞争协议。
- **微软引力**。AGT 自带 Azure/GitHub 分发与 OWASP 对齐背书。OSAS 无法在资源
  上对抗，必须在客服领域做出更强的规范，并保持真正的厂商中立。
- **生态规模**。目前只有 2 个实现（1 个参考实现 + 1 个仓内候选），对比数百个
  MCP server。v1.0 的 ≥3 独立实现门槛同时是护城河——见下文。

## 如何成为 OSAS 独立实现

1. 阅读[第三方实现者指南](implementing-osas.zh-CN.md)，了解每个 profile
   （core、ecommerce、saas、controlled execution）的最小实现面。
2. 以 [`schemas/`](../schemas/) 下的权威 JSON Schema 为准实现——schema 优先于
   散文描述。
3. 跑白盒 compat 套件（`pnpm test:compat`）与黑盒 runner
   （`pnpm osas:compat -- --target <url>`），包含有状态 conformance 套件。
4. 按 [conformance 注册流程](../conformance/README.md)提交
   **Compatibility claim / registry entry** issue，附线上目标或 CI 证据及
   runner 报告。
5. 验证通过后，maintainer 会以 PR 把你的条目加入
   `conformance/implementations.json`，并在 `conformance/badges/` 下添加 badge。

独立实现会计入 **v1.0 的 ≥3 独立实现门槛**，并在 v1.0 获得治理席位（见
[GOVERNANCE.md](../GOVERNANCE.md)）。

## 来源（访问于 2026-09）

- Microsoft Agent Governance Toolkit — <https://microsoft.github.io/agent-governance-toolkit/>
- MCP 规范公告，含 2026-07-28 修订（工具注解、MRTR）—— <https://modelcontextprotocol.io/>
- A2A（Agent2Agent）—— <https://a2a-protocol.org/>
- Intercom Fin — <https://fin.ai/learn>
- Agentic web 格局笔记 — <https://agenticweb.wiki/>
- OWASP Agentic AI 威胁 — <https://genai.owasp.org/>
