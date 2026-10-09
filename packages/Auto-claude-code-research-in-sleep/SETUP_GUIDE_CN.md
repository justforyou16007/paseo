# Auto Research Loop（ARL）安装

ARL 使用两台机器：worker 交付 zip，validation 持有冻结 benchmark、评分并发布脱敏反馈。双方只通过 `submit` 和 `query` MCP 工具交互。规划、编码、调试和委派由 agent 自己完成，不恢复旧的固定研究流水线。

两台机器都使用官方 Paseo 和官方 CLI。安装包只提供项目技能、编译好的 Node helper、运行依赖和模板，不需要定制 Paseo、源码仓库或目标机器上的 npm install。官方 App 可查看 agent 和服务脚本，没有定制版 ARIS 知识图谱标签页；wiki 通过技能和文件读取。

## 安装

准备 Bash、tar、Node.js 22.12+、已认证的 Claude Code 或 Codex，以及运行中的官方 Paseo（`paseo daemon status`）。验证端另外准备 benchmark 所需依赖。Windows 可使用 Git Bash；Node 需在 PATH 中，WSL 则是独立 Linux 环境。

直接从远程 `arl` 分支安装（仅下载并校验独立包）：

```bash
curl -fsSL "https://raw.githubusercontent.com/justforyou16007/paseo/arl/packages/Auto-claude-code-research-in-sleep/distribution/install-arl.sh" -o /tmp/install-arl.sh
bash /tmp/install-arl.sh --provider claude --project /path/to/project
# 或：
bash /tmp/install-arl.sh --provider codex --project /path/to/project
```

离线时，在项目目录之外解压安装包，每个项目选择一种 provider：

```bash
tar -xzf arl-0.1.0.tar.gz
bash arl/install.sh --provider claude --project /path/to/project
# Codex 项目改用：
bash arl/install.sh --provider codex --project /path/to/project
```

Claude 技能位于 `.claude/skills/`，setup 写 `CLAUDE.md` 和 `.mcp.json`。Codex 技能位于 `.agents/skills/`，setup 写 `AGENTS.md` 和 `.codex/config.toml`。已有无关条目保留。**Codex 必须信任该项目才会加载项目 MCP 配置**，然后重新打开会话。

包内只有 `aris-setup`、`aris-update`、`validation-review`、`research-wiki`、`experiment-env-configuration` 五个技能及其运行闭包。保留技能名称和 `.aris/` 数据路径，不安装任何子 agent 定义。

## 配置两端

两台机器建立独立项目并加入官方 Paseo，不共享磁盘、仓库或同步目录。项目 `.gitignore` 排除 `.aris/` 和 provider MCP 配置，因为它们包含凭据。

1. 验证端先写 `task.md`，运行 `aris-setup validation`。Claude 用 `/aris-setup validation`，Codex 调用 `$aris-setup` 并指定 validation。
2. 一次审阅完整配置表：benchmark 固定源码/数据版本、切分、样本数、runner argv、指标目标、隐藏文件、次数和服务地址。validation agent 的 provider 与本项目安装一致。
3. 确认配置摘要后，setup 执行 benchmark 安装、healthcheck 和 smoke，冻结配置，生成 token，并将 `aris-validation` 服务写入 `paseo.json`。从官方 Paseo 启动该服务。
4. 私下把输出的 URL/token 和相同 `task.md` 交给 worker。worker 运行 `aris-setup worker`，填 URL/token，审阅并确认。环境 PRD 为 null 时由 agent 自己管理环境，填 PRD 则生成实验脚本。
5. 重新打开 provider 会话（Codex 先信任项目），验证 `query` 返回 open，再让 worker 执行任务。合法提交达标时 completed，次数耗尽时 closed。

私网/VPN 直连：`host=0.0.0.0`、固定 port（如 8790）、`public_url=http://<验证端地址>:8790`，开放防火墙端口。已有 Paseo service proxy 时可用 `host=127.0.0.1`、port=null 和脚本代理 URL。安装包不配置 DNS/proxy。

Windows 验证端的 `agent.paseo_command` 使用 `["node", "<Paseo install>\\bin\\paseo"]`，不要直接调用 `.cmd` shim。验证端状态：`node .aris/dist/tools/validation-cli.js status --project .`。

生成的环境操作需要 POSIX sh、jq，以及 PRD 指定的 SSH、rsync、Python 或容器等工具；这些项目依赖不在包内。

## 升级

从新安装包运行同一 provider/project 命令，可先加 `--dry-run`。安装器校验包内哈希，管理 `.aris/install.json` 中登记的文件，补回缺失文件，拒绝覆盖本地修改。保存修改后可明确使用 `--force`。任务、wiki、benchmark、提交记录、setup 状态和自行生成的实验技能不覆盖。

已配置项目升级后执行 `node .aris/dist/tools/setup-cli.js apply --project .` 更新角色段，再重新打开会话；无需重启 daemon。旧定制版安装没有独立包清单，先备份并优先使用新项目，或检查冲突后选择 `--force`；安装器不会删除旧全局链接和用户 agent 文件。

完整字段、网络和故障排查见包内 [英文指南](README.md)。源码阅读时见 [SETUP_GUIDE.md](SETUP_GUIDE.md)。
