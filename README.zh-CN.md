# Auto Research Loop

[English](README.md)

ARL 把研究任务分到两台机器：worker 交付 zip；validation 持有冻结 benchmark，启动验证 agent，发布实测分数和脱敏反馈。双方通过 `submit` 和 `query` 两个 MCP 工具交互。

本分支只包含 ARL 源码、技能、测试和独立安装包。两台机器分别安装官方 Paseo，以及 Claude Code 或 Codex；Paseo 负责执行和监控 agent。

## 安装

需要 Node.js 22.12+、Bash 和 Git。使用本地 `arl` 分支源码仓库，先显式准备依赖和编译产物，再为项目选择 provider：

```bash
cd /你的本地arl仓库
npm ci
npm run build
bash distribution/install-aris.sh --provider claude --project /你的项目目录
# Codex 项目使用：
bash distribution/install-aris.sh --provider codex --project /你的项目目录
```

安装器仅从准备好的本地仓库复制项目技能、编译好的 helper 和运行依赖，不触发下载；缺少依赖或编译产物时直接报错。`install-arl.sh` 保留为同一安装流程的别名。Codex 必须信任项目，才会加载项目 MCP 配置。

先配置 validation，再把地址和 token 私下交给 worker。完整步骤见[中文部署指南](SETUP_GUIDE_CN.md)。

worker 的角色文档包含工具入口：`research-wiki` 管理研究记录，`browser-act` 访问浏览器，`experiment-queue` 调度 SSH 批量实验。setup 将确认的环境需求交给 `experiment-env-configuration`，输出验证过的 `run-<项目>-experiment` 环境使用 skill，再提示用户在客户端执行 `reload-skills`。升级或修复继续使用安装脚本。

## 开发

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test -- tests/test_setup.ts
npm run pack:arl
```

打包产物及校验文件在 `artifacts/`，用于发布和手动离线分发，本地安装不读取它们。修改交付文件后，把两份文件复制到 `distribution/releases/` 后提交。参见[打包约定](docs/arl-install.md)、[贡献指南](CONTRIBUTING_CN.md)和[架构说明](ARIS_ARCHITECTURE_GUIDE.md)。

## 许可证

[MIT](LICENSE)，保留原 ARIS 作者的版权声明。
