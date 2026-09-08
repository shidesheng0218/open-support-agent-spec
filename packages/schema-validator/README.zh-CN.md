# @osas/schema-validator

[English README](./README.md)

面向 [OSAS](https://github.com/shidesheng0218/open-support-agent-spec) 对象的 JSON Schema 校验，基于 [Ajv](https://ajv.js.org)（2020-12 方言）与 `ajv-formats`。加载规范的 schema 清单，按 `$id` 注册全部 schema（跨 schema 的 `$ref` 可正常解析），并按 schema 名称校验数据。

## 安装

```bash
npm install @osas/schema-validator
```

要求 Node.js >= 20。纯 ESM，自带 TypeScript 类型声明。

## 用法

```ts
import { createValidator, validate } from "@osas/schema-validator";

const validator = createValidator(schemasDir); // 或使用 getValidator() 单例

const result = validator.validate("action-proposal", data);
if (!result.valid) {
  // result.errors: [{ path, message }, ...] —— 返回全部错误，而非第一条
}
```

导出符号：`createValidator`、`getValidator`、`validate`、`validateInline`、`loadManifest`、`listSchemas`、`loadSchema`、`resolveSchemasDir`，以及 `SchemaValidator`、`ValidationResult`、`ValidationError`、`SchemaManifest`、`SchemaManifestEntry` 类型。

### Schema 目录定位

Schema 目录按以下顺序解析：

1. 若设置了 `process.env.OSAS_SCHEMAS_DIR`，优先使用；
2. 否则解析到 OSAS 仓库的 `schemas/` 目录（相对本模块定位）。

**当通过 npm 消费本包时**（在 OSAS 仓库之外），方式 2 不存在——请向 `createValidator()` / `load*` 函数显式传入 `schemasDir`，或将 `OSAS_SCHEMAS_DIR` 指向规范 [`schemas/`](../../schemas) 目录的本地副本。

## 版本策略

所有 `@osas/*` 包与 OSAS 规范共享同一个语义版本，lockstep 发布。当前 **0.2.x** 系列实现 `specVersion: "0.2"`；v0.x 期间任意 minor 升级都可能包含 breaking change。见 [GOVERNANCE.md](../../GOVERNANCE.md#versioning)。

## 许可证

Apache-2.0。见 [LICENSE](../../LICENSE) 与 [NOTICE](../../NOTICE)。
