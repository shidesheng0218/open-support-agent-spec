# OSAS 测试向量

面向 OSAS 实现者的跨语言测试向量。这些 JSON 文件包含核心算法的权威输入和预期输出，让你可以增量验证实现，而不必先跑完整的黑盒合规套件。

[English](README.md)

## 包含什么

| 文件 | 算法 | 向量数 | 用途 |
|---|---|---|---|
| `stable-json.json` | 稳定 JSON 规范化 | 11 | 验证你的键排序和序列化与参考实现一致 |
| `audit-chain.json` | SHA-256 事件哈希 + 链验证 | 3 | 验证哈希计算和篡改检测 |
| `policy-evaluation.json` | 策略求值（规范 §5） | 5 | 验证 11 项检查的决策算法 |

## 使用方式

### 1. Stable JSON（所有其他算法的前提）

这是基础。你的 `stableStringify` 函数必须产生**完全一致**的规范字符串：

```python
# Python 示例
import json
from your_implementation import stable_stringify

with open("conformance/test-vectors/stable-json.json") as f:
    vectors = json.load(f)["vectors"]

for v in vectors:
    actual = stable_stringify(v["input"])
    expected = v["canonical"]
    assert actual == expected, f"{v['name']}: 期望 {expected}，实际 {actual}"
```

**关键规则：**
- 对象键按字典序排序（UTF-16 码点顺序，与 JavaScript 的默认 `.sort()` 相同）
- 任何地方都没有空白字符
- 数组保持原顺序
- `null` 序列化为 `null`（不省略）
- 非 ASCII 字符（emoji、中文）保持 UTF-8，不转义

**常见错误：**
- 使用不同的排序顺序（字节序、locale 感知）
- 添加空格或换行符
- 省略 `null` 值而不是序列化它们
- 把非 ASCII 字符转义为 `\uXXXX`

### 2. 审计链

stable JSON 正确后，测试事件哈希：

```go
// Go 示例
func TestAuditChain(t *testing.T) {
    data, _ := os.ReadFile("conformance/test-vectors/audit-chain.json")
    var vectors struct {
        GenesisHash string `json:"genesisHash"`
        Vectors []struct {
            Name string `json:"name"`
            Events []AuditEvent `json:"events"`
            ExpectedHashes []struct {
                EventId string `json:"eventId"`
                EventHash string `json:"eventHash"`
            } `json:"expectedHashes"`
        } `json:"vectors"`
    }
    json.Unmarshal(data, &vectors)

    for _, v := range vectors.Vectors {
        for i, event := range v.Events {
            actual := hashAuditEvent(event)
            expected := v.ExpectedHashes[i].EventHash
            if actual != expected {
                t.Errorf("%s 事件 %d: 期望 %s，实际 %s", v.Name, i, expected, actual)
            }
        }
    }
}
```

**算法：**
```
eventHash = 小写十六进制(SHA-256(UTF-8(stableStringify(去掉 eventHash 字段的事件))))
```

创世 `previousHash` 是 64 个零字符。每个后续事件的 `previousHash` 是前一个事件的 `eventHash`。

**常见错误：**
- 在哈希输入中包含 `eventHash` 字段
- 使用大写十六进制输出
- 错误的哈希链接（没有使用前一个事件的哈希）

### 3. 策略求值

测试完整的决策算法：

```rust
// Rust 示例
#[test]
fn test_policy_evaluation() {
    let data = std::fs::read_to_string("conformance/test-vectors/policy-evaluation.json").unwrap();
    let vectors: serde_json::Value = serde_json::from_str(&data).unwrap();
    
    for v in vectors["vectors"].as_array().unwrap() {
        let proposal: ActionProposal = serde_json::from_value(v["proposal"].clone()).unwrap();
        let ctx: EvaluationContext = serde_json::from_value(v["context"].clone()).unwrap();
        let expected: PolicyDecision = serde_json::from_value(v["expectedDecision"].clone()).unwrap();
        
        let actual = evaluate_proposal(&proposal, &ctx);
        
        assert_eq!(actual.decision, expected.decision, "{}: 决策不匹配", v["name"]);
        assert_eq!(actual.reasons, expected.reasons, "{}: 原因不匹配", v["name"]);
    }
}
```

**11 项检查**（规范 §5，按顺序）：
1. `PERMISSION_OVERREACH` — 模型最高只能 `request-approval`
2. `PROMPT_INJECTION_SUSPECTED`
3. `PROFILE_MISMATCH` — actionType 必须属于声明的 profile
4. `NO_RULE` — 没有匹配规则 → block
5. `REASON_CODE_DISALLOWED`
6. `DUPLICATE_REQUEST` — 最近提案窗口中有相同参数
7. `OVER_THRESHOLD` — 金额超过规则的 `maxAmount`
8. `IDENTITY_DISALLOWED`
9. `REGION_DISALLOWED`
10. `INSUFFICIENT_EVIDENCE` — 金融动作需要 ≥1 条证据
11. `EVIDENCE_STALE` — 证据超过 `maxEvidenceAgeSeconds`

**决策逻辑：**
- 收集所有适用的原因
- 返回**最差**的决策：`block` > `require_approval` > `auto_execute`
- 如果没有原因触发，返回规则的决策

**常见错误：**
- 在第一个失败检查时就返回（你必须收集所有原因）
- 严重程度排序错误
- 没有按顺序检查全部 11 条规则

## 重新生成

修改参考实现后：

```bash
pnpm vectors:generate
```

这些向量源自 `packages/policy-engine/` 中的参考实现。如果发现向量与规范不一致，请开 issue——向量对于跨语言兼容性是权威的，但规范对于语义是权威的。

## 语言特定说明

### Python
- 用 `jsonschema` 做 Schema 校验
- `json.dumps(obj, ensure_ascii=False, separators=(',', ':'))` 接近，但仍需自定义键排序

### Go
- 用 `gojsonschema` 做 Schema 校验
- 不要直接用 `json.Marshal`——它不保证键顺序；实现自定义排序

### Rust
- 用 `jsonschema` crate 做校验
- `serde_json` 配合自定义序列化器对键排序

### Java
- 用 `everit-json-schema` 做校验
- `Jackson` 或 `Gson` 配合自定义键比较器

## 下一步

通过这些单元测试后：
1. 阅读 [docs/implementing-osas.zh-CN.md](../../docs/implementing-osas.zh-CN.md) 了解完整 HTTP 表面
2. 用 [conformance/fixtures/](../fixtures/) 中的 fixtures 实现 Conformance Mode
3. 运行黑盒 compat runner：`npx @osas/compat-runner --target http://localhost:8080`
4. 通过 GitHub issue 模板提交兼容性声明

## 有问题？

开一个带 `implementation` 标签的 issue。请包含：
- 哪个向量失败
- 你的预期 vs 实际输出
- 你正在使用的语言
