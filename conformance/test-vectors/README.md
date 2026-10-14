# OSAS Test Vectors

Cross-language test vectors for OSAS implementers. These JSON files contain canonical inputs and expected outputs for the core algorithms, allowing you to validate your implementation incrementally without running the full black-box conformance suite.

[中文文档](README.zh-CN.md)

## What's included

| File | Algorithm | Vectors | Purpose |
|---|---|---|---|
| `stable-json.json` | Stable JSON canonicalization | 11 | Verify your key-sorting and serialization matches the reference |
| `audit-chain.json` | SHA-256 event hashing + chain verification | 3 | Verify hash computation and tamper detection |
| `policy-evaluation.json` | Policy evaluation (spec §5) | 5 | Verify the 11-check decision algorithm |

## Usage

### 1. Stable JSON (prerequisite for everything else)

This is the foundation. Your `stableStringify` function must produce **exactly** these canonical strings:

```python
# Python example
import json
from your_implementation import stable_stringify

with open("conformance/test-vectors/stable-json.json") as f:
    vectors = json.load(f)["vectors"]

for v in vectors:
    actual = stable_stringify(v["input"])
    expected = v["canonical"]
    assert actual == expected, f"{v['name']}: expected {expected}, got {actual}"
```

**Key rules:**
- Object keys sorted lexicographically (UTF-16 code unit order, same as JavaScript's default `.sort()`)
- No whitespace anywhere
- Arrays preserve order
- `null` serialized as `null` (not omitted)
- Non-ASCII characters (emoji, Chinese) preserved as UTF-8, not escaped

**Common mistakes:**
- Using a different sort order (byte order, locale-aware)
- Adding whitespace or newlines
- Omitting `null` values instead of serializing them
- Escaping non-ASCII characters as `\uXXXX`

### 2. Audit Chain

Once stable JSON works, test your event hashing:

```go
// Go example
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
                t.Errorf("%s event %d: expected %s, got %s", v.Name, i, expected, actual)
            }
        }
    }
}
```

**Algorithm:**
```
eventHash = lowercase_hex(SHA-256(UTF-8(stableStringify(event without eventHash))))
```

The genesis `previousHash` is 64 zero characters. Each subsequent event's `previousHash` is the previous event's `eventHash`.

**Common mistakes:**
- Including the `eventHash` field in the hash input
- Using uppercase hex output
- Wrong hash chaining (not using previous event's hash)

### 3. Policy Evaluation

Test the full decision algorithm:

```rust
// Rust example
#[test]
fn test_policy_evaluation() {
    let data = std::fs::read_to_string("conformance/test-vectors/policy-evaluation.json").unwrap();
    let vectors: serde_json::Value = serde_json::from_str(&data).unwrap();
    
    for v in vectors["vectors"].as_array().unwrap() {
        let proposal: ActionProposal = serde_json::from_value(v["proposal"].clone()).unwrap();
        let ctx: EvaluationContext = serde_json::from_value(v["context"].clone()).unwrap();
        let expected: PolicyDecision = serde_json::from_value(v["expectedDecision"].clone()).unwrap();
        
        let actual = evaluate_proposal(&proposal, &ctx);
        
        assert_eq!(actual.decision, expected.decision, "{}: decision mismatch", v["name"]);
        assert_eq!(actual.reasons, expected.reasons, "{}: reasons mismatch", v["name"]);
    }
}
```

**The 11 checks** (spec §5, in order):
1. `PERMISSION_OVERREACH` — models capped at `request-approval`
2. `PROMPT_INJECTION_SUSPECTED`
3. `PROFILE_MISMATCH` — actionType must belong to the declared profile
4. `NO_RULE` — no matching rule → block
5. `REASON_CODE_DISALLOWED`
6. `DUPLICATE_REQUEST` — same params in recent proposals window
7. `OVER_THRESHOLD` — amount exceeds rule's `maxAmount`
8. `IDENTITY_DISALLOWED`
9. `REGION_DISALLOWED`
10. `INSUFFICIENT_EVIDENCE` — financial actions require ≥1 evidence
11. `EVIDENCE_STALE` — evidence older than `maxEvidenceAgeSeconds`

**Decision logic:**
- Collect ALL applicable reasons
- Return the **worst** decision: `block` > `require_approval` > `auto_execute`
- If no reasons triggered, return the rule's decision

**Common mistakes:**
- Returning on the first failed check (you must collect all reasons)
- Wrong severity ordering
- Not checking all 11 rules in sequence

## Regenerating

After modifying the reference implementation:

```bash
pnpm vectors:generate
```

The vectors are derived from the reference implementation in `packages/policy-engine/`. If you find a discrepancy between these vectors and the spec, open an issue — the vectors are authoritative for cross-language compatibility, but the spec is authoritative for semantics.

## Language-specific notes

### Python
- Use `jsonschema` for Schema validation
- `json.dumps(obj, ensure_ascii=False, separators=(',', ':'))` is close, but you still need custom key sorting

### Go
- `gojsonschema` for Schema validation
- Don't use `json.Marshal` directly — it doesn't guarantee key order; implement custom sorting

### Rust
- `jsonschema` crate for validation
- `serde_json` with a custom serializer that sorts keys

### Java
- `everit-json-schema` for validation
- `Jackson` or `Gson` with custom key comparators

## Next steps

After passing these unit tests:
1. Read [docs/implementing-osas.md](../../docs/implementing-osas.md) for the full HTTP surface
2. Implement Conformance Mode with the fixtures from [conformance/fixtures/](../fixtures/)
3. Run the black-box compat runner: `npx @osas/compat-runner --target http://localhost:8080`
4. Submit a compatibility claim via the GitHub issue template

## Questions?

Open an issue with the `implementation` label. Include:
- Which vector is failing
- Your expected vs actual output
- The language you're implementing in
