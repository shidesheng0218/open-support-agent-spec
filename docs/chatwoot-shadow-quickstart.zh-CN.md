# Chatwoot Shadow 快速接入

[English](chatwoot-shadow-quickstart.md)

在真实的 [Chatwoot](https://www.chatwoot.com/) 收件箱旁边，以 **Shadow 模式**
运行 OSAS。每收到一条客户消息，Agent 提出一个动作，策略引擎做出判定，OSAS 往会话里写入
**一条私有备注**。不执行任何动作，也不会给客户发送任何内容。

```
Chatwoot webhook ──HMAC 校验──▶ governance 收件箱（去重 / 排序 / 入队）
                                        │  后台循环或 /jobs/drain
                                        ▼
 最近的客户消息 → 注入检测 → 模型提议
   → 策略引擎 → ShadowRun → 在会话里写一条私有备注
```

已对 Chatwoot 4.18.0（自托管，docker）做过一次端到端验证，使用 mock 模型、内存存储和
demo 鉴权。**没有验证**的部分：真实模型、Postgres 存储、`jwt` 鉴权、并发、重试，以及
Chatwoot 不可达的情况。

## 1. 配置 OSAS

| 变量 | 作用 |
|---|---|
| `OSAS_GOVERNANCE_EVENT_CONSUMER=chatwoot-shadow` | 注册 shadow worker。下面三个变量缺失时，启动会直接失败（fail closed）。 |
| `CHATWOOT_BASE_URL`、`CHATWOOT_ACCOUNT_ID`、`CHATWOOT_API_TOKEN` | Chatwoot API 访问。token 以 `api_access_token` 头发送，不会写入日志。 |
| `OSAS_CHATWOOT_WEBHOOK_SECRET_<TENANT>__<CONNECTION>` | webhook 签名密钥，至少 16 个字符。每一段转成大写，非字母数字字符替换为 `_`。租户 `tenant_demo`、连接 `conn_ab12` 对应的变量名是 `OSAS_CHATWOOT_WEBHOOK_SECRET_TENANT_DEMO__CONN_AB12`。 |
| `OSAS_GOVERNANCE_WORKER_INTERVAL_MS` | 可选，最小 250。启动后台循环。不设置就没有定时器，需要自己调用 `POST /v1/governance/jobs/drain`。 |

只要 OSAS 能被本机以外的地方访问，就应使用 `OSAS_AUTH_MODE=jwt`。`/v1/webhooks/*`
路径会跳过 JWT（Chatwoot 发不出 JWT），改为依赖签名。其他所有路径仍然需要 token。

## 2. 创建连接

连接的 `externalAccountId` 必须等于 `CHATWOOT_ACCOUNT_ID`。声明了其他账号的连接，
拿不到 Chatwoot 客户端。

```bash
curl -s -X POST "$OSAS/v1/governance/connections" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"provider":"chatwoot","externalAccountId":"1","capabilities":["ticket.read"]}'
```

连接创建后处于暂停状态，只有 `active` 的连接才会接收事件。参考实现没有自带连接探测
（probe），所以调用 verify 会把连接置为 `error`。参考版本里的激活是通过 store 完成的
（见 `apps/api/src/chatwoot-shadow.test.ts`），生产部署需要提供自己的 probe。

## 3. 在 Chatwoot 里注册 webhook

创建一个**账号级**webhook（`webhook_type: account_type`），订阅 `message_created` 和
`conversation_created`，密钥使用第 1 步中的值：

```
URL:    https://<你的 OSAS 地址>/v1/webhooks/chatwoot/<tenantId>/<connectionId>
Secret: <OSAS_CHATWOOT_WEBHOOK_SECRET_... 的值>
```

在 Chatwoot 4.18.0 的验证中，**收件箱级**的 webhook 记录（`inbox_type`）**没有**投递：
没有产生任何 `WebhookJob`。Chatwoot 的 listener 对 API 收件箱的事件是走渠道自身的
`webhook_url`。请使用账号级 webhook。

Chatwoot 对每次投递的签名为
`X-Chatwoot-Signature: sha256=HMAC-SHA256(secret, "<X-Chatwoot-Timestamp>.<原始 body>")`。
OSAS 对收到的原始字节做校验，允许 5 分钟的时钟偏差，并按 `X-Chatwoot-Delivery` 去重。
缺失、格式错误、过期或错误的签名，以及未知连接、其他租户、未配置密钥，都返回同一个 `401`。

### 自托管 Chatwoot 与内网地址

Chatwoot 通过 `SafeFetch` 发送 webhook。Chatwoot 的 `.env.example` 写明：内网目标默认被
拦截，可以用 `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` 放开。验证时 OSAS 跑在宿主机上，
所以设置了这个开关。**没有**测试过不设置时的表现，因此"默认拦截"只是上游文档的说法，
不是这里观察到的结果。给 OSAS 配一个公网 HTTPS 地址可以绕开这个问题。

当 OSAS 跑在 docker 宿主机上时，不要在 webhook URL 里依赖 `host.docker.internal`。多次运行中
它有时会解析成 IPv6 地址（sidekiq 日志里是 `Failed to open TCP connection to fdc4:...:3001`），
而 OSAS 只监听 IPv4，导致投递丢失。`scripts/e2e-chatwoot.sh` 改为使用容器看到的宿主机 IPv4
地址；改完后连续 5 次运行全部通过。

## 可选：只读的 Shopify 订单证据

设置 `SHOPIFY_SHOP_DOMAIN` 和 `SHOPIFY_ADMIN_ACCESS_TOKEN`（只读权限即可），并创建一个
`provider: "shopify"`、`externalAccountId` 等于店铺域名的 active 连接。之后对订单相关的提议，
worker 会读取订单，**仅当订单邮箱与 Chatwoot 联系人邮箱一致**时才作为证据附上。否则备注会写明
原因（订单不存在、订单属于其他联系人、联系人没有邮箱、没有连接、Shopify 出错），策略照旧拦截。
对 Shopify 只发 GET 请求。

即使附上了证据，Chatwoot 联系人仍是 `unverified`、地区为 `ZZ`，所以退款仍需要人工处理。网页
挂件里的邮箱可以是自行填写的，邮箱匹配只能降低风险，不等于身份验证。

已用伪造的 Shopify HTTP 客户端做过单元测试，**没有**对真实 Shopify 店铺运行过。

## 4. 会话里会出现什么

```
[OSAS shadow] Suggested: refund $20.00 (reason: other)
Policy v1.0.0: blocked by policy
  - IDENTITY_UNVERIFIED: rule requires a verified identity but status is 'unverified'
  - REGION_UNLISTED: customer region 'ZZ' is not in allowedRegions for actionType 'refund'
  - INSUFFICIENT_EVIDENCE: financial actionType 'refund' requires at least one evidence reference
Evidence: none attached (Chatwoot holds no order data)
Not verified against any order system. Check the order before acting.
Shadow mode: nothing has been executed.
Refs: proposal prop_1 / shadow run shadow_...
```

备注里只有 ID、动作和策略原因，不包含客户消息原文和联系方式。

值得知道的行为：

- 只读取客户发送的消息。私有备注和客服回复会被忽略，所以 worker 不会触发自己。
- 疑似提示词注入的文本不会发给模型。worker 写一条简短提示，并记录
  `prompt_injection_blocked` 审计事件。
- 没有对应动作的消息不会产生备注。
- 在这套配置下，退款建议会因为三个相互独立的原因被拦截，而不是一个：Chatwoot 联系人永远是
  `unverified`、地区为 `ZZ`，并且 worker 不附带任何证据。只补订单证据，判定不会改变。
- 失败的任务不会自动重试（入站事件默认按有副作用处理）。进入死信的任务会开启一条对账记录。

## 5. 检查结果

```bash
curl -s "$OSAS/v1/governance/integration-events" -H "authorization: Bearer $TOKEN"
curl -s "$OSAS/v1/governance/jobs"               -H "authorization: Bearer $TOKEN"
curl -s "$OSAS/v1/shadow-runs"                   -H "authorization: Bearer $TOKEN"
```

本次验证的可重复脚本是 [`scripts/e2e-chatwoot.sh`](../scripts/e2e-chatwoot.sh)。它需要
docker，并会拉取约 4 GB 镜像，因此不属于 `pnpm test`，也不进 CI。
