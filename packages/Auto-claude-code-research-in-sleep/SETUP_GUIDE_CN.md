# ARIS 部署指南

ARIS 把一个任务放在两台机器上：**worker** 负责做出交付件，**validation** 用 worker 看不到的 benchmark 给它打分。本指南按 Windows 部署两台机器。为什么要这样拆分，见 [ARIS_ARCHITECTURE_GUIDE.md](ARIS_ARCHITECTURE_GUIDE.md)。

[English](SETUP_GUIDE.md) | 中文版

## 1. 两台机器都要装

1. **Node.js 20+** 和 **Git**。Windows 上：`winget install OpenJS.NodeJS.LTS Git.Git`。
2. **Claude Code**：见 [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)，用 `claude --version` 检查。
3. **Paseo**，并让 daemon 跑起来：`paseo daemon status`。你每添加一个项目，Paseo 都会把 ARIS 技能和编译好的 helper 复制进去，见 [ARIS 自动安装](../../docs/aris-auto-install.md)。打包版 Paseo（桌面 App、全局 npm 安装）需要一份构建好的 ARIS：

   ```powershell
   git clone <aris-repo> $HOME\.paseo\aris
   cd $HOME\.paseo\aris; npm install; npm run build
   ```

4. **只有验证机器需要**：benchmark 依赖的东西，一般是 Python。benchmark 命令写 `python` 而不是 `python3`，这样同一份配置在 Windows 和 Linux 上都能跑。

Windows 10 起自带 `curl.exe` 和 `tar`，worker 上传不需要额外安装。

## 2. 各自建项目

在每台机器上建一个空目录，执行 `git init`，添加到 Paseo，然后检查 `.claude\skills\aris-setup\` 和 `.aris\dist\` 是否已出现。两个项目完全独立：不要共用磁盘、仓库或同步文件夹。

## 3. 验证机器

先配验证机器，因为 worker 需要它的地址和 token。

1. 和用户一起写好 `task.md`。在项目里打开 Claude Code，运行 `/aris-setup validation`。如果没有 `task.md`，setup 会按模板和你一起起草。
2. setup 一次性展示完整的配置单，你把所有修改一次说完。需要你做决定的字段：
   - **Benchmark**：来源、固定的数据版本、切分、完整样本数和 runner 命令。`.aris\templates\tester-benchmark\` 是一个 lm-evaluation-harness 的完整例子。
   - **指标和目标**：达到这个分数任务就结束。
   - **隐藏数据路径**：隐藏样本、标签和参考答案。反馈里引用了这些内容就会被拦下。
   - **限制**：计次提交上限、并发审查数、上传大小、审查超时。
   - **验证 agent**：审查每次提交的 agent 用哪个 provider 和模型。Windows 上把 `paseo_command` 设为 `["node", "<Paseo 安装目录>\\bin\\paseo"]`，因为 Node 不经过 shell 就启动不了 `paseo.cmd`。
   - **服务地址**：见下面的[网络](#网络)。
3. 确认最终配置摘要。setup 会安装 benchmark、跑 healthcheck 和 smoke 测试、冻结 benchmark、生成服务 token，并把 `aris-validation` 脚本写进 `paseo.json`。
4. 在 Paseo App 的工作区里启动 `aris-validation` 脚本。
5. 检查：`node .aris\dist\tools\validation-cli.js status --project .`
6. 记下输出里的 `worker_connection`：一个以 `/mcp` 结尾的 URL 和一个 token。token 用私密渠道发给 worker 机器。

一旦有提交被计次，benchmark 和目标就不能再改。换 benchmark 就要新建一个验证项目。

### 网络

worker 要能通过 HTTP 访问验证服务。二选一：

**直连，适用于内网或 VPN**（最简单）：

- `service.host`：`0.0.0.0`
- `service.port`：一个固定端口，比如 `8790`
- `service.public_url`：`http://<验证机器地址>:8790`

在管理员 PowerShell 里放行这个端口：

```powershell
netsh advfirewall firewall add rule name="ARIS validation" dir=in action=allow protocol=TCP localport=8790
```

**经 Paseo 服务代理**（你已经用域名对外暴露 Paseo 服务时用）：`host` 保持 `127.0.0.1`，`port` 留空，`public_url` 填 `aris-validation` 脚本的代理地址。代理怎么配见 [service-proxy.md](../../docs/service-proxy.md)。

在 worker 机器上执行 `curl.exe http://<地址>:8790/health`，应输出 `{"status":"ok"}`。除这个地址外，其他请求都要带 token。

## 4. worker 机器

1. 把验证机器上的 `task.md` 原样复制到项目根目录。
2. 运行 `/aris-setup worker`，`connection.url` 和 `connection.token` 填第 3 节第 6 步拿到的值。`environment.prd` 留空表示由 agent 自己管理环境；填写环境描述则由 `/experiment-env-configuration` 生成运行脚本。
3. 确认摘要。setup 把 `aris-validation` 服务写进 `.mcp.json`，把 worker 角色段写进 `CLAUDE.md`，并创建 `research-wiki\`。
4. `.mcp.json` 里有 token，把它加进 `.gitignore`。
5. 在项目里重启 Claude Code 让它加载 MCP 服务，然后让它调用 `query`。正常时服务状态是 `open`，剩余次数是满的。

## 5. 运行

在 Paseo 里给 worker 项目开一个 agent，让它按 `task.md` 工作。它的角色段已经写明怎么提交、什么时候停。每次提交，验证机器的 Paseo App 里都会出现一个验证 agent。有提交的分数达到目标（`completed`），或者提交次数用完（`closed`），任务就结束。

两台机器的工作区里，ARIS 标签页都会把各自的 research wiki 显示为知识图谱。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| worker 上 `query` 失败 | `aris-validation` 脚本在运行；在 worker 上能访问 `/health`；URL 以 `/mcp` 结尾；token 一致 |
| 上传卡住或被拒 | 防火墙规则和端口；上传大小限制；上传地址只能用一次且会过期，重新调用 `submit` |
| 提交状态 `invalid` | zip 损坏，或者根目录（或唯一的顶层文件夹）里没有 `USAGE.md`。不计次数。 |
| 提交状态 `failed` | 验证方没能启动 agent，或者审查超时。不计次数。检查 `paseo_command` 和 agent provider。 |
| 改了文件后服务停了 | benchmark 依赖的某个文件变了。恢复它，或者新建验证项目。 |
