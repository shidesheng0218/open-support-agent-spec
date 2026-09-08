# @osas/schema-validator

[中文文档](./README.zh-CN.md)

JSON Schema validation for [OSAS](https://github.com/shidesheng0218/open-support-agent-spec)
objects, built on [Ajv](https://ajv.js.org) (2020-12 dialect) with
`ajv-formats`. Loads the spec's schema manifest, registers every schema by
`$id` (so cross-schema `$ref`s resolve), and validates data by schema name.

## Install

```bash
npm install @osas/schema-validator
```

Requires Node.js >= 20. ESM-only with bundled TypeScript declarations.

## Usage

```ts
import { createValidator, validate } from "@osas/schema-validator";

const validator = createValidator(schemasDir); // or getValidator() singleton

const result = validator.validate("action-proposal", data);
if (!result.valid) {
  // result.errors: [{ path, message }, ...] — all errors, not just the first
}
```

Exports: `createValidator`, `getValidator`, `validate`, `validateInline`,
`loadManifest`, `listSchemas`, `loadSchema`, `resolveSchemasDir`, plus the
`SchemaValidator`, `ValidationResult`, `ValidationError`, `SchemaManifest`,
and `SchemaManifestEntry` types.

### Locating the schemas

The schemas directory is resolved in this order:

1. `process.env.OSAS_SCHEMAS_DIR`, if set;
2. otherwise the `schemas/` directory of the OSAS repository, resolved
   relative to this module.

**When consuming this package from npm** (outside the OSAS repo), option 2
does not exist — either pass an explicit `schemasDir` to `createValidator()` /
the `load*` functions, or set `OSAS_SCHEMAS_DIR` to a local copy of the spec's
[`schemas/`](../../schemas) directory.

## Versioning

All `@osas/*` packages share one semantic version with the OSAS specification
and are released in lockstep. The current **0.2.x** line implements
`specVersion: "0.2"`; while in v0.x, any minor bump may be breaking. See
[GOVERNANCE.md](../../GOVERNANCE.md#versioning).

## License

Apache-2.0. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
