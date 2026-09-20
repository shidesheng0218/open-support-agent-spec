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
- **Microsoft Agent Governance Toolkit（AGT）**——概念上最接近的邻居，也是
  截至 2026 年 9 月开源世界最完整的横向治理栈：MIT 许可、五种语言 SDK、
  十个 RFC-2119 风格规范与约 992 个自测一致性用例；其确定性 fail-closed
  策略运行时的裁决词表（`allow` / `deny` / `transform` / `escalate`）中
  包含携带审批的"可解除拒绝"。它已实现审批 fail-safe（超时 +
  `on_timeout`）、与动作绑定的审批、信息流控制（源标签 → 宿口径）、
  Merkle 链审计与 shadow 模式。横向（不限领域）、微软背书、定位为应用
  中间件。详见下方深挖小节。
- **Invariant Labs 规则引擎**——对 agent trace 做确定性运行时检查；能约束行为，
  但不定义客服领域模型、权限阶梯或审计哈希语义。

## 对位表

| 能力 | OSAS | 微软 AGT | MCP | LangGraph | 客服 SaaS（Sierra/Fin/Agentforce/Zendesk） |
|---|---|---|---|---|---|
| 模型能否直接执行写操作 | **永不**——硬封顶 `request-approval` | 默认否——策略运行时门控每次调用 | 无决策层 | 可以，除非自行编码约束 | 不透明，由厂商定义 |
| 确定性策略引擎 | **有**——声明式 TenantPolicy、worst-of 决策、默认拒绝 | 有——确定性 fail-closed 运行时（裁决 `allow`/`deny`/`transform`/`escalate`） | 无 | 无（应用代码） | 黑盒 |
| 审计语义 | **SHA-256 哈希链**，按租户、防篡改 | Merkle 链审计日志 + 决策物料清单 | 无 | 应用自定义 | 厂商日志，不可验证 |
| Shadow 模式（先模拟后启用） | **有**——默认姿态 | 有 | 无 | 需自行实现 | 无 |
| 幂等/对账语义 | **有**——`(tenantId, idempotencyKey)` 重放、结果不确定 → 对账、禁止盲重试 | **无** | 无 | 无 | 由厂商定义 |
| 厂商中立/可移植 | **是**——开放规范 + JSON Schema | 框架中立但微软主导 | 是（LF Projects, LLC） | 是（开源） | 否 |
| Conformance 注册表 | **有**——`conformance/implementations.json`、黑盒门禁 | 自测向量（约 992 个）；无第三方注册表 | 松散（SDK 兼容） | 无 | 无 |
| 客服领域模型 | **有**——helpdesk 适配器、20 工具域、多租户 TenantPolicy | 无 | 无 | 无 | 有（专有） |

## 深挖：微软 AGT——最近的邻居，逐项对照

2026-09-14 依据公开仓库与文档核实。AGT 的 Agent Control Specification
（ACS）是一个无状态、确定性、fail-closed 的策略决策运行时；被其拒绝的
动作在该运行时内"结构性不可能"执行。它是我们所知唯一几乎逐项对上
OSAS 治理格子的项目。

| 维度 | AGT | OSAS |
|---|---|---|
| 决策词表 | `allow` / `deny` / `transform` / `escalate`（escalate = 携带审批的可解除拒绝） | `auto_execute` / `require_approval` / `block` |
| 审批 fail-safe | `timeout_seconds` + `on_timeout: deny \| allow \| suspend`；审批与动作绑定（`enforced_identity` = 规范化动作输入的 SHA-256，执行前重新校验） | `timeoutSeconds` + `onTimeout: "deny"` **仅此一项**（只允许拒绝是刻意为之）；过期即关闭提案，不存在陈旧审批死胡同；动作绑定是候选加固项（见 RFC 0006） |
| 信息流控制 | 源标签 → 宿口径、no-write-down、Rego/Cedar 实现 | 仅有设计注记（RFC 0005） |
| 审计 | Merkle 链日志 + 决策物料清单 | 按租户 SHA-256 哈希链 + `GET /v1/audit/verify` |
| 幂等/对账 | **无** | 核心语义：`(tenantId, idempotencyKey)` 重放、`uncertain` → 对账任务、绝不自动重试 |
| 客服领域 | 无（横向） | 工单、订单、退款、理赔、换货、证据、审批、接管——另有参考 helpdesk 适配器 |
| Conformance | 约 992 个自测向量 | 第三方黑盒 runner + 公开注册表——出题方不是厂商自己 |
| 许可/治理 | MIT，微软主导 | Apache-2.0，创始维护者；v1.0 起多方席位（RFC 0004） |

**解读**：AGT 是一个领域通用的治理层，在"审批与动作绑定"和 IFC 上走
得更远；OSAS 是一份领域完备的契约，其幂等/对账语义与可被第三方验证的
合规机制在 AGT 中没有对应物。两者是组合关系而非对冲：RFC 0006 定义了
外部策略决策点接缝，AGT（或 OPA）运行时可以在该接缝上**收紧**——绝不
放宽——OSAS 的决策；AGT 的 `transform` 裁决也恰好映射到 OSAS 的参数
脱敏 transforms。

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
- **微软引力**。AGT 真实存在且成熟很快（半年约 6k star、五种语言 SDK、
  周级发版）：审批 fail-safe 超时、与动作绑定的审批、IFC、Merkle 审计链
  均已出货。OSAS 无法在资源上对抗，必须在客服领域做深（领域生命周期、
  幂等与对账语义）、保持真正的厂商中立，并——依 RFC 0006——把 AGT 当作
  可插拔的策略决策点：让采用 AGT 强化 OSAS，而非取代 OSAS。
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
