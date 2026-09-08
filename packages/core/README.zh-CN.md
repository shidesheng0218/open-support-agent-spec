# @osas/core

[English README](./README.md)

[Open Support Agent Spec (OSAS)](https://github.com/shidesheng0218/open-support-agent-spec) 的核心领域模型——所有其他 `@osas/*` 包共同使用的词汇表。纯 TypeScript：类型、枚举、常量与状态机；零运行时依赖。

## 安装

```bash
npm install @osas/core
```

要求 Node.js >= 20。纯 ESM，自带 TypeScript 类型声明。

## 内容

- **领域类型**：与 `schemas/` 下的 JSON Schema 逐字段对应：`Case`、`Customer`、`Evidence`、`ActionProposal`、`Approval`、`TenantPolicy`、`AuditEvent`、`HumanHandoff`、能力清单（capability manifest），以及 ecommerce/saas profile 的扩展对象。
- **枚举与常量**：`SPEC_VERSION`、`PROFILES`、`ACTION_TYPES`、`ACTION_TYPE_PROFILE`、`FINANCIAL_ACTION_TYPES`，以及工单、提议、审批、审计事件等状态枚举。
- **权限阶梯**（CONTRACTS.md §3）：`PERMISSIONS`（`read < draft < request-approval < execute`）与 `permissionAtLeast(a, b)`。
- **状态机**：`PROPOSAL_TRANSITIONS`、`CASE_TRANSITIONS`、`POLICY_VERSION_TRANSITIONS`，配套 `canTransition*` / `transition*` 辅助函数与 `IllegalTransitionError`。
- **提示注入启发式检测**与 ID/时间戳辅助函数。

```ts
import { PERMISSIONS, permissionAtLeast, transitionProposal } from "@osas/core";

permissionAtLeast("request-approval", "read"); // true
```

## 版本策略

所有 `@osas/*` 包与 OSAS 规范共享同一个语义版本，lockstep 发布。当前 **0.2.x** 系列实现 `specVersion: "0.2"`；v0.x 期间任意 minor 升级都可能包含 breaking change。见 [GOVERNANCE.md](../../GOVERNANCE.md#versioning)。

## 许可证

Apache-2.0。见 [LICENSE](../../LICENSE) 与 [NOTICE](../../NOTICE)。
