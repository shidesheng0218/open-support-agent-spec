# OSAS 实现者自检清单

在运行黑盒 compat runner 之前，用这个清单验证你的实现已经准备好。每一项都映射到常见的失败模式。

[English](implementer-checklist.md)

## ✅ 基础设施 (Day 1)

- [ ] **HTTP 服务器启动并监听**  
  测试：`curl http://localhost:8080/.well-known/osas` 返回 200  
  常见问题：端口冲突、防火墙拦截

- [ ] **自定义 header 传递**  
  测试：日志里能看到 `x-tenant-id` 和 `x-osas-role` 的值  
  常见问题：框架默认丢弃 `x-*` header、大小写规范化错误

- [ ] **JSON 请求体解析**  
  测试：`POST /v1/validate` 能接收 JSON  
  常见问题：忘记设置 `Content-Type: application/json`、字符编码问题

- [ ] **错误响应格式符合规范**  
  测试：403 错误返回 `{ "error": { "code": "FORBIDDEN", "message": "..." } }`  
  常见问题：返回纯文本或 HTML 错误页

## ✅ Schema 验证 (Day 2)

- [ ] **加载了所有 schema 文件**  
  测试：`GET /v1/schemas` 返回 >30 个 schemas  
  常见问题：只加载了部分文件、路径错误

- [ ] **$ref 引用能解析**  
  测试：验证 `{ "amount": { "currency": "USD", "minorUnits": 5000 } }` 对 `core/action-proposal` schema 成功  
  常见问题：相对路径 `./common.json#/$defs/Amount` 解析失败

- [ ] **draft-2020-12 特性支持**  
  测试：`$defs`、`unevaluatedProperties`、`prefixItems` 等能正确验证  
  常见问题：验证库版本太老（只支持 draft-07）

- [ ] **验证失败返回详细错误**  
  测试：发送无效数据，检查 `errors` 数组是否包含路径和原因  
  常见问题：只返回 `{ "valid": false }` 没有 `errors`

## ✅ Stable JSON (Day 3-6 前提)

这是所有哈希计算的基础，必须 100% 正确。

- [ ] **对象键按字典序排序**  
  测试：`{ z: 1, a: 2 }` → `{"a":2,"z":1}`  
  常见问题：使用了插入顺序、locale-aware 排序

- [ ] **没有空白字符**  
  测试：输出不包含空格、换行符、制表符  
  常见问题：`JSON.stringify(obj, null, 2)` 带缩进

- [ ] **递归对嵌套对象排序**  
  测试：`{ b: { z: 1, a: 2 }, a: 3 }` → `{"a":3,"b":{"a":2,"z":1}}`  
  常见问题：只排序顶层键

- [ ] **数组保持原顺序**  
  测试：`[3, 1, 2]` → `[3,1,2]`  
  常见问题：对数组元素排序

- [ ] **null 序列化为 null**  
  测试：`{ a: null }` → `{"a":null}`  
  常见问题：省略 null 值

- [ ] **非 ASCII 字符不转义**  
  测试：`{ emoji: "🚀" }` → `{"emoji":"🚀"}`（不是 `\uD83D\uDE80`）  
  常见问题：`ensure_ascii=True`、`escapeUnicode`

- [ ] **通过测试向量**  
  运行：`conformance/test-vectors/stable-json.json` 的 11 个向量全部通过  
  如果失败：逐个调试，这是后续所有功能的基础

## ✅ 策略存储 (Day 3)

- [ ] **租户隔离**  
  测试：`GET /v1/policies/tenant_a` 只返回 tenant_a 的策略  
  常见问题：返回了所有租户的数据

- [ ] **header 和路径一致性检查**  
  测试：`GET /v1/policies/tenant_a` 带 `x-tenant-id: tenant_b` → 403 TENANT_MISMATCH  
  常见问题：只检查路径参数，忽略 header

- [ ] **版本历史按降序排列**  
  测试：`GET /v1/policies/:tenant/history` 的 `policies[0].version` > `policies[1].version`  
  常见问题：升序排列、随机顺序

- [ ] **absent 字段不出现在 JSON**  
  测试：Policy 的 `retiredAt` 字段如果未设置，JSON 里不应该有 `"retiredAt": null`  
  常见问题：序列化所有字段包括 null

## ✅ 策略求值 (Day 4)

- [ ] **11 项检查按顺序执行**  
  测试：一个提案触发多个原因时，`reasons` 数组顺序符合规范 §5  
  常见问题：只返回第一个失败的原因

- [ ] **收集所有原因**  
  测试：超额 + 证据不足 → `reasons` 包含 OVER_THRESHOLD 和 INSUFFICIENT_EVIDENCE  
  常见问题：遇到第一个失败就 return

- [ ] **决策汇总逻辑正确**  
  测试：block 原因 + 其他原因 → decision: "block"（不是 "require_approval"）  
  常见问题：决策严重程度排序错误

- [ ] **金额比较用整数**  
  测试：`minorUnits: 5000` vs `maxAmount.minorUnits: 5000` 判断为相等  
  常见问题：转换成浮点数比较（50.00）导致精度问题

- [ ] **duplicate check 时间窗口**  
  测试：86400 秒内的重复提案被检测到  
  常见问题：用毫秒、日期字符串比较

- [ ] **evidence 年龄计算**  
  测试：8 天前的证据在 7 天窗口内 → EVIDENCE_STALE  
  常见问题：用墙上时钟时间而不是 `now` 参数

- [ ] **通过测试向量**  
  运行：`conformance/test-vectors/policy-evaluation.json` 的 5 个向量全部通过

## ✅ 策略生命周期 (Day 5)

- [ ] **状态转换验证**  
  测试：不能从 draft 直接 activate，必须先 simulate 再 approve  
  常见问题：缺少前置状态检查

- [ ] **RBAC 检查**  
  测试：非 policy_admin 角色调用 `POST /v1/policies/:tenant/draft` → 403 FORBIDDEN  
  常见问题：没有检查 `x-osas-role` header

- [ ] **版本不可变**  
  测试：修改已 activate 的策略 → 403 POLICY_IMMUTABLE  
  常见问题：允许 PATCH 活跃策略

- [ ] **supersession 逻辑**  
  测试：activate 新版本时，旧版本自动 retired  
  常见问题：同时存在多个 active 策略

## ✅ Conformance Mode (Day 5)

- [ ] **环境变量检查**  
  测试：`OSAS_CONFORMANCE_MODE=false` 时调用 `/v1/conformance/reset` → 403  
  常见问题：总是允许 reset（危险）

- [ ] **conformance key 验证**  
  测试：错误的 `x-osas-conformance-key` → 403  
  常见问题：不检查 key、硬编码 key

- [ ] **fixture 加载**  
  测试：`POST /v1/conformance/reset` 后，`GET /v1/policies/tenant_demo` 返回 demo-tenant.json 里的策略  
  常见问题：没有解析相对时间戳（`"now"`, `"now-5d"`）

## ✅ 审计链 (Day 6)

- [ ] **eventHash 计算正确**  
  测试：一个事件的 hash 与测试向量里的预期值一致  
  常见问题：包含了 eventHash 字段在哈希输入里

- [ ] **hash 输出小写十六进制**  
  测试：hash 是 64 字符小写字符串，不是大写或 base64  
  常见问题：`hashlib.hexdigest()` 默认小写但有些语言大写

- [ ] **previousHash 链接**  
  测试：事件 2 的 previousHash == 事件 1 的 eventHash  
  常见问题：使用固定值、随机值

- [ ] **genesis hash**  
  测试：第一个事件的 previousHash 是 64 个零  
  常见问题：空字符串、null

- [ ] **sequence 递增**  
  测试：事件的 sequence 从 1 开始，每个加 1  
  常见问题：从 0 开始、跳号

- [ ] **通过测试向量**  
  运行：`conformance/test-vectors/audit-chain.json` 的 3 个向量全部通过

## ✅ 幂等性 (Day 6)

- [ ] **idempotencyKey 存储**  
  测试：同样的 key 第二次请求返回相同结果  
  常见问题：每次都执行新操作

- [ ] **replayed 标记**  
  测试：重放的响应包含 `replayed: true`  
  常见问题：没有标记，客户端无法区分

- [ ] **跨租户隔离**  
  测试：tenant_a 的 key 不能重放 tenant_b 的操作  
  常见问题：全局 key map

- [ ] **幂等窗口**  
  测试：规范没有要求永久存储，但至少保留 24 小时  
  常见问题：重启后丢失、立即过期

## ✅ 最终检查

- [ ] **超时处理**  
  测试：compat runner 默认 10 秒超时，你的端点要在 5 秒内响应  
  常见问题：数据库查询慢、没有索引

- [ ] **并发安全**  
  测试：同时运行两个 compat runner 实例，没有竞态条件  
  常见问题：内存存储没有锁、sequence 冲突

- [ ] **日志清晰**  
  测试：失败时能从日志定位原因  
  建议：记录每个请求的 tenantId、role、principal

- [ ] **README 有运行说明**  
  测试：新人 clone 项目后能按 README 启动服务器  
  包含：依赖安装、环境变量、启动命令、测试命令

## 🚀 运行合规测试

通过上述检查后：

```bash
# 启动服务器（Conformance Mode）
export OSAS_CONFORMANCE_MODE=true
export OSAS_CONFORMANCE_KEY=test-key-12345
./your-server --port 8080

# 运行 stateful 套件
npx @osas/compat-runner \
  --target http://localhost:8080 \
  --conformance-key test-key-12345 \
  --verbose

# 检查结果
# 目标：gateOk: true, failed: 0, skipped: 0
```

**如果 gateOk: false**，检查：
- `skipped > 0`：可能没有启用 Conformance Mode 或 key 不匹配
- `failed > 0`：在 verbose 输出里找第一个 FAIL，对照本清单调试

## 📊 单元测试优先

在跑黑盒测试前，先用测试向量写单元测试：

```python
# 示例：Python unittest
import json
from your_implementation import stable_stringify, hash_audit_event, evaluate_proposal

def test_stable_json_vectors():
    with open("conformance/test-vectors/stable-json.json") as f:
        vectors = json.load(f)["vectors"]
    for v in vectors:
        actual = stable_stringify(v["input"])
        expected = v["canonical"]
        assert actual == expected, f"{v['name']} failed"

def test_audit_chain_vectors():
    with open("conformance/test-vectors/audit-chain.json") as f:
        vectors = json.load(f)["vectors"]
    for v in vectors["vectors"]:
        for i, event in enumerate(v["events"]):
            actual = hash_audit_event(event)
            expected = v["expectedHashes"][i]["eventHash"]
            assert actual == expected, f"{v['name']} event {i} failed"
```

**为什么单元测试优先？**
- 快速反馈循环（秒级 vs 分钟级）
- 精确定位问题（stable_json 第 3 个向量失败 vs "audit suite failed"）
- 可复现（不依赖 HTTP 服务器状态）

## 常见失败模式速查

| 错误代码 | 最可能原因 | 检查项 |
|---|---|---|
| `TENANT_MISMATCH` | header 和路径不一致检查缺失 | Day 3 租户隔离 |
| schema 验证失败 | $ref 解析问题 | Day 2 Schema 验证 |
| audit 链验证失败 | stable_json 不正确 | Day 6 + stable JSON 清单 |
| 决策不符合预期 | 11 项检查顺序或汇总错误 | Day 4 策略求值清单 |
| 幂等性失败 | 没有存储 idempotencyKey | Day 6 幂等性清单 |
| 超时 | 同步 I/O、没有索引 | 最终检查 |

## 获取帮助

- **单元测试失败：** 用 `--verbose` 模式比较实际 vs 预期输出
- **黑盒测试失败：** 运行 `npx @osas/compat-runner --verbose`，复制第一个 FAIL 的请求/响应，开 issue 附上完整日志
- **不知道从哪开始：** 先跑单元测试（stable-json → audit-chain → policy-evaluation），再跑黑盒测试
