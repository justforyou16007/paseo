---
name: research-setup
description: 'Interactive Q&A setup wizard for new ARIS research projects. Bootstraps CLAUDE.md, RESEARCH_BRIEF.md, and research-wiki from user answers; experiment environment configuration is delegated to /experiment-env-manager, and baseline info (method, code location, expected metric) is written into RESEARCH_BRIEF so /auto-research-loop iteration 1 reproduces it through the normal pipeline. Resumable, bilingual (en/zh). Quick mode (default) applies defaults for budget, timeline, early stop, and Paseo config, then shows a review checklist before finishing. Use when user says "研究项目初始化", "setup project", "初始化研究项目", "research setup", "new project", "配置项目", or wants to configure a new ARIS research workspace.'
argument-hint: "[project-name] [— language: en|zh] [— mode: quick|full]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, AskUserQuestion, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__archive_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission
---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in
> [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill;
> Rule 4: Paseo MCP Only, Strict). Phase 7.5 dispatches
> `/experiment-env-manager` via `mcp__paseo__create_agent`.

# Research Project Setup Wizard

Interactive setup for: **$ARGUMENTS**

## Overview

This skill bootstraps a new ARIS research project via a multi-stage Q&A wizard.
It generates all configuration artifacts that downstream skills need:

```
Phase 0  Pre-flight & resume detection
Phase 1  Project basics (name, language)
Phase 2  Research background (field, sub-area, problem)
Phase 3  Prior work & baselines (papers, experiments, results)  [skippable]
Phase 4  Experiment environment (delegated to /experiment-env-manager)
Phase 4.5  Early stop configuration                 [quick mode: default, no questions]
Phase 5  Research goals (venue, work type, metric; budget & timeline defaulted in quick mode)
Phase 5.5  Reference knowledge (skills, documents, domain constraints) [skippable]
Phase 6  Paseo substrate config (multi-agent orchestration)     [quick mode: default, no questions]
Phase 7  Artifact generation (CLAUDE.md, RESEARCH_BRIEF.md, research-wiki, .gitignore)
Phase 7.4  Configuration review checklist (confirm or adjust defaults)
Phase 7.5  Experiment environment configuration (delegated to /experiment-env-manager)
Phase 7.6  Baseline info -> RESEARCH_BRIEF (no reproduction; loop iteration 1 reproduces it)
Phase 8  Summary & next steps
```

**Artifacts generated:**
- `CLAUDE.md` — project dashboard with Pipeline Status, Experiment Environment
- `RESEARCH_BRIEF.md` — structured research direction for `/idea-discovery`
- `research-wiki/` — initialized knowledge base
- `.gitignore` — ARIS trace/cache entries
- `.aris/setup-state.json` — setup state for resumability

## Constants

- **STATE_FILE** = `.aris/setup-state.json`
- **MODE** = `quick` (default) | `full`. Parsed from `$ARGUMENTS`
  (`- mode: full`). `quick` applies the quick-mode defaults below without
  asking; `full` asks every question interactively (the pre-checklist
  behavior). Both modes end with the Phase 7.4 review checklist.

- **TEMPLATES_DIR** — resolved via: `.aris/templates/` (installed project),
  then `templates/` (dev: running from ARIS repo). Gate: if both fail, error
  and exit — templates are required.

Quick-mode defaults:

| Item                    | Default value                | Adjusted in |
| ----------------------- | ---------------------------- | ----------- |
| Compute budget          | `100-500 GPU-hours`          | Phase 5 Q1  |
| Timeline                | `3-6 months`                 | Phase 5 Q2  |
| Early stop              | disabled (manual monitoring) | Phase 4.5   |
| Paseo executor provider | `claude/sonnet-4-6`          | Phase 6 Q1  |
| Paseo reviewer provider | `codex/gpt-5.5`              | Phase 6 Q2  |
| Paseo heartbeat         | `off`                        | Phase 6 Q3  |

Every quick-mode default is surfaced in the Phase 7.4 checklist and can be
adjusted there in one round-trip; nothing is silently baked in past review.

## Output Language

Follow [`shared-references/output-language.md`](../shared-references/output-language.md).
Detect language at Phase 0:
1. Explicit `— language: zh` or `— language: en` in `$ARGUMENTS`
2. If `$ARGUMENTS` or the user's message is in Chinese → `zh`
3. Default: `en`

All AskUserQuestion text follows the detected language. File paths, JSON keys,
YAML field names are always English regardless of language.

---

## Phase 0: Pre-flight & Resume Detection

### 0a. Resolve ARIS repo and templates

```bash
_pr=$(git rev-parse --show-toplevel 2>/dev/null) || { _d=$(pwd); while [ "$_d" != "/" ]; do [ -f "$_d/.aris/installed-skills.txt" ] && { _pr=$_d; break; }; _d=$(dirname "$_d"); done; }
cd "${_pr:-$(pwd)}" || exit 1

# Resolve templates directory (project-local only)
TEMPLATES_DIR=""
if [ -n "${CLAUDE_SKILL_DIR:-}" ]; then
  # Installed: <project>/.claude/skills/<skill>/
  _PROJECT_ROOT="${CLAUDE_SKILL_DIR%/.claude/skills/*}"
  if [ "$_PROJECT_ROOT" = "$CLAUDE_SKILL_DIR" ]; then
    # Dev: <repo>/skills/<skill>/
    _PROJECT_ROOT="${CLAUDE_SKILL_DIR%/skills/*}"
  fi
  [ -d "$_PROJECT_ROOT/.aris/templates" ] && TEMPLATES_DIR="$_PROJECT_ROOT/.aris/templates"
  [ -z "$TEMPLATES_DIR" ] && [ -d "$_PROJECT_ROOT/templates" ] && TEMPLATES_DIR="$_PROJECT_ROOT/templates"
fi
[ -z "$TEMPLATES_DIR" ] && [ -d ".aris/templates" ] && TEMPLATES_DIR=".aris/templates"
[ -z "$TEMPLATES_DIR" ] && [ -d "templates" ] && TEMPLATES_DIR="templates"
[ -z "$TEMPLATES_DIR" ] && {
  echo "ERROR: ARIS templates directory not found. Fix: run /aris-update to refresh the project runtime." >&2
  exit 1
}
```

### 0b. Resume detection

Read `.aris/setup-state.json`. If it exists and `completed` is `false`:

Use AskUserQuestion:
- **header**: "Setup"
- **question** (en): "A partial setup was found (completed stages: N). Resume from where you left off?"
  (zh): "检测到未完成的设置（已完成阶段：N）。从上次中断处继续？"
- **options**: "Resume" / "Start fresh"

If "Resume": skip completed stages, pre-populate answers from state.
If "Start fresh": delete state file, start from Phase 1.

### 0c. Detect existing artifacts

Check for:
- `CLAUDE.md` — if exists, will merge (not overwrite)
- `RESEARCH_BRIEF.md` — if exists and non-empty, will ask before overwriting
- `research-wiki/` — if exists with content, skip wiki init

### 0d. Detect language

Parse `$ARGUMENTS` for `— language: zh` or `— language: en`.
If not specified, detect from user's message language.
Store as `answers.language`.

### 0e. Detect mode

Parse `$ARGUMENTS` for `- mode: full` or `- mode: quick`.
Default when absent: `quick`. Store as `answers.setup_mode`.

In `quick` mode, Phase 4.5 and Phase 6 ask no questions and Phase 5 skips the
budget and timeline questions; the quick-mode defaults (see Constants) are
applied and their keys recorded in `answers.applied_defaults` (e.g.
`["compute_budget", "timeline", "early_stop", "paseo"]`). Phase 7.4 shows
all of them back to the user for confirmation. In `full` mode every question
is asked interactively, as before.

---

## Phase 1: Project Basics

Use AskUserQuestion with 2 questions:

**Question 1:**
- **header**: "Project" / "项目"
- **question** (en): "What is the project name?"
  (zh): "项目名称是什么？"
- **options**: `["<directory-name> (default)", "Other"]`
  where `<directory-name>` is `basename $(pwd)`

**Question 2:**
- **header**: "Language" / "语言"
- **question** (en): "Preferred language for ARIS skill outputs?"
  (zh): "ARIS 技能输出的首选语言？"
- **options**: `["English", "中文"]`
  Default to detected language from Phase 0d.

**After Phase 1:** Save state:
```json
{"version": 1, "completed_stages": [1], "current_stage": 2,
 "answers": {"project_name": "...", "language": "en|zh"}}
```

---

## Phase 2: Research Background

Use AskUserQuestion with 3 questions:

**Question 1:**
- **header**: "Field" / "领域"
- **question** (en): "What is your research field?"
  (zh): "你的研究领域是什么？"
- **options**: `["NLP", "Computer Vision", "Reinforcement Learning", "Systems/Architecture"]`
  (user can select "Other" for free-text input like "robotics", "communications", etc.)

**Question 2:**
- **header**: "Sub-area" / "子方向"
- **question** (en): "What specific sub-area within {field}? (e.g., discrete diffusion models, offline RL, cache optimization)"
  (zh): "在 {field} 中的具体子方向？（如：离散扩散模型、离线 RL、缓存优化）"
- **options**: Provide 2-3 common sub-areas based on the selected field, plus "Other" for free text.

**Question 3:**
- **header**: "Problem" / "问题"
- **question** (en): "What problem are you trying to solve? What is broken or missing in current approaches? (2-3 sentences)"
  (zh): "你想解决什么问题？当前方法有哪些不足？（2-3句话）"
- **options**: Free text only — provide a single example option like
  `"Example: Current discrete diffusion models suffer from slow sampling..."` to guide format,
  plus "Other" for the user's actual input.

**After Phase 2:** Save state with `completed_stages: [1,2]`.

---

## Phase 3: Prior Work & Baselines (Skippable)

Present a skip option first:

**Question 0 (gate):**
- **header**: "Prior Work" / "先前工作"
- **question** (en): "Do you want to provide information about prior work and baselines?"
  (zh): "是否需要提供先前工作和 baseline 的信息？"
- **options**: `["Yes, I have prior work to share", "Skip this stage"]`

If "Skip": set `answers.prior_work_skipped = true`, move to Phase 4.

If "Yes", use AskUserQuestion with 4 questions:

**Question 1:**
- **header**: "Papers" / "论文"
- **question** (en): "Key papers you've read? (provide arXiv IDs, paper titles, or URLs — one per line)"
  (zh): "你读过的关键论文？（提供 arXiv ID、论文标题或 URL — 每行一个）"
- **options**: `["None yet"]` + "Other" for free text input

**Question 2:**
- **header**: "Tried" / "已尝试"
- **question** (en): "What have you already tried? (prior experiments, approaches)"
  (zh): "你已经尝试过什么？（之前的实验、方法）"
- **options**: `["Nothing yet"]` + "Other" for free text

**Question 3:**
- **header**: "Failures" / "失败经验"
- **question** (en): "What didn't work and why?"
  (zh): "哪些方法没有效果，为什么？"
- **options**: `["N/A"]` + "Other" for free text

**Question 4:**
- **header**: "Results" / "已有结果"
- **question** (en): "Any existing results to build on? (preliminary numbers, tables, observations)"
  (zh): "有没有可以利用的已有结果？（初步数据、表格、观察）"
- **options**: `["Starting fresh"]` + "Other" for free text

**After Phase 3:** Save state with `completed_stages: [1,2,3]`.

---

## Phase 4: Experiment Environment (delegated)

This phase asks **no questions**. Environment configuration is owned exclusively
by `/experiment-env-manager`, invoked in Phase 7.5 (after CLAUDE.md exists).

Save state with `completed_stages` including `4`. Do not write `answers.gpu_type`
here — it is transcribed from the generated experiment skill after Phase 7.5.

**After Phase 4:** Save state with `completed_stages: [1,2,3,4]`.

---

## Phase 4.5: Early Stop Configuration

**Quick mode:** ask nothing. Set `answers.early_stop_enabled = false`
(manual monitoring - the previous default answer), append `"early_stop"`
to `answers.applied_defaults`, save state, move to Phase 5. The user can
enable and configure early stopping at the Phase 7.4 checklist.

**Full mode** (or when the user adjusts this item at Phase 7.4):

**Question 1 (gate):**
- **header**: "Early Stop" / "提前停止"
- **question** (en): "Enable automatic early stopping for experiments?"
  (zh): "是否启用实验自动提前停止？"
- **options**: `["No (manual monitoring)", "Yes, configure conditions"]`

If "No": set `answers.early_stop_enabled = false`, skip to Phase 5.

If "Yes, configure conditions":

**Batch 1 (4 questions):**

- Q1 header "Max Time" / "最长时间", question: "Maximum training time before stopping?"
  (zh): "训练的最长时间（超时停止）？"
  options: `["1 week", "3 days", "1 day", "12 hours"]` + "Other"

- Q2 header "Convergence" / "收敛", question: "Stop on loss convergence (plateau)?"
  (zh): "当损失收敛（不再下降）时停止？"
  options: `["Yes", "No"]`

- Q3 header "Divergence" / "发散", question: "Stop on loss divergence (increasing loss)?"
  (zh): "当损失发散（持续上升）时停止？"
  options: `["Yes", "No"]`

- Q4 header "Entropy" / "熵崩溃", question: "For RL experiments, stop on entropy collapse?"
  (zh): "对于强化学习实验，当熵崩溃时停止？"
  options: `["No (not an RL project)", "Yes"]` + "Other"

**Batch 2 (follow-up questions based on answers):**

If Q2 (Convergence) was "Yes":
- Q5 header "Patience" / "耐心值", question: "Patience (epochs without improvement before stopping)?"
  (zh): "耐心值（多少轮没有改进后停止）？"
  options: `["3", "5", "10"]` + "Other"

If Q4 (Entropy) was "Yes":
- Q6 header "Threshold" / "阈值", question: "Entropy threshold?"
  (zh): "熵阈值？"
  options: `["< 0.01", "< 0.001"]` + "Other"

**Batch 3 (1 question):**

- Q7 header "Check Interval" / "检查间隔", question: "How often should the monitoring heartbeat check the job?"
  (zh): "Watchdog 多久检查一次日志？"
  options: `["5 minutes", "10 minutes", "30 minutes"]` + "Other"

**Store configuration in `answers.early_stop`:**

Parse the answers and construct:
```json
{
  "enabled": true,
  "max_training_time_hours": <parsed from Q1>,
  "check_interval_seconds": <parsed from Q7>,
  "convergence": {
    "enabled": <Q2 === "Yes">,
    "patience": <Q5 value or 3>,
    "min_delta": 0.001
  },
  "divergence": {
    "enabled": <Q3 === "Yes">,
    "threshold_multiplier": 2.0
  },
  "entropy_collapse": {
    "enabled": <Q4 === "Yes">,
    "threshold": <Q6 value or 0.01>
  }
}
```

**After Phase 4.5:** Save state with `completed_stages: [1,2,3,4,4.5]`.

---

## Phase 5: Research Goals

**Quick mode:** apply the defaults `answers.compute_budget = "100-500 GPU-hours"`
and `answers.timeline = "3-6 months"`, append `"compute_budget"` and
`"timeline"` to `answers.applied_defaults`, and ask only the questions below
(skipping Q1 Budget and Q2 Timeline). The defaults are shown back at the
Phase 7.4 checklist with a one-click adjust option.

**Batching:** full mode asks Q1-Q8 in two batches of 4 (Q1-Q4, Q5-Q8).
Quick mode skips Q1 and Q2 and asks the remaining six as Q3-Q6 then Q7-Q8.
Q1 and Q2 below are kept as the question definitions for full mode and for
Phase 7.4 adjustments.

- Q1 header "Budget" / "预算", question: "Compute budget for this project?"
  (zh): "项目的算力预算？"
  options: `["< 100 GPU-hours", "100-500 GPU-hours", "> 500 GPU-hours"]` + "Other" for specific text
  (full mode only)

- Q2 header "Timeline" / "时间线", question: "Timeline for this project?"
  (zh): "项目的时间线？"
  options: `["1-2 months", "3-6 months", "> 6 months"]` + "Other"
  (full mode only)

- Q3 header "Venue" / "目标会议", question: "Target venue for publication?"
  (zh): "目标投稿会议/期刊？"
  options: `["NeurIPS", "ICML", "ICLR", "CVPR"]` + "Other" for custom venue or "No specific venue"

- Q4 header "Work type" / "工作类型", question: "What kind of work is this?"
  (zh): "这是什么类型的研究工作？"
  options:
  - "New research direction from scratch" / "从零探索新方向"
  - "Improvement on existing method" / "改进现有方法"
  - "Diagnostic study / analysis paper" / "诊断性研究 / 分析型论文"

**Batch 2 (full mode: Q5-Q8; quick mode: Q7-Q8 only):**

- Q5 header "Constraints" / "约束", question: "Any project constraints? (e.g., must use PyTorch, must compare against method X)"
  (zh): "项目有什么约束条件？（如：必须使用 PyTorch、必须与方法 X 比较）"
  options: `["No specific constraints"]` + "Other"

- Q6 header "Non-goals" / "非目标", question: "Anything you explicitly do NOT want to work on?"
  (zh): "有什么明确不想做的事情？"
  options: `["None"]` + "Other"

- Q7 header "Primary metric" / "主要指标", question: "What is the primary metric for this project? (e.g., F1, BLEU, perplexity, accuracy)"
  (zh): "项目的主要评估指标是什么？（如：F1、BLEU、perplexity、accuracy）"
  options: `["accuracy", "F1", "BLEU", "perplexity"]` + "Other"

- Q8 header "Metric target" / "目标值", question: "What target value should the primary metric reach? (e.g., 0.85, 25.0). Leave blank if no specific target yet."
  (zh): "主要指标的目标值是多少？（如：0.85、25.0）。如果暂无具体目标可留空。"
  options: `["No specific target yet"]` + "Other"

Record `answers.primary_metric` (Q7) and `answers.metric_target` (Q8, may be empty).
If Q8 has a value, also record `answers.metric_direction` by inferring from the metric name:
`perplexity` → `lower_better`; all others → `higher_better`. If ambiguous, default to `higher_better`.

**After Phase 5:** Save state with `completed_stages: [1,2,3,4,4.5,5]`.

---

## Phase 5.5: Reference Knowledge

Collect reference materials and domain knowledge from the user. This section
is written to CLAUDE.md `## Reference Knowledge` and consumed by
auto-research-loop and research-pipeline to provide context to sub-skills.

**Q1** — header: "参考技能" / "Reference skills", question:
"在研究过程中，是否有需要特别调用的辅助技能？（如通信领域文献搜索 /comm-lit-review、公式推导 /formula-derivation 等。留空则跳过）"
(en): "Any auxiliary skills to invoke during research? (e.g., /comm-lit-review for domain-specific literature, /formula-derivation for theory work. Leave blank to skip)"
options: `["无需额外技能"]` + "Other"

**Q2** — header: "参考文档" / "Reference docs", question:
"有没有需要研究流程参考的文档？（如关键论文 PDF、技术笔记、代码仓库中的文件路径等。请提供路径，每行一个）"
(en): "Any documents for the research flow to reference? (key papers, tech notes, file paths in the repo — one per line)"
options: `["暂无"]` + "Other"

**Q3** — header: "领域知识" / "Domain knowledge", question:
"有什么需要研究流程了解的领域知识或约束？（如硬件限制、指标选择理由、关键假设、先前经验教训等）"
(en): "Any domain knowledge or constraints the research flow should know? (hardware limits, metric rationale, key assumptions, lessons learned)"
options: `["暂无"]` + "Other"

**Exploration.** After receiving Q2 answers, if user provided document paths:
- Read each file's first ~100 lines to extract key information
- Summarize the domain context from the documents
- Present the summary to the user for confirmation/correction

Record `answers.reference_skills[]`, `answers.reference_documents[]`,
`answers.reference_knowledge[]`.

**After Phase 5.5:** Save state with `completed_stages: [1,2,3,4,4.5,5,5.5]`.

---

## Phase 6: Paseo Substrate Config (Skippable)

**Quick mode:** ask nothing. Keep the template's default Paseo block in
CLAUDE.md as written (executor `claude/sonnet-4-6`, reviewer `codex/gpt-5.5`,
heartbeat `off`), set `answers.paseo_configured = false`, append `"paseo"`
to `answers.applied_defaults`, and record
`answers.paseo_defaults = "executor claude/sonnet-4-6, reviewer codex/gpt-5.5, heartbeat off"`.
The values are shown back at the Phase 7.4 checklist; adjusting them there
sets `paseo_configured = true` and overwrites the block in CLAUDE.md.

**Full mode** (or when the user adjusts this item at Phase 7.4):

**Question 0 (gate):**
- **header**: "Paseo"
- **question** (en): "Configure multi-agent orchestration (Paseo)? This enables managed sub-agent dispatch for the research pipeline."
  (zh): "是否配置多智能体编排（Paseo）？这将启用研究流水线的受管子智能体调度。"
- **options**: `["Skip (use defaults)", "Yes, configure"]`

If "Skip": set `answers.paseo_configured = false`, move to Phase 7.

If "Yes", use AskUserQuestion with 3 questions:

- Q1 header "Executor", question: "Executor model for workflow agents?"
  options: `["claude/sonnet-4-6 (default)", "claude/opus-4-6"]` + "Other"

- Q2 header "Reviewer", question: "Cross-model reviewer?"
  options: `["codex/gpt-5.5 (default)", "codex/o3"]` + "Other"

- Q3 header "Heartbeat", question: "Enable overnight heartbeat for autonomous runs?"
  options: `["Off (default)", "Every 13 minutes"]` + "Other"

These variables configure the execution substrate for every orchestrator
(`/research-pipeline` and `/auto-research-loop` alike); neither flow is
nested in the other.

**After Phase 6:** Save state with `completed_stages: [1,2,3,4,4.5,5,5.5,6]`.

---

## Phase 7: Artifact Generation

Generate all configuration files from the collected answers. Execute in order:

### 7a. Ensure directories

```bash
mkdir -p .aris
```

### 7b. Generate CLAUDE.md

Read the template: `$TEMPLATES_DIR/CLAUDE_MD_TEMPLATE.md`

**If `CLAUDE.md` does NOT exist:**
Copy the template and fill in:
- Replace `{project-name}` with `answers.project_name`
- Set `language:` to `answers.language`
- Set `stage: idle`, clear all other Pipeline Status fields
- Fill `## Project Constraints` with `answers.constraints` (or leave placeholder if "No specific constraints")
- Fill `## Non-Goals` with `answers.non_goals` (or leave placeholder if "None")
- Fill `## Compute Budget` with `answers.compute_budget`
- `## Metric Target` — if `answers.metric_target` is set (not empty / not "No specific target yet"),
  uncomment the block and fill in:
  - `primary: <answers.metric_target> <answers.primary_metric>` (e.g., `primary: 0.85 F1`)
  - `direction: <answers.metric_direction>` (e.g., `higher_better`)
  - `baseline: ""` (empty at setup; /auto-research-loop iteration 1 anchors it with the reproduced value)
  - `tolerance: 0.01`
  If no target was specified, leave the section commented.
- `## Experiment Environment` — leave the template's commented blocks as-is.
  Phase 7.5 owns this section via `/experiment-env-manager`.
- In `## Early Stop Configuration`: if `answers.early_stop_enabled == true`, uncomment the block and fill in values from `answers.early_stop`. Otherwise leave it commented.
- If `answers.paseo_configured == true`: append the Paseo section from `$TEMPLATES_DIR/CLAUDE_MD_PASEO_SECTION.md` with values filled in. Otherwise leave the Paseo section with defaults or commented.
- `## Reference Knowledge` — fill `skills:` from `answers.reference_skills`, `documents:` from `answers.reference_documents`, `knowledge:` from `answers.reference_knowledge`. If all empty, leave with empty lists.

**If `CLAUDE.md` DOES exist:**
Merge strategy — preserve all existing content:
1. If `<!-- ARIS:BEGIN -->` block exists, preserve it
2. If `## Pipeline Status` section exists, update the `language:` field only
3. If `## Pipeline Status` does NOT exist, insert the filled Pipeline Status block after the first H1
4. If `## Metric Target` does NOT exist and `answers.metric_target` is set, insert the filled block after `## Compute Budget`
5. If `## Metric Target` exists, leave it unchanged (user may have manually edited)
6. If `## Experiment Environment` section exists, leave it unchanged. If absent,
   insert the template's fully-commented block.
7. If `## Early Stop Configuration` section exists and `answers.early_stop_enabled == true`, update it with the new config
8. If `## Early Stop Configuration` does NOT exist and `answers.early_stop_enabled == true`, insert the filled block
9. Same for `## Project Constraints`, `## Non-Goals`, `## Compute Budget`
10. If `## ARIS Paseo` does NOT exist and `answers.paseo_configured == true`, append it
11. If `## Reference Knowledge` does NOT exist and answers have reference data, insert the filled block after `## Metric Target`
12. If `## Reference Knowledge` exists, leave unchanged (user may have manually edited)

Write the result to `CLAUDE.md`.

### 7c. Generate RESEARCH_BRIEF.md

**If `RESEARCH_BRIEF.md` does NOT exist or is empty:**

Select template based on language:
- `en` → `$TEMPLATES_DIR/RESEARCH_BRIEF_TEMPLATE.md`
- `zh` → `$TEMPLATES_DIR/RESEARCH_BRIEF_TEMPLATE_CN.md`

Read the template and fill in from answers:
- `## Problem Statement` / `## 问题陈述` → `answers.problem_statement`
- `**Field**` / `**领域**` → `answers.field`
- `**Sub-area**` / `**子方向**` → `answers.sub_area`
- `**Key papers I've read**` / `**已读关键论文**` → `answers.key_papers` (or "None yet" / "暂无")
- `**What I already tried**` / `**已尝试的方法**` → `answers.prior_attempts` (or "Nothing yet" / "暂无")
- `**What didn't work**` / `**失败经验**` → `answers.failures` (or "N/A")
- `**Compute**` / `**算力**` → `answers.compute_budget`
- `**Timeline**` / `**时间线**` → `answers.timeline`
- `**Target venue**` / `**目标会议/期刊**` → `answers.target_venue`
- Check the matching work type checkbox
- `## Non-Goals` / `## 非目标` → `answers.non_goals`
- `## Existing Results` / `## 已有结果` → `answers.existing_results` (or "Starting fresh" / "从零开始")

Write to `RESEARCH_BRIEF.md`.

**If `RESEARCH_BRIEF.md` exists and is non-empty:**

Use AskUserQuestion:
- question: "A RESEARCH_BRIEF.md already exists. What would you like to do?"
  (zh): "RESEARCH_BRIEF.md 已存在。你想怎么处理？"
- options: `["Overwrite with new content", "Keep existing"]`

### 7d. Initialize Research Wiki

Resolve `$WIKI_SCRIPT` via the canonical chain:

```bash
# --- resolve research-wiki helper (integration-contract.md §2) ---
WIKI_SCRIPT=".aris/dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || WIKI_SCRIPT="dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || {
  echo "ERROR: research-wiki.js is required for setup. Run /aris-update or build the ARIS runtime." >&2
  exit 1
}
```

**If `research-wiki/` does NOT exist or is empty:**

```bash
node "$WIKI_SCRIPT" init research-wiki/ || {
  echo "ERROR: research-wiki.js failed to initialize the project Wiki." >&2
  exit 1
}
```

**Root problem entity.** If `answers.metric_target` is set — same condition as
the `## Metric Target` block above: non-empty and not `"No specific target
yet"` — and `research-wiki/problems/` contains no problem yet, create the
project's root open problem (the baseline->target distance).

`answers` is the setup state object, not a shell variable. Substitute the
recorded values into the command below before running it; `$answers.field` in
bash would expand to the empty string plus the literal text `.field`:

```bash
if [ ! -f research-wiki/problems/root.md ]; then
  node "$WIKI_SCRIPT" add_problem research-wiki/ \
    --slug "root" \
    --title "close <answers.primary_metric> gap: baseline -> <answers.metric_target>" \
    --severity high \
    --statement "Reach <answers.metric_target> <answers.primary_metric> (<answers.metric_direction>) from the reproduced baseline. /auto-research-loop iteration 1 reproduces the baseline method; subsequent iterations address sub-problems of this problem." \
    --origin "root problem created by /research-setup from the Metric Target" || {
      echo "ERROR: research-wiki.js failed to create the root problem." >&2
      exit 1
    }
fi
```

Without a metric target there is no root problem: `/auto-research-loop` refuses
to start without an active `## Metric Target` anyway, and a root problem whose
closing condition is unstated could never be closed.

**If key papers were provided as arXiv IDs** (detected by `\d{4}\.\d{4,5}` pattern):

```bash
if [ -n "$ARXIV_IDS" ]; then
  node "$WIKI_SCRIPT" sync research-wiki/ --arxiv-ids "$ARXIV_IDS" || {
    echo "ERROR: research-wiki.js failed to sync the key papers the user supplied." >&2
    exit 1
  }
fi
```

**If `research-wiki/` already exists with papers/:** Skip init (idempotent).

### 7e. Update .gitignore

Read `$TEMPLATES_DIR/gitignore-trace.txt` if it exists.

If `.gitignore` does not exist, create it with the ARIS entries.

If `.gitignore` exists, check if `.aris/traces/` is already listed.
If not, append the ARIS entries at the end with a header comment:

```
# ARIS traces and runtime state
.aris/traces/
.aris/setup-state.json
```

### Phase 7.4: Configuration Review Checklist

Before dispatching the env-manager sub-agent, show the user the complete
configuration and offer a one-round-trip adjustment. This is the confirmation
point for every quick-mode default and a last look at the user's own answers.
It runs in **both** modes - the checklist is the single review surface.

Print a checklist table in the detected language:

```
(zh)
配置清单（带 * 的项为默认值，可直接调整）：

| 配置项               | 取值                              | 来源        |
| -------------------- | --------------------------------- | ----------- |
| 算力预算             | 100-500 GPU-hours *               | 默认值      |
| 时间线               | 3-6 months *                      | 默认值      |
| 提前停止             | 关闭（手动监控）*                 | 默认值      |
| Paseo executor       | claude/sonnet-4-6 *               | 默认值      |
| Paseo reviewer       | codex/gpt-5.5 *                   | 默认值      |
| Paseo heartbeat      | off *                             | 默认值      |
| 项目名 / 领域 / 指标 / 目标会议 / 约束 / ... | <实际值>      | 你填写      |

(en)
Configuration checklist (items marked * are defaults; adjust if needed):

| Item                                          | Value                            | Source      |
| --------------------------------------------- | -------------------------------- | ----------- |
| Compute budget                                | 100-500 GPU-hours *              | default     |
| Timeline                                      | 3-6 months *                     | default     |
| Early stop                                    | disabled (manual monitoring) *   | default     |
| Paseo executor                                | claude/sonnet-4-6 *              | default     |
| Paseo reviewer                                | codex/gpt-5.5 *                  | default     |
| Paseo heartbeat                               | off *                            | default     |
| Project name / field / metric / venue / ...   | <actual value>                   | your answer |
```

Rows whose key is in `answers.applied_defaults` show as defaults; all other
collected answers (project name, field, sub-area, primary metric, metric
target, venue, work type, constraints, non-goals, reference knowledge)
show with their values.

Then one AskUserQuestion:

- **header**: "Review" / "配置确认"
- **question** (en): "This configuration will be written into CLAUDE.md / RESEARCH_BRIEF.md. Confirm, or adjust an item?"
  (zh): "以上配置将写入 CLAUDE.md / RESEARCH_BRIEF.md。确认，还是调整某项？"
- **options**:
  - "Confirm all (Recommended)" / "全部确认（推荐）"
  - "Adjust budget / timeline" / "调整预算 / 时间线"
  - "Adjust early stop" / "调整提前停止"
  - "Adjust Paseo config" / "调整 Paseo 配置"

If "Confirm all": record `answers.review_confirmed = true`, save state with
`completed_stages` including `7.4`, move to Phase 7.5.

If an adjust option is chosen (or the user types a specific item via "Other"):

1. Re-ask the original questions for that item only, using the question
   definitions from the owning phase (budget/timeline: Phase 5 Q1/Q2;
   early stop: Phase 4.5; Paseo: Phase 6 Q1-Q3). These re-asks run
   regardless of mode - quick mode only suppresses the initial ask.
2. Update `answers`, and remove the item's key from `answers.applied_defaults`.
3. Patch the already-generated artifacts directly (do not regenerate from
   scratch):
   - budget -> `## Compute Budget` in CLAUDE.md and `**Compute**` in RESEARCH_BRIEF.md
   - timeline -> `**Timeline**` in RESEARCH_BRIEF.md
   - early stop -> `## Early Stop Configuration` in CLAUDE.md (uncomment and
     fill, same rules as 7b)
   - Paseo -> overwrite the values in the `## ARIS Paseo` yaml block in
     CLAUDE.md, set `answers.paseo_configured = true`
4. Re-print the checklist and ask the review question again. Loop until the
   user confirms. The user may also adjust non-defaulted items this way -
   patch the corresponding CLAUDE.md / RESEARCH_BRIEF.md fields the same way.

Placed after artifact generation (7b-7e) and before the Phase 7.5 env-manager
dispatch so adjustments are baked in before the slow delegation starts.

### Phase 7.5: Experiment Environment Configuration (delegated)

After CLAUDE.md exists, dispatch `/experiment-env-manager` as a **paseo
sub-agent** (Rule 1: One Agent = One Skill; Rule 4: Paseo MCP Only).
env-manager is the sole entry point — it handles PRD generation,
env-configuration dispatch, and env-audit validation internally.

Derive the project slug for dispatch and readback using the same algorithm
as env-manager:
```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PROJECT_SLUG=$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-//; s/-$//')
SKILL_DIR=".claude/skills/run-${PROJECT_SLUG}-experiment"
```

```
mcp__paseo__create_agent
  title:    "env-manager: setup $PROJECT_SLUG"
  provider: claude
  initialPrompt: "/experiment-env-manager — project: $PROJECT_SLUG — mode: setup"
  notifyOnFinish: true
```

The sub-agent handles all user interaction (AskUserQuestion) via paseo's
permission forwarding — the user sees the questions in their terminal/app
as normal. Wait for `notifyOnFinish`, then `mcp__paseo__archive_agent`.

After it completes, transcribe results (do NOT judge them):

1. `SKILL_DIR` is already set above using `PROJECT_SLUG`.
2. Read environment type from the generated skill:
   `sh "$SKILL_DIR/scripts/ops/env-info.sh" 2>/dev/null | jq -r '.backend_hint // "none"'`
   → set `answers.gpu_type` to the result.
3. Read `$SKILL_DIR/env.json` → set
   `answers.experiment_skill = "run-${PROJECT_SLUG}-experiment"` and
   `answers.env_config_status` to the `status` field.

   Valid statuses in env.json: `complete` (audit passed or user override),
   `pending_audit` (env-manager did not finish or was interrupted).
   Note: env.json is deleted (not set to `failed`) when configuration fails —
   check for file existence first.

If configuration did not succeed (env.json is missing or status is not
`complete`), stop setup with the environment-manager failure receipt. Do not
write a successful setup state that points downstream skills at an incomplete
experiment environment.

### Phase 7.6: Baseline Info -> RESEARCH_BRIEF (no reproduction)

Setup does NOT reproduce the baseline - `/auto-research-loop` iteration 1 does,
through the normal pipeline (idea-discovery materializes the baseline idea from
the brief, experiment-bridge runs it, auto-review-loop + /result-to-claim absorb
it). Setup's only job here is to carry the baseline info into the brief so
iteration 1 has everything it needs.

**Trigger condition:** Phase 3 prior-work answers contain a describable baseline
(`answers.prior_attempts` or `answers.existing_results` is not "Nothing yet" /
"Starting fresh" and not empty). Otherwise skip silently - a from-scratch
project has no baseline to reproduce.

Append (or replace, if already present) this section to `RESEARCH_BRIEF.md`:

```markdown
## Baseline Reproduction (first experiment)

The first experiment MUST reproduce this baseline before exploring improvements.

**Method**: <answers.prior_attempts - the existing method to reproduce>
**Code / run location**: <repo path or run entry point; the generated
run-<project>-experiment skill (Phase 7.5) when env config completed>
**Expected metric**: <from answers.existing_results, or blank>
**Tolerance**: <from CLAUDE.md ## Metric Target>
```

Fill each field from the answers; leave a field out when the user gave nothing
for it. `answers.env_config_status == "complete"` adds the generated experiment
skill name to Code / run location; otherwise that field just names the repo
path. Do not dispatch any agent in this phase.

### 7g. Write final setup state

```json
{
  "version": 1,
  "completed": true,
  "completed_stages": [1, 2, 3, 4, 4.5, 5, 5.5, 6, 7.4, 7.5, 7.6],
  "answers": { ... },
  "artifacts": [
    "CLAUDE.md",
    "RESEARCH_BRIEF.md (with Baseline Reproduction section when prior work was provided)",
    "research-wiki/ (with the root problem when a Metric Target is set)",
    ".gitignore",
    ".claude/skills/ (ARIS skills)",
    ".claude/skills/run-<project>-experiment/ (when env config status = complete)"
  ],
  "timestamp": "<ISO 8601>"
}
```

Write to `.aris/setup-state.json`.

---

## Phase 8: Summary & Next Steps

Print a summary of what was created. If `answers.applied_defaults` is
non-empty, first restate those items in one line so the user sees the
defaults one last time, e.g. `(zh) 默认配置：预算 100-500 GPU-hours、时间线 3-6 months、提前停止关闭、Paseo sonnet-4-6/gpt-5.5/heartbeat off（已在配置清单确认）` /
`(en) Defaults applied: budget 100-500 GPU-hours, timeline 3-6 months, early stop off, Paseo sonnet-4-6/gpt-5.5/heartbeat off (confirmed in the review checklist)`.
Adjust the line to match what the user actually changed or confirmed.

```
(en)
✅ Research project "{project_name}" initialized successfully.

Created:
  • CLAUDE.md — project dashboard (language: {language}, Environment: {answers.gpu_type} (configured by /experiment-env-manager) or "not configured")
  • RESEARCH_BRIEF.md — research direction brief
  • research-wiki/ — knowledge base (5 subdirs, 5 seed files)
  • .gitignore — updated with ARIS entries
  • .claude/skills/ — ARIS skills installed

(zh)
✅ 研究项目「{project_name}」初始化成功。

已创建：
  • CLAUDE.md — 项目仪表盘（语言：{language}，环境：{answers.gpu_type}（由 /experiment-env-manager 配置）或「未配置」）
  • RESEARCH_BRIEF.md — 研究方向简报
  • research-wiki/ — 知识库（5 个子目录，5 个种子文件）
  • .gitignore — 已添加 ARIS 条目
  • .claude/skills/ — ARIS skills installed
```

Then suggest next steps based on work type:

**If "New research direction":**
```
Suggested next steps:
  /idea-discovery "{sub_area} {problem_statement_summary}"
  /research-pipeline "{sub_area}"   (full end-to-end pipeline)
```

**If "Improvement on existing method":**
```
Suggested next steps:
  /research-refine "PROBLEM: {problem_statement} | APPROACH: {sub_area}"
  /experiment-plan "{sub_area}"
  /auto-research-loop  (when a ## Metric Target is set; iteration 1 reproduces the baseline from RESEARCH_BRIEF)
```

**If "Diagnostic study":**
```
Suggested next steps:
  /research-lit "{sub_area} {problem_statement_summary}"
  /experiment-plan "{sub_area}"
```

---

## Key Rules

1. **All questions via AskUserQuestion.** Every question — open-ended and closed-ended — uses
   the `AskUserQuestion` tool. Open-ended questions provide an example option plus "Other" for
   free-text input. Max 4 questions per AskUserQuestion call.

2. **Skippable stages are asked; defaulted stages are reviewed.** Phase 3 is
   skippable but always presented - include a "Skip this stage" option, never
   silently skip. In quick mode (the default), Phase 4.5 and Phase 6 ask
   nothing and Phase 5 skips budget/timeline: the quick-mode defaults apply and
   every one of them is shown in the Phase 7.4 checklist with a one-click
   adjust option. `- mode: full` restores the fully interactive wizard.

3. **State persistence.** Write `.aris/setup-state.json` after every completed stage. On resume,
   skip completed stages and pre-populate answers.

4. **Merge, don't overwrite.** If `CLAUDE.md` exists, preserve content and merge new sections.
   Ask before overwriting `RESEARCH_BRIEF.md`.

5. **Bilingual.** Question text, section headings, and status messages follow the detected
   language. File paths, JSON keys, YAML fields, and code remain English.

6. **Template required.** Templates are resolved from `$TEMPLATES_DIR`. If templates cannot be
   found, emit an error and exit — do not generate config from memory.

7. **Wiki helper required.** If `research-wiki.js` cannot be resolved or an operation fails,
   stop setup and write a failed receipt. Do not create Wiki files by hand.

8. **Environment configuration goes exclusively through `/experiment-env-manager`.**
   This skill never asks about backend types, never writes `## Experiment Environment`
   field values, and never reads `.aris/experiment-env.json` directly. The delegation
   happens in Phase 7.5, which dispatches `/experiment-env-manager` as the sole
   entry point for environment lifecycle.
