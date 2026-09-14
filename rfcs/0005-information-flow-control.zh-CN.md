# RFC 0005：信息流控制（设计笔记）

- **状态：** Draft <!-- Draft | Accepted | Rejected | Implemented | Superseded -->
- **作者：** OSAS founding maintainers
- **创建日期：** 2026-09-14
- **目标版本：** v0.3 之后的探索方向；当前对 conformance 无影响

> **本文档为占位设计笔记，非承诺特性。** 文中任何内容都不具有规范性；
> v0.2/v0.3 的任何 schema、状态机或策略行为均不依赖本文。其存在目的是在
> 任何实现工作开始之前，先为讨论搭好结构。

## 摘要

OSAS 目前约束的是*动作*（什么可以执行、依据什么策略），输出侧仅有单一的
`redact` transform。它缺少一个系统性的信息在源（source）与汇（sink）之间
如何流动的模型——例如：Customer 对象中的 PII 是否可以被写入 case note、
escalation 或 webhook。本 RFC 为客服领域勾勒一个信息流控制（IFC）层，并将其
定位为现有 TenantPolicy transforms 的一般化。

## 动机

同类治理栈——尤其是 Microsoft Agent Governance Toolkit——显式建模了 IFC：
数据携带**源标签（source label）**，汇声明**许可级别（clearance）**，决策层
对每条流动（`源标签 → 汇许可`）放行或拒绝。缺少这一层时，策略引擎可以正确地
拦截一笔退款，却仍把客户的卡片元数据泄进发往外部 webhook 的 escalation 备注。

OSAS 当前的空白：

- `redact` 是唯一的输出侧控制，且统一施加；无法表达"PII 可以流入
  `case_note`，但仅在身份已验证时"。
- 审计记录的是*动作*；它无法解释*信息决策*（为什么某字段对一个汇被
  redact，对另一个汇却没有）。
- 多租户隔离在对象层面强制执行，而不是在租户内字段/标签层面。

如果什么都不做，采用者会各自在适配器上叠加 redaction 规则，跨实现彼此
发散，且无法进行 conformance 测试。

## 设计（提案，非规范）

### 客服领域的语义

**数据分级**（挂在字段/对象上的标签，可扩展方式类似 `reasonCode`）：

| 级别 | 示例 |
|---|---|
| `public` | 知识库文章、订单状态、公开物流链接 |
| `internal` | Case 元数据、不含 PII 的客服备注 |
| `pii` | Customer 中的姓名、邮箱、地址、电话 |
| `financial` | 卡片元数据、退款金额、信用余额 |

**汇（sink，信息可流向的目的地）**：

- `case_note`——Case 上的内部备注
- `escalation`——人工升级工单包
- `webhook`——出站第三方集成
- `model_context`——进入模型提示词/上下文的内容

**规则形态**（声明式，存于 TenantPolicy）：

```text
allow pii -> case_note only if identity_verified
deny financial -> webhook
allow financial -> escalation only if escalation.priority >= high
```

评估保持确定性：规则集显式默认拒绝、worst-of 组合，并产生机器可读的
reason code（新增如 `FLOW_DENIED`、`CLEARANCE_INSUFFICIENT`）。

### 与 TenantPolicy transforms 的关系

Transforms 是 IFC 的**执行机制子集**：`redact` 正是"被拒绝的流动在汇边界
上的表现"（丢弃字段，而不是拒绝整个动作）。提议的分层：

1. IFC 决定 `字段 → 汇` 这条流动是否被允许（可以附带 Case 事实条件，如
   `identity_verified`）。
2. 被拒绝时，transform 层施加该汇的默认值：`redact`、`block` 或
   `require_approval`——复用现有 transform 机制，而不是另起一套。

这样保持单一策略文档、单一评估引擎、单一审计流。

### 审计

信息流决策**必须**成为审计事件（与动作决策一样挂哈希链），携带
`{ flow, sourceLabel, sink, decision, reasonCode }`，使监管方或客户能够
追问"为什么这张卡片字段没有出现在这次 escalation 中"，并得到确定性的
答案。

## 兼容性

对既有持久化对象、`specVersion`、端点或工具面均无影响——以上内容全部为
新增。候选新 schema：`schemas/core/information-flow-rule.json`（v0.3 之后）。
compat 套件只有在 RFC 被接受后才会新增 `information-flow` 分组；发布门禁
（schema + 中英文档 + 参考实现 + compat 测试同一 PR 落地）依然适用。

## 安全

主要是防御性的：封堵动作级策略遗漏的"经 escalation/webhook/context 泄漏"
通道。新增攻击面小但真实——模型伪造标签（缓解：标签由引擎附加，绝不来自
模型）与规则复杂性（缓解：沿用与 §5 相同的确定性、默认拒绝的评估语义）。

## 测试计划（若被接受）

- 单元：标签附加、规则评估、worst-of 组合、默认拒绝。
- compat 套件 `information-flow` 分组：已验证时 PII→case_note 放行，否则
  拒绝；financial→webhook 永远拒绝；审计事件入链。
- Runner：conformance reset 播种覆盖每种规则形态的 Case。

## 开放问题

1. **标签粒度**——字段级标签需要给 core 对象加 schema 注解（影响 schema）；
   对象级标签更便宜但更粗。先做哪个？
2. **动态条件**——以 Case 事实为条件的规则（如 `identity_verified`）模糊了
   "确定性策略"与"上下文策略"的边界。哪些事实在范围内，由谁背书？
3. **`model_context` 作为汇**——把 `model_context` 视为汇可以让策略控制模型
   能看到什么，但它与适配器/MCP 层的提示词组装深度耦合。属于规范范围还是
   范围之外？
4. **与多方治理（RFC 0004）的关系**——flow 规则由租户管理员编写，还是仅由
   平台方编写？租户规则与平台规则冲突时谁裁决？
5. **与纯 redact 部署的重叠**——一个实现能否声称用 `redact` transform 完全
   模拟 IFC 即满足 conformance，还是必须实现独立的引擎才能作此声明？
