# 贡献指南

使用 Node.js 22.12+，在仓库根目录执行 `npm ci`。ARL 不使用 npm workspace，也不依赖 Paseo 构建产物。

修改后执行 `npm run build`、`npm run typecheck` 和 `npm run lint`。只运行相关的现有测试文件，例如 `npm run test -- tests/test_setup.ts`；完整测试由 CI 执行。提交前执行 `npm run format`。

技能在 `skills/`，运行 helper 在 `src/`，项目模板在 `templates/`。新增技能或 helper 时，同步更新 [AGENT_GUIDE.md](AGENT_GUIDE.md) 和 [integration contract](skills/shared-references/integration-contract.md)。

修改安装包中的代码、技能或文档后，执行 `npm run pack:arl`，把归档及校验文件复制到 `distribution/releases/` 后提交。参见[打包约定](docs/arl-install.md)和[测试约定](docs/testing.md)。

提交标题使用 `fix(arl): preserve owner MCP entries` 这样的格式。PR 写清用户可见行为和验证结果，保持改动范围集中。

贡献使用 [MIT 许可证](LICENSE)。
