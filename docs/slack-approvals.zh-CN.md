# Slack 审批卡片

策略引擎返回 `require_approval` 时，OSAS 可以向一个 Slack 频道发一张卡片。审批人点击“Approve”
或“Reject”。点击走的代码与 `POST /v1/approvals/:id/decide` 相同（`decideApprovalCore`），所以
过期处理、审计、执行时的 `actionDigest` 校验都与 REST 路径一致。

状态：已用伪造的 Slack HTTP 客户端做过单元测试，**没有**对真实 Slack 工作区运行过。

## 配置

四个变量必须一起设置，只设一部分会导致启动失败。

```bash
SLACK_BOT_TOKEN=xoxb-...             # 权限：chat:write
SLACK_SIGNING_SECRET=...             # 至少 16 个字符
SLACK_APPROVAL_CHANNEL=C0123ABCD     # 频道 ID，不是名称；需要把 bot 邀请进频道
OSAS_SLACK_APPROVERS=U0123ABCD=tenant_demo:alice,U0456EFGH=tenant_demo:bob
# 可选
SLACK_TEAM_ID=T0123ABCD
```

在 Slack 应用里开启 Interactivity，请求地址填
`https://<你的域名>/v1/webhooks/slack/interactivity`。Slack 必须能访问这个地址，所以本地运行的
OSAS 需要隧道或公网主机。

## 已强制执行的约束

- 签名：对原始请求字节校验 `X-Slack-Signature`，时间窗 300 秒。任何失败都返回同样的 401。
- 谁能审批：只有 `OSAS_SLACK_APPROVERS` 里列出的 Slack 用户。每人对应一个 OSAS 审批人 id 和一个租户，
  审批记录通过该租户读取，所以租户 A 的审批人碰不到租户 B。
- 批准的是什么：按钮携带审批的 `actionDigest`。如果摘要不一致，或提案现在的摘要已与审批不符，点击会被拒绝。
- 只决定一次：再次点击时发现审批已决定，什么都不做。
- 已过期的审批视为拒绝，与 REST 路径一致。
- 来源：来自其他频道的点击会被忽略；设置了 `SLACK_TEAM_ID` 时，其他工作区的点击也会被忽略。
- 卡片只含动作、金额、原因、订单号、id 和摘要前缀，不含客户原文和联系方式。插入的文字已做 Slack mrkdwn 转义。
- Slack 不可用时，不会让创建审批的那次评估失败；卡片不发，审批仍在控制台里待处理。
- 如果某个租户没有映射的审批人，就不会为它发卡片。

## 限制

- Slack 只负责认证用户。OSAS 信任的是你配置的“用户 id 到审批人”的映射，请像访问控制列表一样审查它。
- Slack 用户 id 会写进审批备注；审计里的操作者是映射后的 OSAS 审批人 id。
- 卡片只在创建审批时发一次，没有重试队列，也不会提醒未处理的审批。
- 通过 REST 路径或 Chatwoot 影子 worker 创建的审批是另外的路径。影子 worker 从不创建审批。
- 未验证：真实 Slack 工作区、Slack 对同一次点击的重试、Postgres 存储、两个审批人同时点击。
