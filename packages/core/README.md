# @osas/core

[中文文档](./README.zh-CN.md)

Core domain model of the [Open Support Agent Spec (OSAS)](https://github.com/shidesheng0218/open-support-agent-spec)
— the shared vocabulary every other `@osas/*` package builds on. Pure
TypeScript: types, enums, constants, and state machines; zero runtime
dependencies.

## Install

```bash
npm install @osas/core
```

Requires Node.js >= 20. ESM-only with bundled TypeScript declarations.

## What's inside

- **Domain types** mirroring the JSON Schemas under `schemas/` field-for-field:
  `Case`, `Customer`, `Evidence`, `ActionProposal`, `Approval`,
  `TenantPolicy`, `AuditEvent`, `HumanHandoff`, capability manifests, and the
  ecommerce/saas profile extension objects.
- **Enums and constants**: `SPEC_VERSION`, `PROFILES`, `ACTION_TYPES`,
  `ACTION_TYPE_PROFILE`, `FINANCIAL_ACTION_TYPES`, status enums for cases,
  proposals, approvals, audit events, and more.
- **The permission ladder** (`CONTRACTS.md §3`): `PERMISSIONS` (`read < draft <
  request-approval < execute`) and `permissionAtLeast(a, b)`.
- **State machines**: `PROPOSAL_TRANSITIONS`, `CASE_TRANSITIONS`,
  `POLICY_VERSION_TRANSITIONS`, with `canTransition*` / `transition*` helpers
  and `IllegalTransitionError`.
- **Prompt-injection heuristics** and ID/timestamp helpers.

```ts
import { PERMISSIONS, permissionAtLeast, transitionProposal } from "@osas/core";

permissionAtLeast("request-approval", "read"); // true
```

## Versioning

All `@osas/*` packages share one semantic version with the OSAS specification
and are released in lockstep. The current **0.2.x** line implements
`specVersion: "0.2"`; while in v0.x, any minor bump may be breaking. See
[GOVERNANCE.md](../../GOVERNANCE.md#versioning).

## License

Apache-2.0. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
