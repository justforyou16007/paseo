# Auto Research Loop

[English](README.md)

ARL 把研究任务分到两台机器：worker 交付 zip；validation 持有冻结 benchmark，启动验证 agent，发布实测分数和脱敏反馈。双方通过 `submit` 和 `query` 两个 MCP 工具交互。

本分支只包含 ARL 源码、技能、测试和独立安装包。两台机器分别安装官方 Paseo，以及 Claude Code 或 Codex；Paseo 负责执行和监控 agent。

## 安装

需要 Node.js 22.12+、Bash 和 tar。下载安装脚本，再为项目选择 provider：

```bash
curl -fsSL https://raw.githubusercontent.com/justforyou16007/paseo/arl/distribution/install-arl.sh -o /tmp/install-arl.sh
bash /tmp/install-arl.sh --provider claude --project /你的项目目录
# Codex 项目使用：
bash /tmp/install-arl.sh --provider codex --project /你的项目目录
```

安装器校验包的哈希，安装项目技能、编译好的 helper 和运行依赖。目标机器不需要源码仓库或 npm install。Codex 必须信任项目，才会加载项目 MCP 配置。

先配置 validation，再把地址和 token 私下交给 worker。完整步骤见[中文部署指南](SETUP_GUIDE_CN.md)。

## 开发

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test -- tests/test_setup.ts
npm run pack:arl
```

打包产物及校验文件在 `artifacts/`。更新 Bash 下载安装包时，把两份文件复制到 `distribution/releases/` 后提交。参见[打包约定](docs/arl-install.md)、[贡献指南](CONTRIBUTING_CN.md)和[架构说明](ARIS_ARCHITECTURE_GUIDE.md)。

## 许可证

[MIT](LICENSE)，保留原 ARIS 作者的版权声明。
