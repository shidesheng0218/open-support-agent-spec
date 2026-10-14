# 7 天实现 OSAS Core Profile

> 目标：用一周时间实现 OSAS 规范的 Core Profile，通过黑盒合规测试，成为候选实现。

[English](implementing-osas-7days.md)

## 前提条件

在开始之前，确保：

- [x] 你熟悉的编程语言有成熟的 **JSON Schema draft-2020-12** 验证库（[实现列表](https://json-schema.org/implementations)）
- [x] HTTP 框架可以处理自定义 header（`x-tenant-id`、`x-osas-role` 等）
- [x] 能计算 SHA-256 并输出小写十六进制
- [x] 能对对象的键做 UTF-16 字典序排序（JavaScript 的默认 sort，Java 的 `String.compareTo`）
- [x] 已阅读 [规范概览](./spec-v0.2.zh-CN.md) 或 [英文版](./spec-v0.2.md)

**工具准备：**

```bash
# 安装黑盒测试器（需要 Node.js 20+）
npm install -g @osas/compat-runner

# 或用 npx 直接运行
npx @osas/compat-runner --target http://localhost:8080
```

**项目结构建议：**

```
my-osas-implementation/
├── src/
│   ├── server.{ts,py,go,java}      # HTTP 服务器入口
│   ├── policy-engine.{...}          # 策略求值引擎
│   ├── storage.{...}                # 策略/提案/事件存储
│   ├── audit-chain.{...}            # 事件哈希链
│   └── conformance.{...}            # Conformance Mode 端点
├── schemas/                         # 从 OSAS 仓库复制
│   ├── manifest.json
│   └── core/
├── tests/
│   └── test-vectors.{...}           # 单元测试：stable-json、audit-chain 等
└── README.md
```

---

## Day 1：搭建脚手架 + Discovery

**目标：** 启动 HTTP 服务器，实现服务发现端点，通过 `discovery` 套件。

### 1.1 复制 Schema 文件

从 OSAS 仓库复制 `schemas/` 目录到你的项目：

```bash
git clone https://github.com/shidesheng0218/open-support-agent-spec.git /tmp/osas
cp -r /tmp/osas/schemas ./schemas
```

你需要 `schemas/manifest.json` 和 `schemas/core/` 下的所有 JSON Schema 文件。

### 1.2 实现 Discovery 端点

**`GET /.well-known/osas`**

```json
{
  "specVersion": "0.2",
  "version": "0.2.1",
  "executionMode": "shadow",
  "capabilities": { ... }
}
```

- `executionMode` 固定为 `"shadow"`（live 模式需要真实后端集成，超出本教程范围）
- `capabilities` 是下一步要返回的 CapabilityManifest

**`GET /v1/capabilities`**

返回你的实现支持的 profiles 和 capabilities：

```json
{
  "specVersion": "0.2",
  "implementationId": "my-osas-go",
  "implementationVersion": "0.1.0",
  "profiles": [
    {
      "name": "core",
      "capabilities": [
        "case.read",
        "customer.read",
        "knowledge.read",
        "evidence.read",
        "note.write",
        "escalation.write",
        "proposal.write",
        "approval.read",
        "approval.write"
      ]
    },
    {
      "name": "ecommerce",
      "capabilities": [
        "order.read",
        "refund.execute",
        "exchange.execute",
        "cancel_order.execute",
        "update_shipping_address.execute"
      ]
    }
  ],
  "modelGateway": "none"
}
```

**参考：** `packages/core/src/capability-manifest.ts` 定义了所有标准 capabilities。

### 1.3 验证

```bash
# 启动你的服务器
./my-osas-server --port 8080

# 在另一个终端运行测试器
npx @osas/compat-runner --target http://localhost:8080
```

**预期：** `discovery` 套件的 4 项检查全部通过。

---

## Day 2：Schema 校验

**目标：** 集成 JSON Schema 验证，实现 `/v1/schemas` 和 `/v1/validate`，通过 `schemas-tools` 套件。

### 2.1 加载 Schema 注册表

从 `schemas/manifest.json` 读取所有 schema 的 `$id`，构建一个 schema 注册表：

```python
# Python 示例（使用 jsonschema 库）
import json
from pathlib import Path
from jsonschema import Draft202012Validator, RefResolver

schemas_dir = Path("schemas")
manifest = json.loads((schemas_dir / "manifest.json").read_text())
store = {}

for item in manifest["schemas"]:
    schema_path = schemas_dir / item["path"]
    schema = json.loads(schema_path.read_text())
    store[schema["$id"]] = schema

# 创建 resolver（支持 $ref 引用）
resolver = RefResolver.from_schema(
    {"$id": "https://osas.ai/v/0.2/core/common.json"},  # 基准 URI
    store=store
)
```

### 2.2 实现端点

**`GET /v1/schemas`**

返回 `schemas/manifest.json` 的内容（或动态构建）：

```json
{
  "specVersion": "0.2",
  "schemas": [
    {
      "name": "core/common",
      "profile": "core",
      "path": "core/common.json"
    },
    ...
  ]
}
```

**`GET /v1/schemas/:name`**

返回对应的 JSON Schema。例如 `GET /v1/schemas/core/action-proposal` 返回 `schemas/core/action-proposal.json` 的内容。

**`POST /v1/validate`**

请求体：
```json
{
  "schema": "core/action-proposal",
  "data": { ... }
}
```

响应：
```json
{
  "valid": true
}
```

或失败时：
```json
{
  "valid": false,
  "errors": [ ... ]
}
```

**注意：** 相对引用如 `./common.json#/$defs/Amount` 必须能解析。大多数验证库需要配置 resolver。

### 2.3 验证

```bash
npx @osas/compat-runner --target http://localhost:8080
```

**预期：** `schemas-tools` 套件的 5 项检查全部通过。

---

## Day 3：策略存储 + 只读端点

**目标：** 实现策略的内存存储和只读端点，通过 `policy-read` 套件。

### 3.1 设计存储接口

```go
// Go 示例
type PolicyStore interface {
    GetPolicy(tenantID string) (*TenantPolicy, error)
    ListPolicies(tenantID string) ([]TenantPolicy, error)
}

type MemoryStore struct {
    policies map[string]TenantPolicy
}
```

启动时加载一个演示策略（或者在 Conformance Mode 里动态加载）。

### 3.2 实现只读端点

**`GET /v1/policies/:tenant`**

返回租户的当前活跃策略：

```json
{
  "id": "pol_demo",
  "specVersion": "0.2",
  "tenantId": "tenant_demo",
  "version": 1,
  "status": "active",
  "duplicateWindowSeconds": 86400,
  "maxEvidenceAgeSeconds": 604800,
  "rules": [
    {
      "actionType": "refund",
      "decision": "auto_execute",
      "maxAmount": { "currency": "USD", "minorUnits": 5000 },
      "reasonCodes": ["damaged", "wrong_item", "not_received"]
    }
  ],
  "defaultDecision": "block",
  "createdAt": "2026-01-15T10:00:00.000Z",
  "updatedAt": "2026-01-15T10:00:00.000Z",
  "createdBy": {
    "actorType": "human",
    "actorId": "admin_1",
    "role": "policy_admin"
  }
}
```

**`GET /v1/policies/:tenant/history`**

返回策略版本历史（按版本号降序）：

```json
{
  "policies": [ ... ]
}
```

**租户隔离：** 检查请求的 `x-tenant-id` header，如果与路径中的 `:tenant` 不匹配，返回 `403 TENANT_MISMATCH`。

### 3.3 验证

```bash
npx @osas/compat-runner --target http://localhost:8080
```

**预期：** `policy-read` 套件通过（3-4 项检查）。

---

## Day 4：策略求值引擎

**目标：** 实现核心的 11 项检查策略求值算法，处理 `/v1/proposals/:id/evaluate`。

### 4.1 移植求值算法

参考 `packages/policy-engine/src/evaluate.ts`，实现 11 项检查（规范 §5）：

```rust
// Rust 伪代码
pub fn evaluate_proposal(
    proposal: &ActionProposal,
    policy: &TenantPolicy,
    evidence: &[Evidence],
    recent_proposals: &[ActionProposal],
    injection_suspected: bool,
    now: DateTime<Utc>,
) -> PolicyDecision {
    let mut reasons = Vec::new();

    // Check 1: PERMISSION_OVERREACH
    if proposal.requested_by.actor_type == "model" 
       && proposal.requested_permission == "execute" {
        reasons.push(Reason {
            code: "PERMISSION_OVERREACH",
            message: "model principals are capped at request-approval".into(),
        });
    }

    // Check 2: PROMPT_INJECTION_SUSPECTED
    if injection_suspected {
        reasons.push(Reason {
            code: "PROMPT_INJECTION_SUSPECTED",
            message: "prompt injection suspected".into(),
        });
    }

    // Check 3-11: 见规范或参考实现
    // ...

    // 决策汇总：取最差的决策
    let decision = if reasons.iter().any(|r| is_blocking_reason(r)) {
        "block"
    } else if reasons.iter().any(|r| is_approval_reason(r)) {
        "require_approval"
    } else if let Some(rule) = find_matching_rule(proposal, policy) {
        rule.decision.clone()
    } else {
        policy.default_decision.clone()
    };

    PolicyDecision { decision, reasons }
}
```

### 4.2 单元测试

在继续实现 HTTP 端点之前，先用测试向量验证算法：

```bash
# 从 OSAS 仓库获取测试向量
curl -O https://raw.githubusercontent.com/shidesheng0218/open-support-agent-spec/main/conformance/test-vectors/policy-evaluation.json

# 在你的测试中加载并验证
```

参考 [conformance/test-vectors/README.zh-CN.md](../conformance/test-vectors/README.zh-CN.md)。

### 4.3 实现 evaluate 端点

**`POST /v1/proposals/:id/evaluate`**

请求体示例：
```json
{
  "proposal": { ... },
  "evidence": [ ... ],
  "context": {
    "injectionSuspected": false
  }
}
```

响应：
```json
{
  "decision": "auto_execute",
  "reasons": []
}
```

**注意：** 你还需要查询最近的提案（duplicate check）和租户的策略。

### 4.4 验证

此时 compat runner 还不会检查 evaluate 端点（它在 stateful 套件里），但你可以手动测试或等到 Day 6。

---

## Day 5：Conformance Mode + 策略生命周期

**目标：** 实现 Conformance Mode，支持策略的状态机转换（draft → simulated → approved → active → retired）。

### 5.1 Conformance Mode 端点

**`POST /v1/conformance/reset`**

请求体：
```json
{
  "fixture": "demo-tenant"
}
```

从 `conformance/fixtures/demo-tenant.json` 加载预定义的租户、策略、案例数据，重置所有状态。

**启动条件：** 服务器必须设置环境变量 `OSAS_CONFORMANCE_MODE=true`，并检查请求的 `x-osas-conformance-key` header 是否匹配你设定的密钥（比如环境变量 `OSAS_CONFORMANCE_KEY`）。

**安全警告：** 永远不要在生产环境启用 Conformance Mode——它允许重置所有数据。

### 5.2 策略生命周期状态机

实现以下转换（规范 §4.3）：

```
draft --[simulate]--> simulated --[approve]--> approved --[activate]--> active --[retire]--> retired
```

**端点：**

- `POST /v1/policies/:tenant/draft` — 创建 draft 策略
- `POST /v1/policies/:tenant/:policyId/simulate` — draft → simulated
- `POST /v1/policies/:tenant/:policyId/approve` — simulated → approved
- `POST /v1/policies/:tenant/:policyId/activate` — approved → active
- `POST /v1/policies/:tenant/:policyId/retire` — active → retired

**RBAC 检查：** 只有 `policy_admin` 角色可以操作策略（检查 `x-osas-role` header）。

### 5.3 验证

```bash
# 启动服务器时设置
export OSAS_CONFORMANCE_MODE=true
export OSAS_CONFORMANCE_KEY=test-key-12345
./my-osas-server --port 8080

# 运行 stateful 套件
npx @osas/compat-runner \
  --target http://localhost:8080 \
  --conformance-key test-key-12345
```

**预期：** `stateful` 套件的前 6-8 项检查开始通过（策略生命周期部分）。

---

## Day 6：幂等执行 + 审计链

**目标：** 实现幂等性、审计事件哈希链，通过完整的 `stateful` 套件。

### 6.1 实现 stable JSON 序列化

这是所有哈希计算的基础。参考 `packages/policy-engine/src/stable-stringify.ts`：

```java
// Java 示例
public static String stableStringify(Object obj) {
    if (obj == null) return "null";
    if (obj instanceof String) return JSONObject.quote((String) obj);
    if (obj instanceof Number || obj instanceof Boolean) return obj.toString();
    if (obj instanceof List) {
        List<?> list = (List<?>) obj;
        return list.stream()
            .map(StableJson::stableStringify)
            .collect(Collectors.joining(",", "[", "]"));
    }
    if (obj instanceof Map) {
        Map<?, ?> map = (Map<?, ?>) obj;
        return map.entrySet().stream()
            .sorted(Map.Entry.comparingByKey(Comparator.comparing(Object::toString)))
            .map(e -> JSONObject.quote(e.getKey().toString()) + ":" + stableStringify(e.getValue()))
            .collect(Collectors.joining(",", "{", "}"));
    }
    throw new IllegalArgumentException("Unsupported type: " + obj.getClass());
}
```

**单元测试：** 用 `conformance/test-vectors/stable-json.json` 验证你的实现。

### 6.2 实现审计链

**审计事件哈希：**

```
eventHash = lowercase_hex(SHA-256(UTF-8(stableStringify(event without eventHash))))
```

**链规则：**
- 第一个事件的 `previousHash` 是 64 个零字符
- 后续事件的 `previousHash` 是前一个事件的 `eventHash`
- `sequence` 从 1 开始，每个事件递增 1

**`GET /v1/audit/verify`**

验证租户的审计链，返回：

```json
{
  "intact": true,
  "chainLength": 42
}
```

或检测到篡改：

```json
{
  "intact": false,
  "chainLength": 42,
  "firstError": {
    "eventId": "evt_123",
    "sequence": 15,
    "reason": "event_hash_mismatch",
    "expectedEventHash": "abc...",
    "actualEventHash": "def..."
  }
}
```

**单元测试：** 用 `conformance/test-vectors/audit-chain.json` 验证。

### 6.3 幂等性

对于所有写操作（simulate、approve、activate、execute 等），支持 `idempotencyKey`：

```json
{
  "idempotencyKey": "unique-key-12345",
  ...
}
```

存储 `(tenantId, idempotencyKey)` → 结果映射。重复请求返回原结果 + `replayed: true`。

### 6.4 验证

```bash
npx @osas/compat-runner \
  --target http://localhost:8080 \
  --conformance-key test-key-12345 \
  --verbose
```

**预期：** `stateful` 套件全部通过（15-20 项检查），`gateOk: true`。

---

## Day 7：RBAC + 租户隔离 + 清理

**目标：** 实现权限检查，修复边界情况，通过完整的合规测试。

### 7.1 RBAC 实现

根据 `x-osas-role` header 检查权限：

| 操作 | 允许的角色 |
|---|---|
| 策略读取 | `policy_admin`, `support_agent` |
| 策略写入（draft/simulate/approve/activate/retire） | `policy_admin` |
| 提案评估/执行 | `policy_admin`, `support_agent` |
| 批准决策 | `support_agent` |

如果角色不足，返回 `403 FORBIDDEN`。

### 7.2 租户隔离

所有端点都必须检查：
- 路径中的 `:tenant` 参数
- `x-tenant-id` header

如果不匹配，返回 `403 TENANT_MISMATCH`。

### 7.3 边界情况

常见坑：
- **金额比较：** 必须用整数（minorUnits），不要用浮点数
- **absent 字段：** JSON 序列化时不要输出 `null`，直接省略
- **时间窗口：** `duplicateWindowSeconds` 和 `maxEvidenceAgeSeconds` 用秒为单位
- **空规则：** 如果策略没有匹配规则，返回 `defaultDecision`

### 7.4 最终验证

```bash
# 完整测试（包括 stateful）
npx @osas/compat-runner \
  --target http://localhost:8080 \
  --conformance-key test-key-12345

# 检查报告
cat compat-report.json | jq '.gateOk, .totals'
```

**目标：** `gateOk: true`, `failed: 0`, `skipped: 0`。

---

## 提交兼容性声明

通过测试后，提交 GitHub issue（使用 `.github/ISSUE_TEMPLATE/compatibility_claim.yml` 模板）：

1. 填写你的实现信息（语言、仓库、版本）
2. 粘贴 compat runner 的完整 JSON 报告
3. 说明是否计划独立维护（成为"独立实现"）

OSAS maintainers 会验证并将你加入 `conformance/implementations.json`。

---

## 常见问题

### Q: 我的语言没有 draft-2020-12 验证库怎么办？

如果只有 draft-07 或 draft-2019-09，可以先用它们（OSAS schemas 大部分向后兼容），但在 README 里注明。未来你需要升级。

### Q: 我可以跳过某些端点吗？

不行。`gateOk: true` 要求通过所有检查。但你可以先实现只读端点（跳过 stateful 套件），拿到 `ok: true`（不是 `gateOk`）。

### Q: 审计链验证一直失败

最常见原因：
1. stable_json 实现不正确（键排序、空白字符、null 处理）
2. 在哈希前包含了 `eventHash` 字段
3. 哈希输出用了大写十六进制

用测试向量逐个验证 `stable-json.json` → `audit-chain.json`。

### Q: 策略求值决策不对

常见错误：
1. 只返回第一个失败的 reason（应该收集所有）
2. 决策严重程度排序错误（`block` > `require_approval` > `auto_execute`）
3. 没有按顺序检查全部 11 项

用 `conformance/test-vectors/policy-evaluation.json` 单元测试每个向量。

### Q: 7 天太紧张了

核心路径（只读 + 策略求值）可以在 3-4 天完成，拿到 `ok: true`。stateful 套件（生命周期 + 审计链）再花 2-3 天。如果时间紧张，先做只读部分，提交 candidate 声明。

---

## 下一步

- **加入治理：** 当 ≥3 个独立实现通过测试后，OSAS 将进入 v1.0 多方治理阶段（见 [GOVERNANCE.md](../GOVERNANCE.md)）
- **扩展 profiles：** 实现 SaaS profile（ticket、subscription、user 等）或自定义 profile
- **集成真实后端：** 将 `executionMode` 从 `shadow` 切换到 `live`，连接 Shopify、Zendesk 等

## 获取帮助

- 开 issue 带 `implementation` 标签
- 加入讨论区（待建立）
- 阅读 [implementing-osas.zh-CN.md](./implementing-osas.zh-CN.md)（完整实现指南）
