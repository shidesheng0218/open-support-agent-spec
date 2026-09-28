# 深度竞品分析：把 OSAS 放进真实的竞争格局里量一量

[English](competitive-deep-dive.md)

> **快照时间：2026-09-28。** 这是一份调研 + 自审文档，不是营销材料。凡与
> [竞品概览](competitive-landscape.zh-CN.md) 冲突之处，以本文为准。事实按置信度标注：
> **[V]** 本次已对一手来源核实、**[M]** 厂商/自我宣称、**[U]** 未能核实或无法访问。
> 版本号、star 数、定价变动很快，对外引用前请重新核实。
>
> **状态更新（同日，审计之后）：** §6.2 的规范漂移项已随 v0.2.1 维护发布修复
> （工具表、能力计数、审批超时与 transforms 正文、implementing-osas 计数、孤儿
> schema 注册）；§6.3 的门槛/eval 项已修复（`gateOk` 现由工具强制并被
> GOVERNANCE.md 要求；v0.3 eval 的三项空转检查已替换为对真实执行路径的行为断言）；
> 审批绑定缺口已由 RFC 0008 关闭（`actionDigest`，威胁 T14）。**未被**这些改动
> 解决的：独立实现仍为 0、无 live 执行、无生产部署、一致性矩阵仍手工维护、
> TypeScript 参考实现仍缺 v0.2 徽章。

## 为什么要写这份文档

之前的概览文档问的是"OSAS 处在什么位置"，然后给了一张定位表。对 README 来说这是对的问题，对决策来说不是。有三件事发生了变化，或者从来没人查过：

1. **微软 AGT 现在已经内置了客服策略示例。** 旧表里"AGT：客服领域 —— 无（横向通用）"这一行已经不成立了。AGT 不只是"相邻的横向层"，它已经落进了 OSAS 的垂直领域。
2. **有超大规模云厂商把 OSAS 的招牌演示做成了产品。** AWS AgentCore Policy 公开的示例就是"可自动退款 100 美元以内，超过则必须接入人工"——这正是 OSAS 的"25 美元退款 / 120 美元额度"演示，出现在 keynote 上。
3. **"一致性是门槛而非宣称"这句话，目前经不起对本仓库的审计。** 门槛机制本身有漏洞，本文逐一点名。

所以这是一次双向的工作：由外而内的行业地图，加由内而外的、OSAS 差异化到底建立在什么之上的审计。

## 1. 基线：OSAS 可被核实的现状

先把地板铺好，后面所有比较才有立足点。以下均 **[V]**，来源为本仓库，2026-09-28。

| 维度 | 已核实状态 |
|---|---|
| 规范版本 | v0.2 Draft；`ecommerce-controlled-execution` 为 v0.3 Draft |
| 注册表中的实现 | **2 个，指向同一个仓库 URL，两者 `independent: false`** |
| 采用者 | **0** —— `ADOPTERS.md` 明确说明这是刻意的 |
| 生产部署 | **已知 0 个** |
| v1.0 门槛（≥3 个独立实现） | **0 / 3** |
| Git tag / 发布 | **0 个 tag，35 个 commit** |
| 真实执行 | **启动即拒绝。** 没有任何 OSAS 实现曾向真实商业系统写入过 |
| 可发布包 | 15 个中 3 个（`@osas/core`、`@osas/schema-validator`、`@osas/policy-engine`），其余 12 个为 `private: true` |
| 参考实现定位 | 演示级，已自我披露：内存存储、基于 header 的 demo 鉴权、无 WORM 存储 |
| 白盒一致性套件 | 345 个用例，**仅限 TypeScript**（直接 import 工作区包） |
| 黑盒 runner | 22 项检查（v0.2）+ 7 项（v0.3），纯 HTTP —— 唯一可适用于第三方的门槛 |

这是一个诚实、处于早期的开放规范。下文任何内容都不应被读成"批评你做得早"。它重要的原因是：**每一条竞争性宣称都必须按其背后的证据打折**，而 OSAS 的证据基础目前只有一个组织那么宽。

## 2. 地图：七层，而不是三层

旧文档建了三层模型（协议 / 产品 / 框架）。七层更好用，因为它能暴露出真正的威胁各自从哪一层来。

**L1 —— 传输协议。** MCP、A2A、AGNTCY、IBM ACP。
* 现状：MCP 已捐赠给 **Agentic AI Foundation**（Linux Foundation 下属定向基金，由 Anthropic、Block、OpenAI 共同发起，Google、微软、AWS、Cloudflare、Bloomberg 支持），与 goose、AGENTS.md 同为创始项目；月 SDK 下载量 9700 万+，约 10,000 个服务器 **[V]**。2026-07-28 修订使协议**无状态化**（去掉 `initialize` 握手与 `Mcp-Session-Id`），并用 **MRTR**（`resultType: "input_required"`、`inputRequests`/`inputResponses`）取代服务端发起的 sampling/elicitation **[V]**。A2A 已达 v1.0（2026-03-12），TSC 由 Google、微软、Cisco、AWS、Salesforce、ServiceNow、SAP、IBM 组成——但在其规范与 ADR 中全局检索 policy/approval/audit，**命中数为零** **[V]**。IBM ACP 已**归档** **[V]**。
* **结论：OSAS 的 RFC 0002 判断是对的——搭在这层之上，不要与它竞争。**

**L2 —— 动作治理运行时。** 微软 AGT、Cerbos、OPA/Rego、Cedar、OpenFGA/Permify。
* **OSAS 真正的竞争在这里，而且这里并不空。**

**L3 —— 人在回路 / 工作流。** LangGraph `interrupt()`、OpenAI Agents SDK guardrails、微软 Agent Framework ADR-0006、Dify `human_input`、n8n `requireApproval`、Mastra。
* 现状：普遍是**控制流，而非治理产物**——没有裁决词汇表、没有审批对象模型、没有审计链、没有幂等契约 **[V]**。LangGraph 官方文档明确把幂等性推给开发者（"`interrupt()` 之前有副作用的操作最好（理想情况下）是幂等的"）**[V]**。

**L4 —— Agent 身份与生命周期。** 微软 Entra Agent ID + **Agent 365**（"大规模管理与治理 AI agent 的企业控制平面"）、AWS Bedrock AgentCore Identity、SPIFFE/SPIRE、AGNTCY identity-spec（把 Agent Badge 做成可验证凭证）。
* 现状：互补关系。微软在这层动作很大，连第三方 agent（Bedrock、n8n）都要纳入治理 **[V]**。

**L5 —— 产品：客服 agent。** 按*执行机制*分为三个阵营（见 §3.5）。这一层**没有任何一家公开提供防篡改证明或独立验证路径** **[V]**。

**L6 —— 商务 / 承诺。** AP2（v0.2 起已捐赠给 **FIDO Alliance**）、x402（已成为基金会）、ACP（OpenAI + Stripe）。
* 现状：AP2 已经建模了"已签名、强类型、不可否认的意图"，并**把授权凭证链式串联，形成一条可验证的审计轨迹** **[V]**。这是现存标准里最接近 OSAS `ActionProposal` + 审计链的东西——而 OSAS 自己的商务互操作文档完全没提它。

**L7 —— 评分卡与监管。** OWASP《2026 Agentic 应用 Top 10》（ASI01–ASI10）、AARM（云安全联盟：Core R1–R6 为 MUST，Extended R1–R9）、ISO/IEC 42001、AIUC-1、EU AI Act。
* 现状：**这一层才是 OSAS 的"一致性注册表"野心实际竞争的层，而 OSAS 在这里的存在感最低。** AGT 已经在宣称符合 "AARM Extended"，并针对 ASI01–ASI10 自评 7 项 Full / 3 项 Partial **[V]**。EU AI Act 剩余条款已于 **2026-08-02** 起适用 **[V]**；客服 agent 按类别不属于 Annex III 高风险，因此对本市场的真正约束点是**第 12 条（记录留存）**与**第 14 条（人工监督）**，加上采购环节的压力。

## 3. 正面对比：真正重要的四个

### 3.1 微软 AGT —— 直接竞争者，而非邻居

本次核实 **[V]**：`microsoft/agent-governance-toolkit`，MIT，创建于 **2026-03-02**，**6,350 star**，159 位贡献者，2,749 个 commit，5 套语言 SDK（Python、TypeScript、.NET、Rust、Go），**10 份规范**（含 Agent Control Specification），**33 份 ADR**，约 **605 个一致性测试函数**。版本 5.0.0，最新公开发布 v4.1.0（2026-06-09）——此后有约 3 个月的发布空档。状态：**Public Preview，"GA 前可能有不兼容变更"**。

**AGT 领先 OSAS 的地方。**

* **动作绑定的审批。** ADR-0030 是公开领域最精细的审批协议：`ActionBinding` 覆盖 `{agent_id, subject_id, operation, target{tool_name, tool_schema_version, resource}, parameters}`；`action_digest` 为基于 **RFC 8785 JCS** 规范的 SHA-256；`ApprovalChainEntry` 通过 `previous_entry_digest` 只增不改地串联；并在**执行时有七项原子化再校验**。它自己的原话：*"个别的同意票不是执行令牌。"* 超时或传输失败一律拒绝。它明确**拒绝让 LLM 担任审批者**。**而 OSAS 的 RFC 0006 自己承认：OSAS 的审批尚未与动作绑定。** 这是最清晰的一项能力差距。
* **信息流控制（IFC）** —— 有保留，见下 —— 但至少已规范化；OSAS 的 RFC 0005 只是非规范性的占位说明，无 schema、无代码。
* **生态规模。** 5 套语言 SDK vs OSAS 目前只有一种可用实现语言。
* **一致性测试体量。** 约 605 个测试函数 vs OSAS 的 345 + 22。

**OSAS 真正领先的地方 —— 这才是关键部分。**

AGT **白纸黑字写明它不做 OSAS 赖以立身的那件事。** 在其自身安全模型中：*"ACS 不能替代后端授权、租户隔离、身份验证、审计留存、支付管控、**幂等性，或补偿事务控制**。"* **[V]** 它的 saga 编排器只做逆序补偿；其中**没有任何幂等键、没有任何对账机制** **[V]**。

这不是小让步。这意味着 OSAS 视为不可协商的性质——`(tenantId, idempotencyKey)` 重放且无副作用、`uncertain` 结果转入对账且**永不盲目重试**——**在现存最完整的开放治理栈里没有对应物**，而且那个栈已经正式声明不拥有它。这是 OSAS 最强、最站得住的位置，应当是所有对外沟通的第一句话。

还有两条 AGT 的保留意见值得知道，因为它们会削弱它表面上的领先：

* **它的 IFC 比其宣传弱。** AGT 自己的安全模型写道：*"ACS 以无状态策略逻辑支持信息流控制。内核不执行任何内建 IFC 检查，也不保存污点状态。"* 并承认*"ACS 无法观测或阻断宿主未中介的路径。"*
* **它的审计链有和 OSAS 同一类局限。** ADR-0017 承认无法抵御整链替换；外部锚定仅以*可选的* Commitment Engine 形式给出规范。两个项目提供的都是防篡改**证据**，而非防篡改**保证**。这是平手，不是落后。

**而最能改变 OSAS 定位的一个事实：** `policy-engine/examples/support_agent/` **确实存在** **[V]** —— 一份客服策略：`refund_risk == fraudulent` 时拒绝退款、`high_value` 时升级、外发邮件告警、输入侧拒绝提示注入、在 `post_tool_call`/`output` 处拒绝 PII，且工具携带 `clearance` 与 `security_labels`。**AGT 已经进入这个垂直领域。** OSAS 不能再宣称"横向治理栈还没有碰客服领域"。AGT 仍然*不*具备的是客服**生命周期**：工单及其状态机、证据对象、审批队列、人工接管、售后对象（物流异常、理赔、换货）、作为可版本化不可变产物的租户策略，以及写入安全契约。站得住的宣称是**生命周期 + 写入安全**，而不是"别人都不做客服"。

### 3.2 AWS AgentCore Policy —— 把 OSAS 的卖点做成了 keynote

re:Invent（2025-12-02）发布 **[V]**：**Policy in AgentCore** 允许客户用自然语言定义 agent 的边界，这些边界*"与 AgentCore Gateway 集成……自动检查每个 agent 的动作，并阻止违反书面管控的动作。"* AWS 副总裁给出的例子：agent *"可以自动退还 100 美元以内的款项，但超过就必须接入人工"*。同期还有**带 13 套预置评估系统的 AgentCore Evaluations**。

拿这段对照 OSAS 的 README 演示表——25 美元退款自动执行，120 美元额度停下来等人工审批。**一家超大规模云厂商把 OSAS 的演示搬上了 keynote，还配了自然语言策略编写界面和网关级拦截。**

AWS 仍未公开的：裁决词汇表、动作提议对象、审批决议模型、审计链、幂等/对账契约、客服领域模型。它是边界设定器，不是写入安全契约。但它拉高了买家对*编写体验*的预期——而 OSAS 的纯 JSON `TenantPolicy` 相比一句话，未必更好。

另有一条值得作为市场背景注意：AWS 自家网站上写着**"88% 的 agent 试点会停滞"** **[M]**。这正是 OSAS 声称要解决的问题的需求信号。

### 3.3 Cerbos —— 仓库里没人盯着的纯决策派竞争者

Cerbos（open-core，v0.55.0，约 4,600 star）已从应用授权重新定位为*"为每个身份授权、为跨应用/网关/工作负载/**以及 AI agent** 的每个动作做治理"* **[V]**，并配了一整套 AI 安全、MCP 服务器授权、AI 网关授权、agentic 商务、多跳委托、策略驱动 MCP 工具闸门的内容栈。它宣称在动作执行前给出 ALLOW/DENY、每次决策连同**策略版本**一起记录，并把 agent 与*背后的委托人一起*评估，使委托人的权限成为上限 **[V]**。

**"agent 授权"这四个字在市场上是 Cerbos 占着，而它根本没出现在 OSAS 的竞品文档里。** 它缺什么：任何审批或挂起语义、审批对象模型、防篡改证明、幂等契约、领域内容。对于已经在跑 OPA 式授权的采用者，它是 L2 心智份额最强的竞争者。

L2 层正在整合的旁证：**Oso 已废弃**、**Permify 已被 FusionAuth 收购**、**Invariant Labs 被 Snyk 收购**、**Lakera 归入 Check Point**、**Prompt Security 归入 SentinelOne** **[V]**。独立的 agent 治理厂商层正在被吸收——这既是机会（中立规范的位置空了出来），也是警告（收购方有渠道优势）。

### 3.4 AP2 / FIDO —— 已经解决了"签名意图"的那份规范

AP2（源自 Google，3,196 star）于 **2026-04-28 发布 v0.2.0 并捐赠给 FIDO Alliance** **[V]**。它定义了**可验证数字凭证（VDC）**与 **Checkout / Payment Mandate**，各有开放（约束）与封闭（已授权）两个阶段，**Mandate 链式串联以形成完整的可验证审计轨迹**，提供*"确定性的、不可否认的意图证明"*。

这在结构上是现存标准中最接近 OSAS `ActionProposal` 的东西——一条强类型、已签名、可链式串联的意图记录——且它现已归属一个拥有支付网络重量的真正标准组织。**OSAS 的 RFC 0006 与其商务互操作文档都完全跳过了 AP2。** OSAS 是借用 AP2 的 mandate 链并明确说清关系，还是被读成"重新发明了一个更差的版本"，这是一个尚未做出的选择。

### 3.5 客服 SaaS 阵营 —— 按执行机制重新切分

旧文档把"Sierra / Fin / Agentforce / Zendesk"当成一个模糊的整体。真正有用的切分是**各家靠什么执行**，因为那正是 OSAS 竞争的轴。

**阵营一 —— 提示词驱动（多数派）。** 靠 agent 提示词里的指令和黑名单。Sierra（Horizon 里的 "Goals and guardrails"）、Decagon（AOP 即自然语言 SOP，配 Git 版本管理）、Fin（"Procedures"）、Gorgias、Freshworks。Parloa 公开抨击这种做法：提示词*"只是请求"*，关键词黑名单*"但凡换个说法就漏"* **[M]**。**这正是 OSAS 的"模型权限上限封顶在 `request-approval`"论点最有力的落点——而这个阵营很大。**

**阵营二 —— 基础设施强制（Parloa、AWS）。** Parloa 的 LLM Guardrails（2026-07-28）运行在*"对话之下、提示词之下、且独立于 agent 提示逻辑"*，共三层，其中包含一个**在每一轮读取完整对话历史的守护 LLM** **[M]**。AWS 则在网关处强制。**这个阵营才对 OSAS 的差异化构成实质威胁**，因为它在受支持的产品内交付了接近确定性的强制，并给出了可报数字（Parloa：在 1,803 通真实对话中，95.3% 的安全来电者无摩擦通过 **[M]**）。

**阵营三 —— 继承企业权限模型（Salesforce、微软、Zendesk）。** Agent 动作以真实用户身份执行，因而继承既有的 RBAC、profile、权限集与共享规则 **[V]**。在 agent 专属决策语义上更弱，在"谁做了什么"的可审计性上实质更强——而且**不需要客户新增任何策略产物**。这是对 OSAS 审计叙事最棘手的一类竞争，因为买家本来就信任它。

**三条塑造 OSAS 窗口期的品类事实：**

* **定价已收敛到按结果计费**，而这恰恰是让治理薄弱变得昂贵的压力点：Fin **每个结果 0.99 美元起** + 每席位 19 美元，Agentforce **每通对话 2 美元**（按 60 信用点/服务工单约合 0.30 美元），Gorgias **每次 AI 交互 1.50 美元** **[V]**。当 agent 按解决量收钱时，一个没有边界的 agent 就是一件挂着计费表的负债。
* **没有一家提供防篡改证明或独立验证** **[V]**。只有 Decagon 声称日志 "tamper-protected"，却未公开任何机制 **[M]**。而买家正在用钱投票：**Coralogix 融资 2 亿美元**、**InsightFinder 融资 1500 万美元**，都是做"从外部盯着 agent" **[V]**。对 agent 决策的第三方验证是一项已获资本支持、尚未被满足的需求——**这正是 OSAS 审计链为之而生的市场缺口，而 OSAS 没有产品可以卖进去。**
* **本次调研未找到任何一起这些厂商因写动作出错而被公开归因的事故** **[V]**。把它当作一个真实发现，但要附上说明：这类事故多半私下和解。这意味着 OSAS 目前无法靠"恐惧"销售，只能靠"采购就绪度"销售。

**整合是战略背景：** **Salesforce 于 2026-06-15 同意以约 36 亿美元收购 Fin（原 Intercom）**（2027 年初完成交割），**Zendesk 收购了 Forethought**（2026-03-11 宣布）**[V]**。四个月内，三家最可信的独立 agent 厂商中有两家被吸收，与此同时长尾估值上行（Parloa 30 亿美元、Decagon 45 亿美元、Sierra 逾 150 亿美元、Wonderful 50 亿美元）**[V]**。**押注独立厂商如今已被证明是有风险的——这正是"中立规范"的立论基础，前提是有人真的去讲。**

## 4. 多维对比矩阵

### 4.1 治理栈逐轴对比

| 轴 | OSAS | 微软 AGT | AWS AgentCore Policy | Cerbos | 客服 SaaS（各家最优） |
|---|---|---|---|---|---|
| 模型能否直接执行写操作 | **永不** —— 上限 `request-approval`；`executeAction` 不是工具 | 默认不能 | 不能 —— 网关阻断违规动作 | 不能 —— 执行前 ALLOW/DENY | 能（Fin 退款；Gorgias 退款/取消/改地址） |
| 声明式策略产物 | **有** —— 可版本化不可变 `TenantPolicy`，JSON | 有 —— Rego/OPA（另附 Cedar 库） | 自然语言 | 有 —— Cerbos 策略 | 无 —— 提示词文本 / 界面设置 |
| 裁决词汇表 | `auto_execute` / `require_approval` / `block`，取最严，默认拒绝 | `allow`/`warn`/`deny`/`escalate`/`transform` → 归一到 `allow`/`deny`/`require_approval` | 未公开 | ALLOW / DENY | 黑箱 |
| 失败即拒绝 | 是 —— `NO_RULE` → block；引擎异常 → block | 是 —— ADR-0013，`runtime_error:*` | 是（阻断违规动作） | 是 | 厂商自定 |
| 审批语义 | 挂起 + **仅允许拒绝**的超时；**未与动作绑定**（自认） | 挂起 + 超时可 deny/allow/suspend；**经 SHA-256/JCS 摘要与动作绑定 + 只增审批链 + 执行时 7 项复核** | 人工介入阈值 | **无** | 界面审批（Zendesk Suite Enterprise） |
| 写入幂等 / 对账 | **规范核心**：`(tenantId, idempotencyKey)` 重放、`uncertain` → 对账、永不盲目重试 | **明确声明不做。** saga 仅逆序补偿；无幂等键 | 未公开 | 无 | 厂商自定，无法验证 |
| 防篡改审计 | 按租户 SHA-256 哈希链 + `/v1/audit/verify` | SHA-256 Merkle 链 + `verify_chain()`、包含性证明；整链替换无保护 | 未公开 | 决策日志（非哈希链） | 仅日志；Decagon 称 "tamper-protected" **[M]** |
| 租户隔离 | `ToolContext` 租户作用域，403 `TENANT_MISMATCH` | 宿主提供；ACS 明确声明不负责租户隔离 | AWS IAM / 区域 | 有 | 有 |
| 客服领域模型 | 工单、证据、审批、人工接管、订单、退款、理赔、换货，20 个工具 | **已有 `support_agent` 示例策略** —— 但无生命周期 | 无 | 无 | 有，但专有 |
| 第三方一致性验证 | 黑盒 HTTP runner + 公开注册表 —— **但独立条目为 0，且 runner 作者即规范作者** | 约 605 个自跑测试；无第三方注册表 | 无 | 无 | 无 |
| 标准对齐 | MCP profile（RFC 0002）；**对 AP2、AARM、OWASP ASI、ISO 42001 完全沉默** | AARM Extended；映射 OWASP ASI01–ASI10 | MCP / Bedrock 生态 | MCP 授权内容 | 各类信任中心（ISO 42001、FedRAMP、CSA STAR AI L2） |
| 编写成本 | 纯 JSON —— 最低 | 需 PATH 上有 Rego/OPA —— 最高 | 自然语言 —— 最低 | Cerbos 策略语言 | 界面 —— 最低 |

### 4.2 证据与生态现实

| 轴 | OSAS | 微软 AGT | Cerbos | 客服 SaaS |
|---|---|---|---|---|
| 独立实现 | **0** | 不适用（单一厂商） | 不适用 | 不适用 |
| 具名采用者 | **0** | 未披露 | 商业客户群 | 数百至数千 |
| 生产部署 | **已知 0** | 未知（Public Preview） | 有 | 有，且规模可观 |
| 真实写入能力 | **设计上即拒绝** | 有（客户部署中） | 有（仅授权） | 有 |
| 背后力量 | 创始维护者 | 微软 | Cerbos（VC 投资） | 估值 30–150 亿美元以上 |
| 许可 / 治理 | Apache-2.0，单一组织 | MIT，微软主导 | Apache-2.0 open-core | 专有 |
| 公开单价 | 不适用 | 不适用 | 不适用 | 每个结果 0.99–2 美元 **[V]** |

## 5. OSAS 真正的差异化 —— 以及它能撑多久

**1. 写入安全契约。持久，且是最强资产。**
以 `(tenantId, idempotencyKey)` 为键的幂等、重放无副作用、`uncertain` → 对账任务、**永不盲目重试**——并且同样的语义被规范到了 provider 事件上（按 `(tenantId, provider, providerEventId)` 去重，仅在幂等键匹配时才能消解对账）。AGT **书面声明不做这件事**。Cerbos 完全没有。LangGraph 把它推给开发者。没有任何客服 SaaS 可被验证地暴露它。
*持久性：* 高，因为这是语义契约而非功能特性，也因为是治理层要与钱打交道就必须自己拥有的那一件事。
*风险：* AGT 或 AWS 可能在一个季度内把它做出来。**这里的速度比其他任何地方都重要。**

**2. 作为可版本化、可移植契约的客服生命周期。正在收窄。**
带状态机的工单、证据对象、审批队列、人工接管、售后对象、20 个工具的面、多租户 `TenantPolicy` 及其不可变生命周期（`draft → simulated → approved → active → retired`）。
*持久性：* 中等且在**下降**——AGT 的 `support_agent` 示例意味着"别人都不做客服"已死。活下来的是*生命周期*，那是真实差异，但没那么好引述。

**3. 由非厂商担任考官的一致性验证。最强的想法，最弱的执行。**
那个结构性洞见——黑盒 runner 加公开注册表，更接近 W3C/TC39 而非框架 README——是仓库里最有趣的东西。但目前它是一个组织在考自己：独立条目 0，且 runner 的作者即规范作者。
*持久性：* 高，**前提是**拿到第一个真正独立的实现。否则它未经证明，很容易被打发掉。

**4. 没有 DSL 学习税。** 纯 JSON 策略 vs 需要 PATH 上有 Rego。真实存在，但很小——而且这一点其实对 OSAS 不利，因为 Rego 背后是人才池，而 OSAS 的 JSON 是一套反正也得学的自定方言。

**5. 规范文本里克制、严谨的诚实。** 把 RFC 标注为非规范性草案、披露演示级定位、披露同组织导致独立性不成立、拒绝对 UCP/ACP 做一致性宣称、宁可在 live 模式下拒绝启动也不假装。这确实优于多数厂商的安全文档，而且对 OSAS 想要的那类读者（平台与治理工程师）是一项资产。**它应当被极力保护——这正是 §6 之所以重要的原因。**

## 6. OSAS 的暴露面

按每一类能造成的伤害分组。

### 6.1 证据缺口（对一个标准而言是生存级问题）

* **在它自己的 v1.0 门槛上是 0 / 3。** 两个注册实现指向同一仓库 URL，且均为 `independent: false`。[GOVERNANCE.md](../GOVERNANCE.md) 定义的这道门槛就是护城河；护城河是空的。
* **独立性门槛目前只能靠运气满足。** Python 实现放在参考仓库里，因此它在结构上永远不可能计数。把它单独发布是一次文件搬迁，不是一个项目——但这次搬迁还没发生。
* **真实执行被拒绝，所以没有任何 OSAS 实现曾写入过真实服务商。** 所有执行宣称都建立在合成沙箱服务商之上。怀疑者可以把整个执行叙事当作"未经现实检验"一笔勾掉。
* **CI 中没有任何一处跑真实第三方集成。** Zendesk、Shopify、Chatwoot 适配器只对 mock HTTP 做过测试。更糟的是，Zendesk 适配器在结构上无法通过任何要求身份验证的自动执行规则：它总是把 `Customer.region` 设为 `"ZZ"` 占位符，身份恒为 `unverified`。
* **适配器的幂等缓存是进程内 `Map`，重启即丢**（已自我披露）。所以参考适配器实际上并不能跨崩溃保持规范所规定的那个性质。
* **15 个包中 12 个是 `private: true`。** 除了 checkout 仓库，没人能把参考栈当库来用。

### 6.2 规范完整性缺陷（改起来很便宜，留着很贵）

这些缺陷的影响被放大，是因为**整个卖点就是严谨。** 一份连自己的规范面都数错的规范，平台评审者不敢把资金托付给它。

* **`docs/spec-v0.2.md:387` 写着"20 个 MCP 工具"；紧接其下的 §7 表格只列了 16 个。** 另外 4 个在 500 行之后的 §15.6 才出现。这张规范性表格是 v0.1 的遗留物。
* **能力数量三处不一致：** §12.1 说"16 个规范定义的能力"，§15.6 说 20 个，代码里的 `CAPABILITIES` 是 20 个。
* **`docs/implementing-osas.md`——恰恰是给 v1.0 门槛所依赖的独立实现者看的入门指南——schema 数量是错的**（core 写"14 条"，实际 15 条；ecommerce 写"2"，实际 6）。照它评估工作量的人会评估不足。
* **两个承重机制只存在于 schema，从未进入正文：** `TenantPolicy.approval.timeoutSeconds`（威胁 **T13**——13 个招牌威胁之一——背后的语义）与 `PolicyRule.transforms` / `PolicyDecision.transforms`。"以 schema 为准"是合法的权威规则，但一份把审批超时语义只放在 JSON 文件里的规范，是弱规范文本。
* **§5 的 `PolicyDecision` 没有 `transforms` 字段**，尽管 `evaluateProposal` 会返回它；而 `NEVER_AUTO_EXECUTE` 这个原因码在参考实现的 `POLICY_REASON_CODES` 里缺失。
* **两个 schema（`after-sales-case.json`、`after-sales-decision.json`）不在任何 manifest 中**——哪儿都没注册，只能通过一个内层 manifest 和 eval 脚本访问。
* 路线图已经把"v0.2.1 维护发布，无文档/schema/版本漂移"列为**未完成**。那个状态是准确的。
  **修好这一节是本项目投入产出比最高的工作**，因为它只需要几天，而它是"有漂移的草案"和"能照着实现的草案"之间的差别。

### 6.3 门槛与 eval 缺陷（恰恰伤害"差异化"本身）

一致性与 eval 机制是 OSAS 自称的护城河。以下是漏洞。

* **runner 可以在跳过 stateful 套件的情况下报 `ok: true`。** `packages/compat-runner/src/runner.ts:70` 用 `ok: totals.failed === 0` 计算，所以被跳过的检查不会导致失败——而 GOVERNANCE.md 要求一致性宣称必须包含 stateful 套件。**门槛靠政策约束，而非靠工具强制。** 修法：把 `ok`（跑得干净）与 `gateOk`（跑得完整）分开，注册表只接受后者。
* **v0.3 受控执行 eval 完全没有行为测试。** `evals/src/controlled-execution-eval.ts` 的六项检查中，**三项不是测试**：`exchangeHumanOnly` 字面上就是 `check(true, …)`（:121）；`providerEventsDeduplicated` 检查的是两个*一字不差*的模板字符串组成的 `Set` 大小是否为 1（:117–120）——那是 JavaScript 的重言式，不是对实现的断言；`uncertainNeverAutoRetried` 断言的是一个**硬编码字面量对象**的属性（:116）。剩下三项里两项只是数数据集条数，只有 `executionSchemasValid` 真的校验了东西。**六项中零项触及 v0.3 运行时。** 真正的行为证明在黑盒 runner 的受控执行套件里——而 eval 产物并不是它。修法：删掉这三项，改为对 runner 实际输出做断言。
* **eval 的"准确率"无法给出有信息量的失败。** 该 harness 只 import `evaluateProposal` 与 `validate`——无模型、无适配器、无网络、`costUsd: 0`——然后把数据集的期望值与同一作者的引擎做比对。它衡量的是内部自洽性，且无法发现"双方对规范有同一种误读"。这一点值得在 README 里直说，而不是让 120/120 被读成验证通过。
* **按 harness 自己的记账，售后覆盖率是 20%。** 来自已提交的用例数据 `evals/cases/after-sales-top10.json`：**`supported` 20、`shadow_only` 45、`proposal_only` 20、`missing_adapter` 5、`missing_domain_object` 5、`unsupported` 5。** README 排在第一个的招牌场景"25 美元破损商品退款"是 `shadow_only`，**10/10 全部如此**——它的决策是 auto_execute，但在 eval 中没有执行路径。这是 harness 的诚实之处（机器可读的记账）；代价则是："100 个售后用例"并不等于 100 个可执行用例。
* **345 个白盒用例仅限 TypeScript**，且按其自身文档，无法验证任何其他实现。因此第三方验证只剩 **22 项 HTTP 检查**，其中策略矩阵只有三个模拟结果（小额已验身份退款 → auto_execute、超阈值 → require_approval、身份未验证 → block）。**一个含 15 个原因码的算法，由 11 个白盒用例和 3 个黑盒断言守着。** 最重要的安全性质——幂等/对账——只有 4 个白盒用例和 1 项 runner 检查。
* **`conformance/matrix.md` 是手工维护、没有渲染器**，而且它自己承认："若数字与一次新跑的结果不符，以新跑的结果为准。"
* 一条小但说明问题的事：**TypeScript 参考实现在 `conformance/badges/` 里没有 v0.2 徽章**，尽管 `matrix.md` 声称它通过了 v0.2 套件。

### 6.4 定位风险

* **AGT 已进入这个垂直领域**（见 §3.1）。任何仍在宣称"AGT：客服领域 —— 无"的材料现在都是错的，应当更正。
* **MCP Interceptors 工作组是最有可能吸收这个空间的标准机构。** 它被授权定义一等 MCP 原语，包含两种类型——`validators`（检查并返回通过/失败）与 `mutators`（变换负载）——覆盖工具调用、资源读取、prompt 获取、sampling、elicitation *以及* 非 MCP 操作，支持进程内/边车/远程，带优先级链与"审计模式语义"。牵头方包括 Bloomberg、Saxo Bank、Nordstrom **[V]**。如果 MCP 推出只有通过/失败的 validator/mutator 拦截，那里面没有裁决层级、没有升级、没有审批对象、没有哈希链——但它会成为所有人都去实现的契约。**OSAS 要么进那个房间，要么明确映射到它**；今天两者都不是。（另注：MCP 的 `idempotentHint` 至今只是一个建议性布尔值，没有键、没有校验、没有对账——一个 OSAS 可以填上的、可被引用的真空。）
* **评分卡这层正被别人占走。** AGT 在报 AARM Extended 与 OWASP ASI 覆盖；HubSpot 和 Zendesk 在公开 EU AI Act、ISO 42001、CSA STAR AI Level 2。OSAS 对这些全部沉默。对买家而言，"映射到 AARM Core R1–R6 与 ASI02/ASI03/ASI09"写起来很便宜，说服力却不成比例地高。
* **品类整合抬高了被注意的门槛。** Salesforce–Fin 与 Zendesk–Forethought 意味着独立的平台更少，每家都有自己的治理叙事，而市场被训练成"买"而不是"标准化"。
* **一个被整体引用的风险**：本文件的前身在一张 OSAS 自己写的表里把 OSAS 与 AGT 作比，同时承认 AGT 在动作绑定审批和 IFC 上领先。这类表格会被读成辩护词。更正后的版本——*AGT 在 X 上领先，我们拥有 Y，两者的出处都在这里*——对真正重要的读者群要有说服力得多。

## 7. 建议（按投入产出比排序）

1. **现在就做 v0.2.1 漂移修复发布。** 修 §7 工具表、三处能力计数、`implementing-osas.md` 的 schema 数量；把 `approval.timeoutSeconds` 与 `transforms` 提升为规范正文；给 `PolicyDecision` 补上 `transforms` 字段；把两个孤儿 schema 注册进 manifest。几天的工作量，消除的是针对本项目核心宣称最廉价的一条攻击线。
2. **让 runner 强制它自己的门槛。** 把 `ok` 与 `gateOk` 分开；注册表条目必须包含 stateful 套件。工具不强制遵守的门槛，第三方不会相信。
3. **删掉 v0.3 那三项空转检查，换成由 runner 输出支撑的断言。** 一个评审者五分钟就能驳倒的绿色 CI 徽章，比没有徽章代价更大。
4. **在 README 里写明 eval 的边界。** "合成数据、离线、无模型、无适配器、衡量的是规范与实现的一致程度"是一句可信的话。120/120 的准确率则会诱导读者过度解读。
5. **把动作绑定审批做出来。** 采纳 AGT 的 `enforced_identity` 模式——对规范化动作输入做摘要，执行时再校验。OSAS 自己的 RFC 0006 已经点出了这个缺口。这是最清晰的一项单项能力赤字，而且可以直接借鉴。
6. **拿到第一个独立实现。** 一切都系于这一点。22 项检查的黑盒契约小到可以是一个人的周末工作量，而 Python 实现已经写好了——把它作为独立维护的仓库发布，是通向 3 个中的第 1 个最便宜的路径。然后以 Chatwoot/Captain 或 Zammad 集成作为第二个目标。**把"一个下午证明兼容"作为营销口号**，并邀请一位非创始维护者的第三方来运营注册表——自我审查是一致性这个想法唯一的弱点。
7. **采纳 AGT 的词汇表，而不是与它竞争。** 公布裁决映射（`auto_execute` ↔ `allow`；`require_approval` ↔ `escalate`；`block` ↔ `deny`；`transform` ↔ 参数变换），并让 RFC 0006 成为互操作叙事。做"插进 AGT/OPA 的客服 profile"是一个站得住、可达成的位置；做"与微软竞争的全栈治理运行时"不是。
8. **映射到评分卡。** 每项一页：OWASP ASI01–ASI10（认领 ASI02、ASI03、ASI09 并给出对应测试）、AARM Core R1–R6、EU AI Act 第 12/14 条。廉价的"可被读懂"，在采购对话里会复利增长。
9. **说清与 AP2 / FIDO 的关系**，并借用 mandate 链，而不是重新发明强类型意图。AP2 在支付界有话语权，FIDO 有标准流程；OSAS 的商务互操作文档目前无视了它。
10. **完成一次对沙箱服务商的真实写入**——一个 Shopify 开发店就够了——并公布回执与已验证的审计链。对"这东西到底有没有真的执行过什么？"最强有力的回答是一件产物，不是一个论证。
11. **收窄对外宣称。** "受治理的客服 agent——模型提议、策略裁决、适配器执行、审计链解释"今天就是可信的。"一致性注册表、类 W3C 流程、行业标准"不是——在独立实现为 0 的时候。**以写入安全契约为矛头**，因为那是这个世界上最完整的开放治理栈已经正式声明放弃拥有的唯一一项性质。

## 8. 结论

**OSAS 是什么：** 现存最完整的、关于客服 agent 写入安全的*书面*契约，拥有一条真正差异化的语义轴——面向资金类写入的幂等与对账契约，**微软 AGT 明确声明不做、且没有任何客服 SaaS 可被验证地暴露它**——外加一套客服生命周期模型，以及一个核心想法（考官不是厂商）优于本垂直领域内任何其他方案的一致性架构。

**OSAS 不是什么：** 不是行业标准，不是被采用的规范，也不是产品。它在自己的独立性门槛上是 0/3，从未执行过一次真实写入，而且它的规范正文目前数错了自己的规范面。

**窗口期真实存在，但正在关闭。** AGT 大约七个月大，159 位贡献者、5 套 SDK、约 605 个一致性测试，已带着一份参考策略进入客服垂直领域——而且恰好留了一扇门：写入幂等与对账。如果 AGT 或 AWS 在 OSAS 拿到独立实现之前关上这扇门，OSAS 的差异化轴就消失了，它会变成"别人已经解决的问题的客服形状包装"。

**最可能的好结局**不是"行业标准"，而是**被治理运行时消费的客服 profile**：OSAS 拥有领域模型、权限阶梯与写入安全契约，由 AGT/OPA/AWS 式的 PDP 在下面提供横向策略运行时——这正是 RFC 0006 已经勾画的东西。这个位置真实、站得住、也能达到。它同时也比当前的表述小得多，而假装它不小，是本项目面临的主要战略风险。

## 来源

除注明外，均在本次（2026-09-28）核实。请优先引用以下一手来源，而非本文。

* Microsoft Agent Governance Toolkit —— <https://github.com/microsoft/agent-governance-toolkit>（含 `policy-engine/examples/support_agent/`、ADR-0013/0017/0030）
* AWS re:Invent AgentCore 发布 —— <https://techcrunch.com/2025/12/02/aws-announces-new-capabilities-for-its-ai-agent-builder/>
* Salesforce 收购 Fin —— <https://techcrunch.com/2026/06/15/salesforce-acquires-ai-customer-service-platform-fin-for-3-6b/>
* Zendesk 收购 Forethought —— <https://techcrunch.com/2026/03/11/zendesk-acquires-agentic-customer-service-startup-forethought/>
* Parloa 30 亿美元 D 轮 —— <https://techcrunch.com/2026/01/15/parloa-triples-its-valuation-in-8-months-to-3b-with-350m-raise/>
* Sierra 9.5 亿美元融资 —— <https://techcrunch.com/2026/05/04/sierra-raises-950m-as-the-race-to-own-enterprise-ai-gets-serious/>
* Decagon 45 亿美元要约收购 —— <https://techcrunch.com/2026/03/04/decagon-completes-first-tender-offer-at-4-5b-valuation/>
* Coralogix 2 亿美元（agent 可观测性）—— <https://techcrunch.com/2026/06/03/coralogix-raises-200m-in-race-to-build-the-monitoring-layer-for-ai-agents/>
* MCP 规范与治理 —— <https://modelcontextprotocol.io/>、<https://github.com/modelcontextprotocol/modelcontextprotocol>
* A2A —— <https://a2a-protocol.org/>、<https://github.com/a2aproject/A2A>
* AP2（FIDO Alliance）—— <https://github.com/google-agentic-commerce/AP2>
* x402 —— <https://github.com/x402-foundation/x402>
* Cerbos AI agent 授权 —— <https://cerbos.dev/>
* OWASP Agentic Security Initiative —— <https://genai.owasp.org/initiatives/agentic-security-initiative/>
* AARM（云安全联盟）—— <https://aarm.dev/>
* EU AI Act 实施时间线 —— <https://artificialintelligenceact.eu/implementation-timeline/>
* Fin / Zendesk / Gorgias / Salesforce 定价 —— 各厂商自家定价页
* 各厂商信任中心：Zendesk、Maven AGI、HubSpot、Pylon、Observe.AI