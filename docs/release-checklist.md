# Release Checklist / 发布清单

> Maintainer-facing process document. Publishing is a **manual** action — CI only
> verifies that the packages are always publishable (`publish-dry-run` job).
>
> 维护者内部流程文档。发布是**人工动作**——CI 只保证包始终处于可发布状态
>（`publish-dry-run` 任务）。

## What gets published / 发布什么

| Package | npm | Notes |
|---|---|---|
| `@osas/core` | public | types, enums, state machines, `detectInjection` |
| `@osas/schema-validator` | public | Ajv loader; bundles `schemas/` into `dist/schemas` at build |
| `@osas/policy-engine` | public | evaluation, execution, approval lifecycle, audit chain |
| `@osas/compat-runner` | public | black-box conformance runner (`osas-compat` bin) |

Everything else in the workspace is `"private": true` and is **never** published —
build it from a repo checkout. / 其余包均为 private，永不发布，只能从仓库构建。

Spec, schemas, and all `@osas/*` packages share **one version** (lockstep, see
GOVERNANCE.md §Versioning). `SPEC_VERSION` stays constant within a spec line.

## Before you publish / 发布前

1. [ ] Version bump decided per semver; every package `version` field updated in the
      same commit (lockstep). / 同一提交内更新所有包的 version。
2. [ ] `CHANGELOG.md` has the new version section, EN+ZH user-facing notes where
      applicable. / CHANGELOG 含新版本小节，面向用户的条目双语。
3. [ ] Normative docs updated in both languages in the same change (spec, guides).
      / 规范性文档中英双语同步。
4. [ ] `pnpm check:versions` passes.
5. [ ] `pnpm test` passes (includes the CI-workflow and version-consistency gates).
6. [ ] `pnpm test:compat` passes; report regenerated if the run changed it.
7. [ ] `pnpm eval:policy && pnpm eval:after-sales && pnpm eval:controlled` — all
      hard gates green. / 三项评测硬门槛全绿。
8. [ ] `pnpm check:publish` passes — tarballs contain `dist`, `README.md`,
      `LICENSE`, `NOTICE`, and no `workspace:*` specifiers survive packing.
      / 通过 `pnpm check:publish`：tarball 含 dist、README、LICENSE、NOTICE，
      且不残留 workspace:* 依赖声明。
9. [ ] `bash scripts/verify.sh` (the full release gate) is green.

## Publishing / 发布

```bash
# Dry-run first / 先干跑
pnpm check:publish

# Publish in dependency order; each package runs prepublishOnly (build + test).
# 按依赖顺序发布；每个包的 prepublishOnly 会先构建并跑测试。
cd packages/core && pnpm publish --access public --no-git-checks && cd ../..
cd packages/schema-validator && pnpm publish --access public --no-git-checks && cd ../..
cd packages/policy-engine && pnpm publish --access public --no-git-checks && cd ../..
cd packages/compat-runner && pnpm publish --access public --no-git-checks && cd ../..
```

`pnpm publish` rewrites `workspace:*` dependency specifiers to the real versions at
pack time — never publish with plain `npm publish` from a package directory, which
would leave them intact. / pnpm 会在打包时把 workspace:* 改写为真实版本号；
不要在包目录里直接用 npm publish，否则会原样发布。

## After you publish / 发布后

1. [ ] `npm view @osas/core version` (and the other three) shows the new version.
2. [ ] Tag the release: `git tag vX.Y.Z && git push origin vX.Y.Z` (signed if your
      setup allows). / 打 tag 并推送。
3. [ ] GitHub Release notes link the CHANGELOG section and the compat report
      artifact. / Release notes 链接 CHANGELOG 小节与 compat 报告。
4. [ ] If any npm badge or install instruction exists in README, sanity-check it
      resolves. / 检查 README 中 npm 相关链接可用。

## Rollback / 回滚

npm does not allow re-publishing a version. For a bad release: deprecate the bad
version (`npm deprecate @osas/core@X.Y.Z "reason"`), publish a patch with the fix,
and note both in CHANGELOG. / npm 不允许重发同版本：发现问题用 npm deprecate 标记，
发补丁版本，并在 CHANGELOG 中说明。

## Adding a new public package / 新增公共包

1. Add it to `PUBLIC_PACKAGES` in `scripts/check-version-consistency.mjs` and to the
   same list in `scripts/check-publish-readiness.mjs` (they must stay in sync).
2. Give it `publishConfig.access: "public"`, `engines`, `files: ["dist", "NOTICE"]`,
   `prepublishOnly`, a `README.md`, and copies of the root `LICENSE` and `NOTICE`.
3. Update the publish table above and CONTRACTS.md §0 (publish policy).

The version-consistency gate fails CI if a non-listed package is non-private, so an
accidental public package cannot slip through. / 版本一致性门会拦截意外公开的包。