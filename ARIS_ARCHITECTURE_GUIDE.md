# Auto Research Loop（ARL）架构

ARL 是可独立安装、配合官方 Paseo 使用的两机研究任务包。保留 ARIS 技能名称和数据路径。安装包不包含 Paseo，也不向全局目录或 agents 目录复制定义。具体怎么用看各技能的 `SKILL.md`，路由索引见 [AGENT_GUIDE.md](AGENT_GUIDE.md)，两台机器的部署见 [SETUP_GUIDE_CN.md](SETUP_GUIDE_CN.md)。

## 一、出发点

前沿模型拿到任务和环境后，已经能自己规划、写代码、训练、调试、派子 agent。以前 ARIS 把一轮研究写死成"想法 → 实现 → 测试 → 审计 → 评审 → 停止门"的流水线，这层脚手架现在成了上限，所以删掉了。

模型还做不好的一件事，是给自己的成果下结论：同一个 agent 写的评测，评出来的分数不可信。ARIS 现在只解决这一件事，做法是把"做"和"判"放到两台互相看不见的机器上：

- **worker** 只管做。它拿到 `task.md`，用自己的环境和 wiki 交付一个 zip。
- **validation** 只管判。它持有 worker 看不到的冻结 benchmark，对每次提交给出结论、分数和脱敏反馈，并按确定性指标决定任务何时结束。

## 二、两台机器之间只有一条通道

```
worker 机器                                   validation 机器
┌───────────────────────┐                     ┌──────────────────────────────────┐
│ Paseo                 │                     │ Paseo                            │
│  └ worker agent       │  MCP: submit/query  │  ├ aris-validation 服务脚本       │
│     task.md           │ ──────────────────▶ │  │   .aris/validation/            │
│     research-wiki/    │  curl.exe -T x.zip  │  └ 每次提交一个 validation agent  │
│     provider MCP     │ ──────────────────▶ │      .aris/tester-config.json     │
└───────────────────────┘                     └──────────────────────────────────┘
```

两边不共享磁盘、不共享仓库、不互发消息。worker 能拿到的只有 `query` 返回的内容：服务状态、剩余次数、最好成绩，以及某次提交的状态、结论、分数和反馈。这样防作弊就不靠规则约束 agent，而是靠物理隔离：worker 根本读不到 benchmark。

验证机器不断网，因为有些任务的验证本身要联网（下载依赖、调用外部服务）。防作弊靠的是 validation agent 检查交付内容，而不是切断网络。

## 三、一次提交怎么走

1. worker 调 `submit`，拿到一次性上传地址，用 `curl.exe -T` 把 zip 直接传到验证机器。
2. 服务端算 sha256，安全解压（拒绝 `../` 路径，限制总大小和文件数），检查根目录有没有 `USAGE.md`。格式不对就拒收，**不计次数**——格式错误不该消耗 worker 的机会。
3. 服务通过本机 `paseo run` 为这次提交新建一个 validation agent。它出现在验证机器的 Paseo 前端里，提示词只给提交编号和目录。
4. validation agent 按 `validation-review` 技能走：先读代码找作弊迹象，再照 `USAGE.md` 写调用适配器，跑冻结 benchmark，最后写出结论（`valid` / `cheating` / `unusable`）和反馈。
5. `finalize` 发布结果。之后 worker 的 `query` 才能看到。

### 分数为什么不由 agent 来报

agent 的结论只决定"算不算分"，分数本身由 helper 从 benchmark 的逐样本输出里复算：样本数必须等于冻结时登记的完整协议数，失败样本必须以零分留在列表里，聚合值要和逐样本结果对得上。所以 agent 就算写错了数字，也改变不了发布的分数。

结论是 `cheating` 时分数作废，哪怕 benchmark 跑出了高分。因为作弊得来的高分正是这套系统要拦下的东西。

### 反馈为什么要过泄漏检查

反馈只能写问题类型和编造的示例，不能引用隐藏数据。`finalize` 会把反馈和隐藏样本、标签逐段比对（先统一大小写、标点和空白，防止改个格式就绕过去），还会查样本 ID。命中后退回给 agent 重写；重写次数用完，就只发布分数，不发反馈。宁可少给信息，也不能把测试集漏给 worker。

## 四、冻结与停止

- **benchmark 冻结。** setup 时由用户确认 benchmark 的来源、数据版本、切分、完整样本数和目标指标，然后算出摘要写进 `.aris/validation/config.json`。benchmark 依赖的文件在 setup 时记下哈希，之后有任何改动服务就停止，因为分数之间必须可比。要改 benchmark 只能开一个新的 validation 项目。
- **次数有上限。** 计次的只有真正走完审查的提交（得分、作弊、无法运行）；上传超时、格式错误、本方故障都不计。
- **确定性停止。** 某次 `valid` 提交的分数达到冻结目标，服务进入 `completed`；计次提交用完，进入 `closed`。两种状态下都不再接收新提交，worker 看到后就停。

## 五、谁写哪个文件

每个事实只有一个写入方，其他人只读：

| 文件 | 唯一写入方 |
| --- | --- |
| `.aris/setup-*.json`、`.aris/tester-config.json`、provider MCP 配置和 `paseo.json` 里的 ARIS 条目 | `setup-cli.js` |
| `.aris/validation/` 下的提交记录、发布结果 | `validation-cli.js`（服务和 `finalize`） |
| 提交目录里的 `inspection.md`、`review.json`、`feedback.md`、适配器 | validation agent |
| `research-wiki/` | `research-wiki.js` |
| 本地 ARL 源码仓库 `arl` 分支的 `Experience.md` | worker agent（仅依据自身过程和已发布结果，精简、去重并保留跨项目经验） |
| provider 技能目录中的 `run-<project>-experiment/` | setup 调用的 `experiment-env-configuration`，后续环境修复也通过该技能 |

`CLAUDE.md`（Claude）或 `AGENTS.md`（Codex）里 `ARIS ROLE` 标记之间的角色段由 setup 写入，标记外的内容 setup 不碰。

worker 每次获得 validation 已发布的最终结论后，按[经验保存约定](skills/shared-references/experience.md)整理 `Experience.md`；validation agent 不参与经验写入，也不增加两机之间的通道。本地源码 checkout 的位置记录在 worker 项目指令的角色段外，源码仓库的 `CLAUDE.md` 指向经验文件。

## 六、Paseo 里能看到什么

- 两台机器各自的 agent：worker agent，以及每次提交对应的一个 validation agent。
- 验证机器工作区的 `aris-validation` 服务脚本，包括端口、运行状态和代理地址。
官方 App 没有定制版 ARIS 知识图谱标签页。通过 `research-wiki` 技能、CLI 或本机 Markdown 查看记录。本仓库只提供研究技能和服务，不包含 Paseo 前端代码。

## 七、保留了什么、删掉了什么

判断标准只有一条：Claude Code agent 自己能做的，ARIS 就不再提供流程。

- **独立包包含**：setup、validation-review、wiki、browser-act、experiment-queue、环境配置及其 helper 依赖闭包。setup 的环境输出是验证过的环境使用 skill；安装和升级使用同一安装器。部署和技能重载见 [SETUP_GUIDE_CN.md](SETUP_GUIDE_CN.md)。GPU 平台、文献检索、飞书和 Overleaf 等技能留在源码中，不进入安装包。
- **删除**：研究循环、各类审计和评审技能、子 agent 派发协议、worker manifest、Pipeline/Review 等前端视图。规划、派发、自查都是 agent 自己的工作。

## 八、加新功能前先问

1. agent 自己能不能做？能做就不要加技能或 helper。
2. 它会不会让 worker 看到 benchmark、隐藏数据或验证方的中间产物？会的话就不能做。
3. 它是不是在给 worker 自己的结果下结论？结论只能来自验证方。
4. 它新增的状态有没有唯一的写入方？如果某个已有文件因此变得多余，要在同一次改动里删掉。
5. 它在 Windows 上能不能跑？helper 用 Node 写，不调用 shell 脚本；命令用 argv 数组，不拼字符串。
