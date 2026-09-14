# OSAS 与 AG-UI 的配合（审批 UX)

[English](ag-ui-integration.md)

> 本文为集成指南，不是规范性文本。RFC 0002 把 OSAS 定位为横向协议之上的
> 治理 profile;AG-UI 是其中 agent↔UI 的一层。本文给出最重要的共享交互——
> **人对拟议动作的审批**——的具体映射。

## 为什么两者天然互补

OSAS 产出的是*决策点*：被评估为 `require_approval` 的提案会创建一条
`Approval`，在人做出决定之前不会有任何执行。AG-UI 标准化的恰好是 agent
后端如何把这类中断呈现给前端——以前端工具调用和状态事件的形式——双方都
不必发明私有通道。OSAS 决定一个动作**是否**需要人；AG-UI 决定**如何**
向人发问。

边界保持干净：前端绝不直接接触策略引擎，AG-UI 事件也不携带任何权限。
真正改变状态的 HTTP 调用（`POST /v1/approvals/:id/decide`）仍是唯一的
变更路径，照常认证、照常审计。

## 映射关系

场景：通过 `POST /v1/chat` 创建退款提案，策略引擎返回
`require_approval`。

| 步骤 | OSAS 一侧 | AG-UI 一侧 |
|---|---|---|
| 1. Agent 运行开始 | `POST /v1/chat` 被接受 | 后端发出 `RUN_STARTED` |
| 2. 决策要求审批 | 提案 → `pending_approval`；创建 `Approval`；审计 `approval_created` | 后端对一个**前端工具**（如 `render_approval_card`）发出 `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`，参数携带提案 id、动作类型、金额、策略原因与证据链接 |
| 3. 人在 UI 中审查 | （尚无 OSAS 流量） | 前端渲染审批卡片；本次运行保持打开（暂停） |
| 4. 人做出决定 | 前端用已认证的人类主体调用 `POST /v1/approvals/:id/decide`(`approve` / `reject`) | 前端发出携带决定结果的 `TOOL_CALL_RESULT`，让 agent 运行继续 |
| 5. 结果落地 | 批准 →（幂等、有审计的）执行；拒绝 → 审计，不执行 | 后端流式输出结果（`TEXT_MESSAGE_*`)，随后 `RUN_FINISHED` |
| 6. 失败 | 任何 OSAS 错误（`{error:{code,…}}`）映射为用户可见提示 | `RUN_ERROR`,code 放入消息负载 |

状态同步（审批队列计数、审计链徽标）可由 `STATE_SNAPSHOT` /
`STATE_DELTA` 事件承载，数据源是 `GET /v1/approvals` 与
`GET /v1/audit/verify`。

## 集成守则

1. **权限永远不越过 AG-UI。** 审批卡片的参数只是服务端状态的渲染，不是
   决定本身。前端的决定调用带着人类自己的凭据打到 OSAS API；后端重新
   校验角色（`support_agent`/`policy_admin`)，并以 `actorType: "human"`
   记录审计事件。
2. **幂等性覆盖 UI 层。** 聊天 UI 里重试、双击、断线重连都是常态。它们
   被 OSAS 的幂等边界（`(tenantId, idempotencyKey)`）吸收，因此前端可以
   放心重试 `decide`。
3. **前端不发起自动执行。** UI 不得提供由 agent 文本驱动的"执行"按钮；
   执行只能来自服务端决策路径（或 Shadow Mode 审查）。
4. **超时失败即关闭。** 人迟迟不响应时，审批保持 pending——若租户策略
   设置了 `approval.timeoutSeconds`，到期即拒绝（`expired`,
   `APPROVAL_TIMED_OUT`)。AG-UI 的运行**应当**以明确的提示关闭，而不是
   一直挂着。

## 参考落点

- OSAS 审批端面：`GET /v1/approvals`、`POST /v1/approvals/:id/decide`;
  Shadow 审查：`POST /v1/shadow-runs/:id/review`（同一映射也适用于
  shadow-run 审查 UX)。
- 控制台的 `/agent` 页面（`apps/web`）是同一交互的非 AG-UI 实现，可参照
  其审批卡片必须展示的内容（策略原因、证据、金额）。
- AG-UI 协议：https://github.com/ag-ui-protocol/ag-ui ——事件传输
  (SSE/WebSocket）由你选择，OSAS 不关心。

可运行示例已在路线图中跟踪（README → 状态与路线图）；上面的映射就是
它要实现的契约。
