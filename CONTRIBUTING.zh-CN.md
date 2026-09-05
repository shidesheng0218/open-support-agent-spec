# 参与 OSAS 贡献

[English](CONTRIBUTING.md)

感谢你参与 Open Support Agent Spec（开放客服 Agent 规范）的建设。本文档说明贡献流程、
开发环境、Pull Request 要求与发布门禁。提交贡献即表示你同意
[行为准则](CODE_OF_CONDUCT.md)，并以 [Apache-2.0](LICENSE) 许可你的成果。

## 贡献方式

- **规范文本与 Schema** —— 澄清、新增字段/对象、Profile 扩展。
- **参考实现** —— `packages/`、`apps/`、`tests/` 下的包。
- **兼容性套件** —— 在 `@osas/compat-suite` 中新增一致性测试用例。
- **文档与翻译** —— 中英文文档必须保持完全等价；请在同一变更中同时更新两者。
- **独立实现** —— 通往 v1.0 之路上最有价值的贡献；见 [GOVERNANCE.md](GOVERNANCE.md)。

## 开发环境

环境要求：Node >= 20（推荐 Node 22）、pnpm 11。

```bash
pnpm install && pnpm build
pnpm dev:api        # API 运行于 http://localhost:3001
pnpm dev:web        # 控制台运行于 http://localhost:5173
pnpm typecheck      # 整个 workspace 的严格 TypeScript 检查
pnpm test           # 构建 + 全部单元测试
pnpm test:compat    # 兼容套件 → tests/compat/report/latest.json
pnpm docker:up      # docker compose up --build（控制台 :8080，API :3001）
```

约定（由 [CONTRACTS.md](CONTRACTS.md) 固定）：

- pnpm workspace，npm scope 为 `@osas/*`，所有包 `private`，版本 `0.1.0`。
- TypeScript strict、ESM（`"type": "module"`）；TS 中的相对导入使用 `.js` 后缀
  （NodeNext）。
- 运行时校验只用 Ajv v8 + ajv-formats（不引入其他校验库）。
- 金额为整数 `{ currency, minorUnits }` —— 绝不用浮点数。
- 测试使用 Vitest，以 `src/**/*.test.ts` 与源码同目录放置。
- 除非变更本身针对根 workspace 文件（`package.json`、`pnpm-workspace.yaml`、
  `tsconfig.base.json`），否则不要修改它们。

## Pull Request 检查清单

提交 PR 前请确认：

- [ ] 本地 `pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。
- [ ] `pnpm test:compat` 通过，相关时报告已重新生成。
- [ ] Schema、文字文档与实现三者一致（以 Schema 为权威）。
- [ ] 中英文文档同步更新，且为完全等价版本。
- [ ] 破坏性变更或新语义引用了已被接受的 RFC（见下）。
- [ ] `CHANGELOG.md` 在 Unreleased（或目标版本）下有条目。
- [ ] 未在任何位置引入真实客户数据、凭据或密钥。

## 发布门禁（规范性要求）

**Schema、中英文文档、参考实现与兼容性测试必须在同一个 PR 中同步变更。** 只有规范
文字而缺少其 Schema、测试、参考实现或双语文档中任何一项的变更，不可合并。

**没有可运行示例与通过测试的规范版本，不得作为稳定版发布。** 任何打标签的发布都
要求 `main` 上的 CI（`build-test`、`compat`、`docker`、`e2e`）全绿。

## RFC 流程

以下变更**必须**提交 RFC：

- 对 Schema、状态机、策略算法、权限阶梯、工具表面或 Adapter 接口的破坏性变更；
- 任何新语义（新对象类型、动作类型、事件类型、决策原因码等）。

纯编辑性修改（错别字、不改变含义的澄清）不需要 RFC。

流程：复制 [rfcs/0000-template.md](rfcs/0000-template.md) 为
`rfcs/NNNN-简短名称.md`，以 `Draft` 状态提交 PR，在维护者评审中迭代，由创始维护者
决定 `Accepted` 或 `Rejected`。只有 `Accepted` 的 RFC 可以进入实现。
详见 [GOVERNANCE.md](GOVERNANCE.md)。

## 版本管理

规范、Schema 与全部 `@osas/*` 包共用一个语义化版本（当前为 `0.1.0`）。v0.x 期间次
版本可能包含破坏性变更；自 v1.0 起，破坏性变更需要主版本号递增。
详见 [GOVERNANCE.md](GOVERNANCE.md#versioning)。

## 报告安全问题

漏洞请勿提交公开 issue。请遵循 [SECURITY.md](SECURITY.md)。
