# NPM 发布准备清单

@osas/compat-runner 准备发布到 npm 的预检清单。

## 前置条件

- [ ] 所有核心功能完整（discovery, schemas-tools, policy-read, stateful, verbose mode）
- [ ] README 更新为发布后的用法（`npx @osas/compat-runner`）
- [ ] package.json 配置检查：
  - [ ] `version` 与仓库根 package.json 一致（当前 0.2.1）
  - [ ] `publishConfig.access: "public"` 已设置
  - [ ] `files` 包含 `dist` 和 `NOTICE`
  - [ ] `bin` 指向正确路径 `./dist/cli.js`
  - [ ] `dependencies` 不包含 `workspace:*`（发布时自动替换）
- [ ] LICENSE 和 NOTICE 文件存在（Apache-2.0）

## 构建验证

```bash
cd packages/compat-runner

# 1. 清理旧构建
rm -rf dist

# 2. 重新构建
pnpm build

# 3. 检查输出
ls -lh dist/
# 应包含: cli.js, index.js, runner.js, client.js, types.js 及对应 .d.ts

# 4. 验证 CLI 入口
node dist/cli.js --help
# 应打印用法说明

# 5. 运行单元测试
pnpm test
```

## 功能验证

```bash
# 启动参考实现
cd ../../
pnpm dev:api &
API_PID=$!
sleep 3

# 测试只读套件
pnpm --filter @osas/compat-runner exec node dist/cli.js -- --target http://localhost:3001
# 预期: ok: true, 多个 passed checks

# 测试 stateful 套件
pnpm --filter @osas/compat-runner exec node dist/cli.js -- \
  --target http://localhost:3001 \
  --conformance-key test-key
# 预期: gateOk: true, 全部通过

# 测试 verbose 模式
pnpm --filter @osas/compat-runner exec node dist/cli.js -- \
  --target http://localhost:3001 \
  --verbose | head -50
# 预期: 打印 HTTP 请求/响应详情

# 测试输出到文件
pnpm --filter @osas/compat-runner exec node dist/cli.js -- \
  --target http://localhost:3001 \
  --conformance-key test-key \
  --out /tmp/report.json
cat /tmp/report.json | jq '.gateOk, .totals'

# 清理
kill $API_PID
```

## 依赖验证

```bash
cd packages/compat-runner

# 检查依赖版本
jq '.dependencies' package.json

# 预期: @osas/core, @osas/schema-validator 都是 workspace:*
# 发布时 pnpm 会自动替换成实际版本号

# 检查这些依赖是否已发布到 npm（如果是首次发布）
npm view @osas/core version
npm view @osas/schema-validator version

# 如果未发布，需要先发布依赖
cd ../core && pnpm publish --dry-run
cd ../schema-validator && pnpm publish --dry-run
```

## 文档检查

- [ ] README.md 包含安装说明（`npm install -g @osas/compat-runner`）
- [ ] README.md 包含用法示例（所有 CLI 参数）
- [ ] README.md 包含 verbose 模式说明
- [ ] README.md 包含报告读法（ok vs gateOk）
- [ ] README.md 包含退出码说明（0/1/2）
- [ ] README.md 包含中文版
- [ ] CHANGELOG 或 git tag 记录版本变更

## Dry-run 发布

```bash
cd packages/compat-runner

# 1. Dry-run（不会真正发布）
pnpm publish --dry-run

# 检查输出:
# - 是否打包了正确的文件（dist/, NOTICE）
# - 是否排除了不需要的文件（src/, *.test.ts）
# - 依赖是否正确解析（workspace:* 变成版本号）

# 2. 检查打包内容
pnpm pack
tar -tzf osas-compat-runner-0.2.1.tgz | head -30
rm osas-compat-runner-0.2.1.tgz
```

## 发布流程

### 首次发布（需要 npm 账号权限）

```bash
# 1. 登录 npm（如果尚未登录）
npm login

# 2. 确认 @osas scope 的权限
npm access ls-packages @osas

# 3. 发布依赖（如果未发布）
cd packages/core && pnpm publish
cd ../schema-validator && pnpm publish

# 4. 发布 compat-runner
cd ../compat-runner
pnpm publish
# prepublishOnly 会自动运行 build + test

# 5. 验证发布成功
npm view @osas/compat-runner
npx @osas/compat-runner@latest --version
```

### 后续版本发布

```bash
# 1. 更新版本号（在仓库根目录）
cd /path/to/open-support-agent-spec
npm run check:versions  # 确保所有包版本一致

# 2. 如果版本不一致，手动更新 package.json
# 或使用工具: pnpm -r exec npm version patch

# 3. 提交版本变更
git add -A
git commit -m "chore: bump to v0.2.2"
git tag v0.2.2
git push && git push --tags

# 4. 发布（按依赖顺序）
cd packages/core && pnpm publish
cd ../schema-validator && pnpm publish
cd ../policy-engine && pnpm publish
cd ../compat-runner && pnpm publish
```

## 发布后验证

```bash
# 1. 等待 npm CDN 同步（30 秒 - 2 分钟）
sleep 60

# 2. 全局安装验证
npm install -g @osas/compat-runner@latest

# 3. 测试全局 CLI
osas-compat --help
osas-compat --version

# 4. 测试 npx（无需安装）
npx @osas/compat-runner@latest --help

# 5. 在新目录测试
cd /tmp
npx @osas/compat-runner --target http://localhost:3001

# 6. 更新文档链接
# - README.md 中的"尚未发布"警告可以删除
# - docs/implementing-osas-7days.zh-CN.md 中更新安装说明
```

## 回滚流程（如果发布有问题）

```bash
# npm 不允许删除已发布的包，但可以弃用
npm deprecate @osas/compat-runner@0.2.1 "有问题，请使用 0.2.2"

# 发布修复版本
cd packages/compat-runner
# 修复问题...
npm version patch  # 0.2.1 -> 0.2.2
pnpm publish
```

## 已完成的改进（本次发布）

✅ 添加了 --verbose 模式（打印每个检查的 HTTP 请求/响应）  
✅ 更新 README 为发布后用法（npx @osas/compat-runner）  
✅ 生成了跨语言测试向量（conformance/test-vectors/）  
✅ 创建了 7 天实现教程（docs/implementing-osas-7days.zh-CN.md）  
✅ 导出了静态 OpenAPI 规范（docs/openapi-v0.2.json）  
✅ 优化了 Python 实现的独立性叙事（招募独立维护者）  
✅ 添加了实现者自检清单（docs/implementer-checklist.zh-CN.md）

## 通知渠道

发布后通知社区：

- [ ] GitHub Release（附 CHANGELOG）
- [ ] README.md 首页更新（"现已发布到 npm"）
- [ ] 文档链接更新（所有 `pnpm osas:compat` 改为 `npx @osas/compat-runner`）
- [ ] 示例代码更新（7 天教程、实现指南）

## 问题排查

### `Cannot find module @osas/core`

原因：依赖包未发布或版本不匹配  
解决：先发布 core 和 schema-validator

### `Permission denied when publishing`

原因：npm 账号无 @osas scope 权限  
解决：联系 scope owner 添加权限或使用 npm access

### `prepublishOnly script failed`

原因：构建或测试失败  
解决：本地运行 `pnpm build && pnpm test` 调试

### 发布后 npx 找不到命令

原因：npm CDN 同步延迟  
解决：等待 1-2 分钟后重试
