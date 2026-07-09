# ARIS 架构全景指南

> **目标**: 让你快速理解 ARIS 的全部工作原理和已有机制,从而在新增功能时能**复用已有模式**、**避免重复造轮子**、**确保新功能融入现有框架**。
>
> 本文档按"哲学 → 架构 → 核心机制 → 管道流 → 工具链 → 平台适配 → 新功能设计检查清单"组织。

---

## 一、核心哲学:一条贯穿所有设计的红线

ARIS 的全部架构围绕 **一个不可妥协的原则** 展开,它在 `shared-references/` 中被反复重述:

> **一个系统可以 DRIVE(驱动)自己的进展,但绝不能 ACQUIT(裁决)自己的质量。**

- **DRIVE** = 执行、完成、广度、调度、机械检查。这些可以同模型自己做(安全)。
- **ACQUIT** = 正确性、新颖性、充足性、完整性。这些**必须**由不同模型家族裁决(跨模型陪审团)。

这个原则的推论构成 ARIS 的全部设计:

| 推论                      | 体现在哪里                                                         |
| ------------------------- | ------------------------------------------------------------------ |
| 代码评审必须跨模型        | `experiment-bridge` 的 Phase 2.5,GPT-5.5 审 Claude 写的代码        |
| 论文评审必须跨模型        | `auto-review-loop` 用 Codex MCP (GPT-5.5) 评审论文                 |
| 同模型扩样本不等于跨模型  | `acceptance-gate.md`: 10 个 Claude 一致 ≠ 1 个 GPT 意见            |
| 机械检查可以自判          | 文件是否存在、exit code、N 个 shard 是否返回——这些 executor 可自判 |
| 外部队列只能"催",不能"判" | `external-cadence.md`: `/loop` 可以说"继续",不能说"够了"           |

> **新功能检查**:如果你的功能涉及"判断质量/正确性/完整性",默认必须路由到不同模型家族。

---

## 二、系统架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                         ARIS 方法论                              │
│      (不是平台,是 80+ 个可组合的 Markdown skill)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Executor 执行器   │  │  Reviewer 评审器    │  │  Deterministic    │
│ (Claude/GPT/GLM) │  │ (GPT-5.5/Gemini) │  │  Verifier (脚本)   │
│ 写代码、跑实验、    │  │ 审论文、审代码、    │  │ exit code 判定     │
│ 写论文            │  │ 审 claim          │  │                   │
└─────────────────┘  └──────────────────┘  └──────────────────┘
         │                    │                      │
         └────────────────────┼──────────────────────┘
                              ▼
                    ┌──────────────────┐
                    │   磁盘文件 (状态)   │
                    │ CLAUDE.md,        │
                    │ REVIEW_STATE.json │
                    │ research_contract │
                    └──────────────────┘
```

### 2.1 两个独立的控制轴

ARIS 的所有 skill 都接受两个正交维度:

| 轴                   | 取值                                               | 控制什么                            | 默认映射                                      |
| -------------------- | -------------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| **effort** (深度)    | `lite / balanced / max / beast`                    | 搜多少论文、生成多少 idea、跑多少轮 | 无                                            |
| **assurance** (审计) | `draft / polished / conference-ready / submission` | 审计门禁多严格                      | lite/balanced → draft, max/beast → submission |

**关键**:这两个轴可以独立覆盖(`— effort: lite, assurance: conference-ready` 表示"跑得快但每个审计都必须出裁决")。

> **新功能检查**:你的新功能是否引入了第三个控制轴?如果是,需要确认它和 effort/assurance 不重叠;如果不是,请复用这两个轴。

### 2.2 Skill 调用机制

每个 skill 是一个 `SKILL.md` 文件,包含 YAML frontmatter。调用语法在各平台一致:

```
/skill-name "参数" — key: value, key2: value2
```

参数自动沿调用链向下传递(`research-pipeline` 设置的 `sources` 会传到 `idea-discovery` 再传到 `research-lit`)。

> **新功能检查**:新增功能应该做为一个新 `skills/<name>/SKILL.md` 文件,复用现有参数传递机制。

---

## 三、核心机制清单(新增功能前必读)

以下列出 ARIS 已具备的**全部核心机制**。新增功能前,请逐条检查你的需求是否已被覆盖。

### 3.1 跨模型评审 (Cross-Model Review)

| 机制           | 位置                         | 说明                                                |
| -------------- | ---------------------------- | --------------------------------------------------- |
| Codex MCP 评审 | `reviewer-routing.md`        | 默认评审器:GPT-5.5 via Codex MCP, `xhigh` reasoning |
| Claude 评审    | `mcp-servers/claude-review/` | Codex 执行 + Claude 评审                            |
| Gemini 评审    | `mcp-servers/gemini-review/` | Codex 执行 + Gemini 评审                            |
| 手动评审       | `MANUAL_REVIEW_GUIDE.md`     | 零成本:粘贴 prompt 到任意非 Claude 模型             |
| 评审独立性     | `reviewer-independence.md`   | 评审只收**文件路径**,不收 executor 的摘要/解读      |
| 评审追踪       | `review-tracing.md`          | 每次评审调用保存到 `.aris/traces/`                  |
| 评审路由       | `reviewer-routing.md`        | `— reviewer: codex\|oracle-pro\|manual\|agy`        |

### 3.2 并行与扇出 (Fan-Out)

| 机制       | 位置                 | 说明                                                |
| ---------- | -------------------- | --------------------------------------------------- |
| 扇出生成   | `fan-out-pattern.md` | 子 agent 并行**生成候选**,不评分                    |
| 陪审团裁决 | `fan-out-pattern.md` | 扇出后统一跨模型评审                                |
| 3 级降级   | `fan-out-pattern.md` | T1 Workflow 并行 → T2 Agent 工具 → T3 顺序,裁决不变 |
| 去重       | `fan-out-pattern.md` | 机械去重在 executor 侧(安全),不在评审侧             |
| 只读 shard | `fan-out-pattern.md` | 并行 shard 对共享产物只读                           |

> **新功能检查**:如果需要并行处理,请复用 `fan-out-pattern.md` 的模式,不要自创并行机制。

### 3.3 外部调度与心跳 (External Cadence)

| 机制             | 位置                  | 说明                                                   |
| ---------------- | --------------------- | ------------------------------------------------------ |
| `/loop` 定时器   | `external-cadence.md` | 只能用于等外部世界(GPU 完成、文件生成)                 |
| CronCreate       | `external-cadence.md` | 同上,只能用于 ADDITIVE 场景                            |
| 禁止包装语义循环 | `external-cadence.md` | `/auto-review-loop` 不可包在 `/loop` 里(破坏 threadId) |
| 心跳状态文件     | `external-cadence.md` | 每个 loop 必须先写心跳文件                             |
| 停滞检测         | `external-cadence.md` | 用 `iteration_log.py` 计新发现数,不是凭感觉            |

> **新功能检查**:如果你的功能需要定时轮询,先判断是"等外部世界"还是"包装语义循环"。前者用 `/loop`/CronCreate,后者用 skill 自身的内部循环。

### 3.4 会话恢复与状态持久化

| 机制                 | 位置                                     | 说明                                            |
| -------------------- | ---------------------------------------- | ----------------------------------------------- |
| Pipeline Status      | `CLAUDE.md` 中的 `## Pipeline Status` 段 | 结构化快照:stage/idea/active_tasks/next         |
| Research Contract    | `idea-stage/docs/research_contract.md`   | 只提取当前选中 idea 的聚焦上下文                |
| REVIEW_STATE.json    | `review-stage/REVIEW_STATE.json`         | auto-review-loop 的恢复状态                     |
| 恢复读取顺序         | `SESSION_RECOVERY_GUIDE.md`              | CLAUDE.md → research_contract → 日志 → 远程检查 |
| PreCompact hook      | `SESSION_RECOVERY_GUIDE.md`              | 压缩前提醒保存 4 类状态文件                     |
| session-restore hook | `SESSION_RECOVERY_GUIDE.md`              | 新会话自动读取状态                              |

> **新功能检查**:新增的长时间运行功能**必须**写入 Pipeline Status,并考虑会话恢复路径。

### 3.5 审计与质量门禁

| 机制            | 位置                     | 说明                                |
| --------------- | ------------------------ | ----------------------------------- |
| 实验审计        | `/experiment-audit`      | 评估代码是否诚实(假 GT、归一化欺诈) |
| Claim 追溯      | `/result-to-claim`       | claim 是否科学地来源于实验结果      |
| 论文 Claim 审计 | `/paper-claim-audit`     | 论文是否如实报告数字                |
| 引用审计        | `/citation-audit`        | 每个 `\cite{}` 有效                 |
| 反驳论证        | `/kill-argument`         | 200 字最强拒绝备忘录 + 独立仲裁     |
| 审计验证脚本    | `verify_paper_audits.sh` | exit 0 阻塞 Final Report            |
| 5 层审计链      | `AGENT_GUIDE.md`         | 全通过才允许 submission             |

所有审计输出 6 状态裁决: `PASS | WARN | FAIL | BLOCKED | ERROR | NOT_APPLICABLE`

### 3.6 集成契约 (Integration Contract)

| 机制          | 位置                      | 说明                                                                           |
| ------------- | ------------------------- | ------------------------------------------------------------------------------ |
| 6 组件要求    | `integration-contract.md` | 每个跨 skill 集成必须提供:激活谓词 + 规范 helper + 产物 + 清单 + 回退 + 验证器 |
| Helper 解析链 | `integration-contract.md` | `$CLAUDE_SKILL_DIR/scripts/` → `.aris/tools/` → `tools/` → `$ARIS_REPO/tools/` |
| 失败策略 A-E  | `integration-contract.md` | A=阻塞 / B=告警跳过 / C=取证 / D1=级联 / D2=多源 / E=诊断                      |
| Agent 全景契约 | `paseo-subagent-dispatch.md` (executor half) + `paseo-reviewer-dispatch.md` (reviewer half) | Rule 1 (One Agent = One Skill) / Rule 2 (Parent-Child Push) / Rule 3 (Content-Free Inter-Agent Handshake) / Rule 4 (Paseo MCP Only, Strict)。每条 ARIS skill 都必须满足;`reviewer-independence.md` 是 Rule 3 的子集,`external-cadence.md` 是 Rule 4 在调度场景的扩展,`resumable-runs.md` 是 Rule 2 在 resume 场景的扩展,`skill-governance.md` 是 Rule 4 的结构性保证。 |

> **新功能检查**:如果你的功能需要调用其他 skill 或工具,必须提供 6 组件集成,不能只写"必须调用 X"。同时,你的功能必须满足 `paseo-subagent-dispatch.md` / `paseo-reviewer-dispatch.md` §"Global Agent Rules" 中的 Rule 1–4(尤其 Rule 1:每个 agent 只能跑当前 skill;Rule 4:仅通过 Paseo MCP 管理生命周期)。

### 3.7 输出管理

| 机制       | 位置                    | 说明                                                  |
| ---------- | ----------------------- | ----------------------------------------------------- |
| 版本化输出 | `output-versioning.md`  | 时间戳文件 + 固定名文件,下游读固定名                  |
| 舞台目录   | `output-versioning.md`  | `idea-stage/` `refine-logs/` `review-stage/` `paper/` |
| 输出清单   | `output-manifest.md`    | 15+ 产物时才生成 MANIFEST.md                          |
| 组合模式   | `output-composition.md` | `— composed: <path>` 模式折叠输出                     |
| 输出语言   | `output-language.md`    | CLAUDE.md language 字段控制,机器标记永不本地化        |

### 3.8 工具链 (tools/)

ARIS 在 `tools/` 下有一整套可复用工具。新增功能前检查是否已存在:

| 工具                                                                                                        | 用途                   |
| ----------------------------------------------------------------------------------------------------------- | ---------------------- |
| `research_wiki.py`                                                                                          | 持久化知识库           |
| `run_state.py`                                                                                              | 可恢复运行的阶段状态机 |
| `iteration_log.py`                                                                                          | 迭代计数/新发现计数    |
| `save_trace.sh`                                                                                             | 保存评审追踪           |
| `verify_paper_audits.sh`                                                                                    | 审计门禁总闸           |
| `verify_papers.py`                                                                                          | 引用验证               |
| `evidence_check.py`                                                                                         | 证据存在性检查         |
| `threat_scan.py`                                                                                            | 提示注入扫描           |
| `capture_filter.py`                                                                                         | 知识捕获过滤           |
| `watchdog.py`                                                                                               | 远程训练监控守护进程   |
| `provenance.py`                                                                                             | 溯源验证/跨模型断言    |
| `extract_paper_style.py`                                                                                    | 论文风格提取           |
| `figure_renderer.py`                                                                                        | 图表渲染               |
| `arxiv_fetch.py` / `deepxiv_fetch.py` / `semantic_scholar_fetch.py` / `exa_search.py` / `openalex_fetch.py` | 文献搜索               |
| `analysis_tools.py`                                                                                         | 分析工具               |

> **新功能检查**:在新增工具前,确认 `tools/` 中没有功能重叠的已有工具。

### 3.9 知识捕获与反污染

| 机制      | 位置                      | 说明                                                          |
| --------- | ------------------------- | ------------------------------------------------------------- |
| 捕获过滤  | `capture-antipatterns.md` | 四类不可捕获:环境特定失败、瞬态错误、负面能力声明、单实例叙事 |
| 注入卫生  | `injection-hygiene.md`    | `threat_scan.py` 正则扫描,无模型                              |
| 研究 Wiki | `research-wiki` skill     | 持久化论文/想法/实验/claim                                    |

### 3.10 实验调度与监控

| 机制     | 位置                  | 说明                         |
| -------- | --------------------- | ---------------------------- |
| 实验队列 | `/experiment-queue`   | 自托管调度器,60s 轮询,依赖链 |
| 训练检查 | `/training-check`     | WandB 指标读取 + 趋势判断    |
| 实验监控 | `/monitor-experiment` | SSH 检查 + 结果汇总          |
| Watchdog | `tools/watchdog.py`   | 无依赖守护进程,24/7 健康检查 |

> **新功能检查**:调度实验用 `/experiment-queue`,监控训练用 `/training-check`,不要自创。

---

## 四、完整管道流 (W1-W6)

### 4.1 主链

```
W1  idea-discovery      → idea-stage/IDEA_REPORT.md + EXPERIMENT_PLAN.md + FINAL_PROPOSAL.md
W1.5 experiment-bridge  → refine-logs/EXPERIMENT_RESULTS.md + 部署的代码
W2  auto-review-loop    → review-stage/AUTO_REVIEW.md (最多 4 轮)
W3  paper-writing       → paper/main.pdf + LaTeX + 审计 JSON
W4  rebuttal            → PASTE_READY.txt + REBUTTAL_DRAFT_rich.md
W5  resubmit-pipeline   → <NewVenue>/ 目录 + RESUBMIT_REPORT.json
W6  paper-talk          → slides/ 演讲幻灯片 + 讲稿
```

### 4.2 各阶段产生的关键文件

```
project/
├── CLAUDE.md                      # Pipeline Status 仪表盘
├── findings.md                    # 轻量发现日志(追加)
├── MANIFEST.md                    # 输出清单(>15 产物时)
│
├── idea-stage/                    # W1 产出
│   ├── IDEA_REPORT.md             # 8-12 个 idea
│   ├── IDEA_CANDIDATES.md         # 精选 3-5 个
│   └── docs/research_contract.md  # 当前选中 idea 的聚焦文档
│
├── refine-logs/                   # W1.5 产出
│   ├── EXPERIMENT_PLAN.md
│   ├── EXPERIMENT_TRACKER.md
│   ├── EXPERIMENT_LOG.md
│   └── FINAL_PROPOSAL.md
│
├── review-stage/                  # W2 产出
│   ├── AUTO_REVIEW.md
│   └── REVIEW_STATE.json
│
├── paper/                         # W3 产出
│   ├── main.tex + main.pdf
│   └── roundN/ (每轮快照)
│
├── .aris/                         # ARIS 运行时状态
│   ├── tools/                     # 工具符号链接
│   ├── traces/                    # 评审追踪
│   └── meta/events.jsonl          # 元事件日志
│
└── research-wiki/                 # 持久化知识库
```

---

## 五、平台适配层

ARIS 在以下平台均可运行,核心 skill 不变:

| 平台        | Skill 根目录                  | 评审机制        | 特殊适配          |
| ----------- | ----------------------------- | --------------- | ----------------- |
| Claude Code | `skills/<name>/`              | MCP (Codex MCP) | 原生,最成熟       |
| Codex CLI   | `skills/skills-codex/<name>/` | `spawn_agent`   | 完整镜像          |
| Cursor      | `skills/<name>/`              | MCP             | `@skills/` 引用   |
| Trae        | `skills/<name>/`              | MCP             | 自然语言发现      |
| Antigravity | `skills/<name>/`              | MCP             | `— reviewer: agy` |
| Copilot CLI | `skills/<name>/`              | MCP             | 无镜像,原生支持   |

> **新功能检查**:如果你的功能涉及平台特定代码,请确认是否需要同时更新 `skills/`(主线路)和 `skills/skills-codex/`(Codex 镜像)。

---

## 六、新增功能设计检查清单

在开始设计新功能前,逐条回答以下问题:

### Step 1: 确认需求未被覆盖

- [ ] 我的功能在现有 80+ skill 中有没有直接对应的?
- [ ] 我的功能在 `tools/` 中有没有可复用的工具?
- [ ] 我的功能是否可以用现有机制的组合实现(而不是全新设计)?

### Step 2: 确认架构对齐

- [ ] 我的功能是 DRIVE(执行)还是 ACQUIT(裁决)?如果是 ACQUIT,必须跨模型。
- [ ] 我的功能是否引入了新的控制维度?能否映射到现有的 `effort`/`assurance` 轴?
- [ ] 我的功能是否需要定时轮询?是等外部世界(ADDITIVE)还是包语义循环(HARMFUL)?
- [ ] 我的功能是否需要并行处理?复用 `fan-out-pattern.md` 而非自创。
- [ ] 我的功能是否需要调用其他 skill?提供 6 组件集成(谓词 + helper + 产物 + 清单 + 回退 + 验证器)。
- [ ] 我的功能是否有审计/质量门禁要求?用 `assurance` 控制,接审计链。
- [ ] 我的功能是否长时间运行?写入 Pipeline Status + 支持会话恢复。

### Step 3: 确认框架集成

- [ ] 我的功能是否遵循 `SKILL.md` 格式(YAML frontmatter + Markdown 正文)?
- [ ] 我的功能是否接受 `— effort:` 和 `— assurance:` 参数?
- [ ] 我的功能是否输出到正确舞台目录(`idea-stage/`/`refine-logs/`/`review-stage/`/`paper/`)?
- [ ] 我的功能是否遵循输出版本化(时间戳 + 固定名)?
- [ ] 我的功能是否需要在多个平台运行?是否需要镜像到 `skills/skills-codex/`?
- [ ] 我的功能涉及的评审调用是否保存 trace 到 `.aris/traces/`?
- [ ] 我的功能是否符合 `paseo-subagent-dispatch.md` / `paseo-reviewer-dispatch.md` §"Global Agent Rules" 的 Rule 1–4(Rule 1:一 agent = 一 skill;Rule 2:push 模型父子工作流;Rule 3:内容空白的握手;Rule 4:仅 Paseo MCP)?

### Step 4: 确认反模式规避

- [ ] 我是否捕获了不该捕获的信息(环境特定失败/瞬态错误/负面能力声明/单实例叙事)?
- [ ] 我是否使用了 `threat_scan.py` 做注入防护?
- [ ] 我是否在评审独立性上让步了(executor 是否向评审传递了摘要/解读)?
- [ ] 我是否创建了一个"同模型多副本"的假跨模型评审?
- [ ] 我是否在 skill 内硬编码了工具路径(应该用 helper 解析链)?

---

## 七、常见陷阱(来自实际教训)

| 陷阱                     | 例子                          | 后果                       | 本文档对应检查       |
| ------------------------ | ----------------------------- | -------------------------- | -------------------- |
| 同模型自审               | Claude 审自己的输出           | 盲区,分数虚高              | Step 2 第一条        |
| prose-only 集成          | "必须调用 X"但不提供 helper   | 上下文压力下 executor 跳过 | Step 2 第五条        |
| 用 `/loop` 包装语义循环  | `/loop 30m /auto-review-loop` | 破坏 threadId,评审失忆     | Step 2 第三条        |
| 同模型多副本充陪审团     | 10 个 Claude 投票             | 相关性盲区不破             | Step 4 第四条        |
| 扇出后做裁决             | 子 agent 并行评分             | 污染评审独立性             | `fan-out-pattern.md` |
| effort 和 assurance 混淆 | "beast 所以审计会自动跑"      | 审计被跳过                 | Step 2 第二条        |
| 硬编码工具路径           | `python3 tools/foo.py`        | 安装路径不同时断裂         | Step 4 第五条        |
| 不写状态文件             | 长时间运行无 Pipeline Status  | 压缩/新会话后失忆          | Step 2 第七条        |
| 评审传摘要               | executor 先总结再送审         | 评审被引导偏差             | Step 4 第三条        |
| 新功能自创并行           | 自己写线程池/子进程           | 和 fan-out 模式不兼容      | Step 2 第四条        |

---

## 附录:关键文件索引

| 文件                                                | 内容                        |
| --------------------------------------------------- | --------------------------- |
| `AGENT_GUIDE.md`                                    | 总路由索引,skill 位置与参数 |
| `skills/shared-references/acceptance-gate.md`       | 核心哲学:DRIVE vs ACQUIT    |
| `skills/shared-references/fan-out-pattern.md`       | 并行模式                    |
| `skills/shared-references/external-cadence.md`      | 外部调度规则                |
| `skills/shared-references/reviewer-independence.md` | 评审独立性契约              |
| `skills/shared-references/reviewer-routing.md`      | 评审后端路由                |
| `skills/shared-references/integration-contract.md`  | 跨 skill 集成契约           |
| `skills/shared-references/assurance-contract.md`    | 审计门禁契约                |
| `skills/shared-references/effort-contract.md`       | 深度/成本控制契约           |
| `skills/shared-references/review-tracing.md`        | 评审追踪契约                |
| `skills/shared-references/capture-antipatterns.md`  | 知识捕获反模式              |
| `skills/shared-references/injection-hygiene.md`     | 注入防护契约                |
| `skills/shared-references/output-versioning.md`     | 输出版本化契约              |
| `skills/shared-references/output-composition.md`    | 输出组合模式                |
| `skills/shared-references/output-manifest.md`       | 输出清单契约                |
| `docs/SESSION_RECOVERY_GUIDE.md`                    | 会话恢复指南                |
| `docs/CUSTOMIZATION.md`                             | 配置标志完整列表            |
| `docs/MODEL_COMBINATIONS.md`                        | 模型组合路由                |
| `docs/SKILLS_CATALOG.md`                            | 全部 80+ skill 目录         |
| `docs/WATCHDOG_GUIDE.md`                            | Watchdog 监控系统           |
| `tools/`                                            | 全部可复用工具              |
