# 标准映射：OWASP Agentic ASI、AARM、EU AI Act

[English](security-mapping.md)

> 快照：2026-09-28。本文档把 OSAS 的机制映射到外部安全分类体系，让平台与采购
> 评审能用他们已经熟悉的词汇表读 OSAS。**它不是合规评估、不是认证、不是法律
> 声明。** 凡是覆盖不全或未覆盖之处，表中如实写出——只列优点的映射是宣传，
> 不是地图。

## OWASP《2026 Agentic 应用 Top 10》↔ OSAS 威胁模型

OSAS 的[威胁模型](threat-model.zh-CN.md)先于本映射存在；下表从 OWASP Agentic
Security Initiative 的 2026 年清单出发，逐项对应到 OSAS 的防御与证明它的测试。

| OWASP ASI | OSAS 覆盖 | 机制与证据 |
|---|---|---|
| ASI01 Agent 目标劫持 | **已覆盖** | T1：`detectInjection()`（中英模式）→ `PROMPT_INJECTION_SUSPECTED` 阻断 + 人工接管。测试：`packages/core/src/injection.test.ts`、20 条安全评测用例 |
| ASI02 工具误用与利用 | **已覆盖** | T2：权限阶梯把模型封顶在 `request-approval`；`executeAction` 绝不注册为 MCP 工具；一切变更都是经策略门控的 `ActionProposal`。测试：`evaluate.test.ts`、mcp-server 测试、评测越权门禁 |
| ASI03 身份与权限滥用 | **已覆盖** | T5/T6：`ToolContext` 租户作用域（403 `TENANT_MISMATCH`）、策略生命周期 RBAC、`system_executor` 仅服务端内部持有。测试：`auth.test.ts`、runner stateful 套件 |
| ASI04 Agentic 供应链 | **部分覆盖** | T12：处处 `additionalProperties: false`、先校验后行动、固定工具面。**未覆盖：** agent 栈自身的 SBOM/依赖溯源 |
| ASI05 意外代码执行 | **已覆盖（因不存在）** | OSAS 不定义代码执行工具面；模型层不持有凭据且永远拿不到 `execute`。注意：这对宿主应用在 OSAS 之外的自有工具不作任何断言 |
| ASI06 记忆与上下文投毒 | **部分覆盖** | 证据时效（`EVIDENCE_STALE`）、不可信文本注入筛查、不可变策略版本（T7）。**未覆盖：** 长期记忆存储——参考实现没有该子系统 |
| ASI07 Agent 间通信不安全 | **部分覆盖** | Provider 事件：适配器**必须**先验证上游来源并把事件绑定到单一租户再摄入（见商务互操作文档）；跨租户 provider 事件不能消解其他租户的对账。A2A 级签名目前不在范围内 |
| ASI08 级联 Agent 故障 | **已覆盖** | T3/T4/T10：`(tenantId, idempotencyKey)` 幂等、禁止盲重试、`uncertain` → 人工对账、调用前预算上限 |
| ASI09 人-Agent 信任滥用 | **已覆盖** | T13/T14：审批 fail-safe 过期（仅允许拒绝）、动作绑定审批（RFC 0008——审批授权的是确切动作输入，执行时重新校验）、`exchange_request` 仅人工履约 |
| ASI10 失控 Agent | **已覆盖** | T8：按租户 SHA-256 审计链 + `GET /v1/audit/verify`；每次模型调用都带遥测落审计；预算上限约束失控循环 |

## AARM（云安全联盟）↔ OSAS 机制

AARM Core（R1–R6，MUST 级）描述的是"从执行前拦截到身份绑定"的主线；
Extended 级别增加漂移跟踪、遥测导出与最小权限执行。OSAS 的对应机制：

| AARM 主题 | OSAS 机制 |
|---|---|
| 执行前拦截 | 一切变更都是经确定性策略引擎求值的 `ActionProposal`；`executeAction` 从不暴露给模型 |
| 执行前的确定性裁决 | 取最严决策 + 默认拒绝；纯函数引擎、完全可审计 |
| 人工监督 | `pending_approval` + 仅允许拒绝的过期保护（T13）；每类阻断都有人工接管 |
| 身份绑定 | 每次适配器调用都携带 `ToolContext = { tenantId, principal }`；RFC 0008 把审批绑定到规范化动作输入 |
| 审计轨迹 | 按租户 SHA-256 哈希链 + 公开校验端点 |

逐条要求（R1…R6）的精确引用有待对 AARM 文本的仔细核对；本表映射的是主题
而非条款号，待 AARM 发布稳定条文后会收紧。

## EU AI Act —— 第 12 与 14 条

客服 agent 通常**不属于** Annex III 高风险系统，因此 AI Act 并不按类别给本领域
设定硬性期限。采购团队仍会问到的两条，以及 OSAS 的对应物：

| 条款 | 义务（转述） | OSAS 机制 |
|---|---|---|
| 第 12 条（记录留存） | 在系统生命周期内自动记录事件 | 按租户只追加的审计哈希链 + `GET /v1/audit/verify`。注意：这是防篡改**证据**，不是防篡改**保证**——生产部署必须与 WORM 存储配合（见威胁模型的残余风险） |
| 第 14 条（人工监督） | 系统可被人监督、打断与推翻 | 权限阶梯把模型压在 `execute` 之下；审批门禁 + 仅拒绝的超时兜底；每类被阻断决策都有人工接管；默认以 shadow 模式作为上线姿态 |

**并非合规声明。** 本文档的任何内容都不构成对 AI Act 或任何其他法规的合规
主张；它是评审者在评估基于 OSAS 的部署时的阅读辅助。

## 来源

- OWASP Agentic Security Initiative —— <https://genai.owasp.org/initiatives/agentic-security-initiative/>
- AARM（云安全联盟）—— <https://aarm.dev/>
- EU AI Act 实施时间线 —— <https://artificialintelligenceact.eu/implementation-timeline/>
