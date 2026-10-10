# Auto Research Loop（ARL）安装

ARL 使用两台机器：worker 交付 zip，validation 持有冻结 benchmark、评分并发布脱敏反馈。双方只通过 `submit` 和 `query` MCP 工具交互。规划、编码、调试和委派由 agent 自己完成，不恢复旧的固定研究流水线。

两台机器都使用官方 Paseo 和官方 CLI。ARL 从本地源码仓库安装项目技能、编译好的 Node helper、运行依赖和模板，不需要定制 Paseo。官方 App 可查看 agent 和服务脚本，没有定制版 ARIS 知识图谱标签页；wiki 通过技能和文件读取。

## 安装

准备 Bash、Git、Node.js 22.12+、已认证的 Claude Code 或 Codex，以及运行中的官方 Paseo（`paseo daemon status`）。验证端另外准备 benchmark 所需依赖。Windows 可使用 Git Bash；Node 需在 PATH 中，WSL 则是独立 Linux 环境。

在各机器的本地 `arl` 分支 Git 仓库中，先显式准备依赖和编译产物，再安装到项目：

```bash
cd /path/to/local/arl-checkout
npm ci
npm run build
bash distribution/install-aris.sh --provider claude --project /path/to/project
# 或：
bash distribution/install-aris.sh --provider codex --project /path/to/project
```

安装脚本只读取已准备好的本地仓库，不执行 Git clone/pull、npm 安装或下载，不需要 tar。缺少依赖或编译产物时直接报错并提示准备步骤。`distribution/install-arl.sh` 是同一流程的别名，旧的 `ARL_ARCHIVE` 和 `ARL_DOWNLOAD_BASE` 环境变量不再使用。可从任意目录通过绝对路径调用脚本，`--dry-run` 不写入目标项目。

若需手动离线分发，可另行执行 `npm run pack:arl` 并传输归档；目标机器无 Git 仓库时，在项目目录之外解压并安装：

```bash
tar -xzf arl-0.1.0.tar.gz
bash arl/install.sh --provider claude --project /path/to/project
# Codex 项目改用：
bash arl/install.sh --provider codex --project /path/to/project
```

Claude 技能位于 `.claude/skills/`，setup 写 `CLAUDE.md` 和 `.mcp.json`。Codex 技能位于 `.agents/skills/`，setup 写 `AGENTS.md` 和 `.codex/config.toml`。已有无关条目保留。**Codex 必须信任该项目才会加载项目 MCP 配置**，然后重新打开会话。

包内包含 `aris-setup`、`validation-review`、`research-wiki`、`browser-act`、`experiment-queue`、`experiment-env-configuration` 六个技能，以及队列 helper 在内的运行依赖闭包。保留 `.aris/` 数据路径，不安装任何子 agent 定义。文献检索、GPU 平台和通知等可选集成留在源码中，不随独立包安装。

## 配置两端

两台机器建立独立项目并加入官方 Paseo，不共享磁盘、仓库或同步目录。项目 `.gitignore` 排除 `.aris/` 和 provider MCP 配置，因为它们包含凭据。

1. 验证端先写 `task.md`，运行 `aris-setup validation`。Claude 用 `/aris-setup validation`，Codex 调用 `$aris-setup` 并指定 validation。
2. 一次审阅完整配置表：benchmark 固定源码/数据版本、切分、样本数、runner argv、指标目标、隐藏文件、次数和服务地址。validation agent 的 provider 与本项目安装一致。
3. 确认配置摘要后，setup 执行 benchmark 安装、healthcheck 和 smoke，冻结配置，生成 token，并将 `aris-validation` 服务写入 `paseo.json`。从官方 Paseo 启动该服务。
4. 私下把输出的 URL/token 和相同 `task.md` 交给 worker。worker 运行 `aris-setup worker`，在同一配置表中审阅连接和环境需求并确认。环境 PRD 为 null 时由 agent 自己管理环境；填写 PRD 后，setup 内部调用 `experiment-env-configuration`，生成并验证 `run-<项目>-experiment` 环境使用 skill，包含使用说明、冻结配置和操作脚本。验证端填写环境 PRD 时也走这一步。
5. setup 报告生成的 skill 路径和验证结果后，用户在客户端执行 `reload-skills` 加载技能。客户端没有重载动作时重新打开会话；worker 的 MCP 配置变更也需要新会话（Codex 先信任项目）。验证 `query` 返回 open，再让 worker 执行任务。合法提交达标时 completed，次数耗尽时 closed。

worker 的 `CLAUDE.md` 或 `AGENTS.md` 会列出 `submit` / `query`、`research-wiki`、`browser-act`、`experiment-queue` 和环境技能的入口与用途。浏览器 CLI 按需检查或安装；队列执行端需要 SSH、Node.js 22.12+、sh、jq、screen 和实验依赖。使用前读取对应 skill。

每次提交取得 validation 已发布的最终结论后，worker 将有实际依据、可跨项目复用的经验精简到本地 ARL 源码仓库 `arl` 分支根目录的 `Experience.md`，合并重复经验，无新经验则不添加；项目细节留在 wiki。setup 在 worker 的 `CLAUDE.md` 或 `AGENTS.md` 中记录该位置，源码 checkout 需可写，其中的 `CLAUDE.md` 指向 `Experience.md`；安装目录 `.aris/` 不是经验仓库。保存规则见[经验保存约定](skills/shared-references/experience.md)；即使达标或次数耗尽，也应完成经验整理后再结束。

私网/VPN 直连：`host=0.0.0.0`、固定 port（如 8790）、`public_url=http://<验证端地址>:8790`，开放防火墙端口。已有 Paseo service proxy 时可用 `host=127.0.0.1`、port=null 和脚本代理 URL。安装包不配置 DNS/proxy。

Windows 验证端的 `agent.paseo_command` 使用 `["node", "<Paseo install>\\bin\\paseo"]`，不要直接调用 `.cmd` shim。验证端状态：`node .aris/dist/tools/validation-cli.js status --project .`。

生成的环境操作需要 POSIX sh、jq，以及 PRD 指定的 SSH、rsync、Python 或容器等工具；这些项目依赖不在包内。

## 升级

显式更新本地源码仓库并运行 `npm run build`（锁文件变化时先运行 `npm ci`），再运行相同的 `distribution/install-aris.sh --provider ... --project ...` 命令，可先加 `--dry-run`。安装器基于当前本地文件生成临时文件包并校验哈希，管理 `.aris/install.json` 中登记的文件，补回缺失文件，拒绝覆盖本地修改。保存修改后可明确使用 `--force`。任务、wiki、benchmark、提交记录、setup 状态和自行生成的实验技能不覆盖。

已配置项目升级后执行 `node .aris/dist/tools/setup-cli.js apply --project .` 更新角色段，再执行客户端的 `reload-skills`；MCP 配置变更或客户端无重载动作时重新打开会话，无需重启 daemon。旧定制版安装没有独立包清单，先备份并优先使用新项目，或检查冲突后选择 `--force`；安装器不会删除旧全局链接和用户 agent 文件。

完整字段、网络和故障排查见包内 [英文指南](README.md)。源码阅读时见 [SETUP_GUIDE.md](SETUP_GUIDE.md)。
