# 治理运行时（M1）

治理控制平面：组织、工作区、连接、可靠事件摄入、作业队列、对账与受治案件——从结构上就与厂商无关（见 [ADR 0001](adr/0001-platform-scope.zh-CN.md)）。

包：[`@osas/governance`](../packages/governance) · HTTP 接口：`/v1/governance/*`（见 `GET /v1/openapi.json`）。

## 为什么需要这一层

OSAS 运行时回答“这个动作是否允许发生”。治理层回答的是每个真实部署都会立刻遇到的一组问题：

- 这是哪个租户？租户内谁可以操作什么？
- 这个集成真的连上了吗？它被允许做什么？
- 同一个事件到达了两次，怎么办？
- 事件**迟到**了，怎么办？
- worker 在写入过程中挂了，那件事到底发生了没有？

这些问题在这里都有一个 fail-closed 的答案，而不是一个“看起来合理”的默认值。

## 领域模型

| 记录 | 用途 |
|---|---|
| `Organization` | 账号级边界。 |
| `Workspace` | 租户隔离单位。拥有唯一 `tenantId`；这个 1:1 映射让本层可以架在既有租户级存储之上。 |
| `Membership` | 主体的角色绑定，可限定到工作区或整个组织。 |
| `Connection` | 指向某个外部账号的租户级连接，带声明式能力与不透明凭据引用。 |
| `IntegrationEvent` | 一条投递事件的收件箱记录，按 provider 身份去重。 |
| `JobRun` | 带租约、重试分类与硬截止时间的排队作业。 |
| `Reconciliation` | 不确定结果唯一允许的落点。 |
| `GovernedCase` | 厂商中立的案件记录；通过 evidence/proposal/approval id 与核心运行时衔接。 |
| `GovernanceUsageEvent` | 控制平面计量：按受治对象计数，绝不按 token 计费。 |

### 两条必须明确的不变量

**绝不存储密钥。** 连接只保存 `credentialRef`——一个带 scheme 的指针（`vault:secret/data/osas/acme`、`env:ACME_TOKEN`、`aws-sm:prod/osas/acme`）。凡是看起来像 token 的值（各厂商 key 前缀、JWT、`Bearer` 字符串、AWS key id）或没有 scheme 的值，都会被拒绝并返回 `SECRET_REFUSED`。这条规则是结构性的，不依赖熵判断，因此泄露的请求体不会变成泄露的数据行。

**治理角色绝不扩大权限阶梯。** 控制平面能力（`connection:write`、`approval:decide` 等）与适配器权限阶梯（`read < draft < request-approval < execute`）是两个独立维度。任何治理角色都不会映射到 `execute`，`system_executor` 也不映射到任何治理角色。

## 连接生命周期

```
创建 ──► paused ──verify(成功)──► active ──pause──► paused
            │                       │                │
            └──verify(失败)──► error └──revoke──► revoked ──► 删除
                                     ▲
                      rotate ────────┘（回到 paused）
```

- **新连接一律 paused。** 在探测证明其可用之前，任何东西都不能使用它。探测失败会把它留在 `error` 并记录错误码。
- **恢复前必须先成功验证过。** 未经验证的连接无法解除暂停。
- **轮换凭据后回到 paused**，因为新凭据尚未被证明可用。
- **只有已撤销的连接才能删除**，避免活跃集成在仍有进行中工作时被移除。
- **同一 provider 账号只能有一条存活连接。** 两条连接读同一账号会导致每个事件被重复摄入；第二次创建会得到冲突。
- **声明写能力必须带凭据引用。** 声称能写却没有任何认证方式，属于配置错误。

## 可靠摄入

```
投递 ──► 验签通过？ ──否──► 直接拒绝（绝不占用去重键）
              │是
              ▼
          重复？ ──是──► 记录为 "duplicate"，不产生作业
              │否
              ▼
     落后于水位线？ ──是──► "stale_ignored" + 对账 + 回读作业
              │否
              ▼
          "received" + 一个作业（请求内绝不执行）
```

- **去重键就是 provider 的身份**：`(tenantId, connectionId, topic, externalEventId)`。即使并发投递，重放也不可能产生第二行。
- **未验签的投递在插入前就被拒绝。** 如果伪造事件能占用去重键，攻击者就能压制随后到达的真实投递。
- **排序使用 provider 时间戳，绝不使用接收时间。** 落后于已接受水位线的事件会被标记为 `stale_ignored`，打开一条对账，并排队一个**只读回读作业**。过期 payload 绝不会被应用。
- **摄入不等于执行。** 接收事件的 HTTP 请求只负责入队，绝不执行任何动作。

## 作业、租约与重试分类

重试分类是安全属性，不是可调参数：

| 重试分类 | 用于 | 失败时 |
|---|---|---|
| `safe_read` | 幂等读取（`reconciliation.refetch`） | 以指数退避重新入队，直到 `maxAttempts` |
| `side_effecting` | 任何可能已改变 provider 状态的操作 | **永不自动重试**——进入死信并开启对账 |

- **只领取自己跑得了的作业。** worker 只领取已注册处理器的作业类型，未处理的作业会留在队列里可见，而不是被领取后销毁。
- **用租约，不用锁。** 领取是原子的（PostgreSQL 上使用 `FOR UPDATE SKIP LOCKED`），两个 worker 无法领取同一作业。worker 崩溃只会留下一个会过期的租约。
- **副作用作业的租约过期等于结果未知。** 清扫会将其置为死信并开启对账；绝不静默重试。
- **没有“failed”这种停留态。** 作业失败要么允许重试回到 `queued`，要么进入 `dead_letter`，因此“这件事还会发生吗”可以仅凭状态回答。

## 对账

对账是不确定性唯一允许的落点。它由运行时创建，模型或外部调用者永远不能创建；并且按 `(tenantId, dedupeKey)` 幂等：

| 原因 | 触发场景 |
|---|---|
| `unknown_outcome` | 副作用作业进入死信，或其 worker 租约过期 |
| `out_of_order_event` | 事件落后于已接受水位线 |
| `provider_error` | 预留给已分类的 provider 故障 |
| `manual` | 由操作者手动开启 |

决策是一次性的 compare-and-set：必须带上读取时的版本，记录由谁以何种方式解决，并拒绝第二次决策。解决时会向 OSAS 审计链写入 `reconciliation_resolved` 事件——这是既有的规范事件类型，因此治理平面无需修改 schema 即可接入审计链。

## 受治案件状态机

```
intake ─► evidence_required ─► proposed ─► pending_approval ─► executing ─► resolved
   │             │                │               │               │
   └─────────────┴────────────────┴───────────────┴───────────────┴──► blocked
                                              executing ─► reconciliation_required ─► resolved
```

`resolved` 是终态。`reconciliation_required` 刻意**不是**终态：不确定的结果必须始终对人类可达。状态迁移在 compare-and-set 内校验，因此并发或非法迁移不会写入任何内容。

## HTTP 接口

| 方法与路径 | 用途 |
|---|---|
| `GET /v1/governance/health` | 控制平面快照：连接、收件箱、队列、未结对账、计量 |
| `POST /v1/governance/workspaces` | 创建组织/工作区（按租户幂等） |
| `GET\|POST /v1/governance/connections` | 列出 / 创建连接 |
| `GET\|DELETE /v1/governance/connections/{id}` | 读取 / 删除（需先撤销） |
| `POST /v1/governance/connections/{id}/verify\|pause\|resume\|rotate\|revoke` | 生命周期 |
| `POST /v1/governance/integration-events` | 内部摄入（去重，请求内绝不执行） |
| `GET /v1/governance/integration-events` | 收件箱记录 |
| `GET /v1/governance/jobs` | 作业队列 |
| `POST /v1/governance/jobs/drain` | 对本租户执行一次 worker 清扫（`job:operate`） |
| `GET /v1/governance/reconciliations` | 对账记录 |
| `POST /v1/governance/reconciliations/{id}/decide` | 解决或驳回（一次性） |
| `GET /v1/governance/usage` | 控制平面计量 |

每个路由都限定在已认证主体所属租户内，并由治理能力矩阵把关。路由自身除了声明所需能力外，不自行决定授权。

### 角色

| 角色 | 适用对象 | 主要限制 |
|---|---|---|
| `owner` | 账号所有者 | 唯一可改写组织边界的角色 |
| `admin` | 平台管理 | 除 `organization:write` 外全部 |
| `operator` | 日常队列处理 | **不能决策审批** |
| `approver` | 授权与对账 | **不能修改连接、成员或案件** |
| `auditor` | 审查 | 只读 |
| `viewer` | 相关方 | 仅案件、审批与审计 |

默认映射中只有 `support_agent` 会得到 `operator`；角色未授予任何能力的主体依然什么都拿不到——不存在隐式授权。

## 配置

| 变量 | 含义 |
|---|---|
| `OSAS_STORAGE`、`DATABASE_URL` | `postgres` 时控制平面绑定 PostgreSQL，否则使用内存实现 |
| `OSAS_GOVERNANCE_EVENT_KEY` | 事件摄入的内部密钥。**未设置即关闭该端点。** |
| `OSAS_GOVERNANCE_EVENT_CONSUMER` | `none`（默认）或 `record-only` |

### 关于 `record-only`

参考 API 可以注册一个*仅记录*的事件消费者：它只推进收件箱状态机，**不执行任何业务动作**。它默认关闭，必须显式开启——因为一个不做实事却报告成功的消费者，恰恰是本代码库拒绝隐式表达的那种谎言。真实部署应注册真正干活的处理器。

## M1 不做的事

- 没有策略编辑与审批队列界面（M2）。
- 没有治理操作的审计检索，也没有新增审计事件类型——扩展规范的 `eventType` 枚举需要走 RFC（M2）。
- 不执行任何动作。控制平面负责开通连接与路由工作，绝不执行业务动作。
- 不内置 provider 探测：验证依赖部署方提供的 probe，缺失时 fail closed（`NO_PROBE_CONFIGURED`）。

## 如何验证

```bash
pnpm --filter @osas/governance run test        # 领域、RBAC、生命周期、摄入、作业
pnpm --filter @osas/api run test               # HTTP 接口与租户隔离
DATABASE_URL=... pnpm --filter @osas/store-postgres run test   # PostgreSQL 存储一致性
```

PostgreSQL 测试以 `DATABASE_URL` 为开关：未设置时自动跳过，因此 `pnpm test` 不依赖任何外部服务。
