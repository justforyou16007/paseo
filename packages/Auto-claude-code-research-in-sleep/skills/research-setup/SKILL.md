---
name: research-setup
description: 'Interactive Q&A setup wizard for new ARIS research projects. Bootstraps CLAUDE.md, RESEARCH_BRIEF.md, research-wiki, and experiment environment from user answers. Resumable, bilingual (en/zh), smart defaults. Use when user says "研究项目初始化", "setup project", "初始化研究项目", "research setup", "new project", "配置项目", or wants to configure a new ARIS research workspace.'
argument-hint: "[project-name] [— language: en|zh]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, AskUserQuestion
---

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
Phase 4  Compute environment (GPU setup)
Phase 5  Research goals (budget, timeline, venue, constraints)
Phase 6  Paseo substrate config (multi-agent orchestration)     [skippable]
Phase 7  Artifact generation (CLAUDE.md, RESEARCH_BRIEF.md, research-wiki, .gitignore)
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
- **TEMPLATES_DIR** — resolved via: `$CLAUDE_SKILL_DIR/../../templates/` (layer 0),
  then `$ARIS_REPO/templates/` (layer 3). Gate: if both fail, error and exit —
  templates are required.

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
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1

# Resolve ARIS repo
if [ -z "${ARIS_REPO:-}" ] && [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi

# Resolve templates directory
TEMPLATES_DIR=""
if [ -n "${CLAUDE_SKILL_DIR:-}" ]; then
  _ARIS_ROOT="${CLAUDE_SKILL_DIR%/skills/*}"
  [ -d "$_ARIS_ROOT/templates" ] && TEMPLATES_DIR="$_ARIS_ROOT/templates"
fi
[ -z "$TEMPLATES_DIR" ] && [ -n "${ARIS_REPO:-}" ] && [ -d "$ARIS_REPO/templates" ] && TEMPLATES_DIR="$ARIS_REPO/templates"
[ -z "$TEMPLATES_DIR" ] && {
  echo "ERROR: ARIS templates directory not found. Ensure ARIS is installed (install_aris.sh) or set ARIS_REPO." >&2
  exit 1
}
```

### 0b. Check ARIS installation

If `.aris/installed-skills.txt` does NOT exist, ARIS skills are not installed.
Resolve `install_aris.sh`:

```bash
INSTALLER=""
[ -n "${ARIS_REPO:-}" ] && [ -f "$ARIS_REPO/tools/install_aris.sh" ] && INSTALLER="$ARIS_REPO/tools/install_aris.sh"
[ -z "$INSTALLER" ] && [ -n "${CLAUDE_SKILL_DIR:-}" ] && {
  _ROOT="${CLAUDE_SKILL_DIR%/skills/*}"
  [ -f "$_ROOT/tools/install_aris.sh" ] && INSTALLER="$_ROOT/tools/install_aris.sh"
}
```

If the installer is found, ask the user:

> ARIS skills are not installed in this project. Run install_aris.sh now?

If yes, run: `bash "$INSTALLER" "$(pwd)"`

If the installer is NOT found, warn but continue — the setup can still generate
config files, they just won't be symlinked into `.claude/skills/`.

### 0c. Resume detection

Read `.aris/setup-state.json`. If it exists and `completed` is `false`:

Use AskUserQuestion:
- **header**: "Setup"
- **question** (en): "A partial setup was found (completed stages: N). Resume from where you left off?"
  (zh): "检测到未完成的设置（已完成阶段：N）。从上次中断处继续？"
- **options**: "Resume" / "Start fresh"

If "Resume": skip completed stages, pre-populate answers from state.
If "Start fresh": delete state file, start from Phase 1.

### 0d. Detect existing artifacts

Check for:
- `CLAUDE.md` — if exists, will merge (not overwrite)
- `RESEARCH_BRIEF.md` — if exists and non-empty, will ask before overwriting
- `research-wiki/` — if exists with content, skip wiki init

### 0e. Detect language

Parse `$ARGUMENTS` for `— language: zh` or `— language: en`.
If not specified, detect from user's message language.
Store as `answers.language`.

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
  Default to detected language from Phase 0e.

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

## Phase 4: Compute Environment

### Batch 1: GPU type selection

**Question:**
- **header**: "GPU" / "算力"
- **question** (en): "What GPU setup will you use for experiments?"
  (zh): "你将使用什么 GPU 环境来运行实验？"
- **options**:
  - `"Remote server (SSH)"` — description: "Pre-configured machine you SSH into"
  - `"Vast.ai"` — description: "On-demand GPU rental"
  - `"Modal"` — description: "Serverless GPU, auto scale-to-zero"
  - `"Local GPU"` — description: "GPU on this machine"

(The user can select "Other" to type e.g. "No GPU / decide later")

If "Other" contains "no gpu", "none", "later", "decide later", "没有", "暂不配置":
set `answers.gpu_type = "none"`, skip Batch 2, move to Phase 5.

### Batch 2: Type-specific follow-ups

**If Remote:**
Use AskUserQuestion with up to 4 questions:

- Q1 header "SSH", question: "SSH alias or hostname for your GPU server?"
  options: free text ("Other")
- Q2 header "Conda", question: "Conda environment name? (default: research)"
  options: `["research (default)"]` + "Other"
- Q3 header "Code dir", question: "Remote code directory? (default: ~/experiments/)"
  options: `["~/experiments/ (default)"]` + "Other"
- Q4 header "WandB", question: "Use Weights & Biases for experiment tracking?"
  options: `["No", "Yes"]`

If WandB = "Yes", ask one more AskUserQuestion:
- Q5 header "WandB", question: "WandB project name?"
  options: `["<project-name> (default)"]` + "Other"

**If Vast.ai:**
Use AskUserQuestion with 2 questions:

- Q1 header "Budget", question: "Max budget per session in USD? (default: $5.00)"
  options: `["$5.00 (default)", "$10.00", "$20.00"]` + "Other"
- Q2 header "Image", question: "Docker image? (default: pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel)"
  options: `["pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel (default)"]` + "Other"

**If Modal:**
Use AskUserQuestion with 2 questions:

- Q1 header "GPU Type", question: "Modal GPU type? (default: A100-80GB)"
  options: `["A100-80GB (default)", "A100-40GB", "H100", "T4"]` + "Other"
- Q2 header "Timeout", question: "Job timeout in hours? (default: 6)"
  options: `["6 hours (default)", "12 hours", "24 hours"]` + "Other"

**If Local:**
Use AskUserQuestion with 2 questions:

- Q1 header "Conda", question: "Conda environment name? (default: ml)"
  options: `["ml (default)"]` + "Other"
- Q2 header "Device", question: "Compute device?"
  options: `["CUDA (auto-detect)", "MPS (Apple Silicon)"]` + "Other"

**After Phase 4:** Save state with `completed_stages: [1,2,3,4]`.

---

## Phase 5: Research Goals

Use AskUserQuestion with up to 4 questions (max 4 per batch):

**Batch 1 (4 questions):**

- Q1 header "Budget" / "预算", question: "Compute budget for this project?"
  (zh): "项目的算力预算？"
  options: `["< 100 GPU-hours", "100-500 GPU-hours", "> 500 GPU-hours"]` + "Other" for specific text

- Q2 header "Timeline" / "时间线", question: "Timeline for this project?"
  (zh): "项目的时间线？"
  options: `["1-2 months", "3-6 months", "> 6 months"]` + "Other"

- Q3 header "Venue" / "目标会议", question: "Target venue for publication?"
  (zh): "目标投稿会议/期刊？"
  options: `["NeurIPS", "ICML", "ICLR", "CVPR"]` + "Other" for custom venue or "No specific venue"

- Q4 header "Work type" / "工作类型", question: "What kind of work is this?"
  (zh): "这是什么类型的研究工作？"
  options:
  - "New research direction from scratch" / "从零探索新方向"
  - "Improvement on existing method" / "改进现有方法"
  - "Diagnostic study / analysis paper" / "诊断性研究 / 分析型论文"

**Batch 2 (2 questions):**

- Q5 header "Constraints" / "约束", question: "Any project constraints? (e.g., must use PyTorch, must compare against method X)"
  (zh): "项目有什么约束条件？（如：必须使用 PyTorch、必须与方法 X 比较）"
  options: `["No specific constraints"]` + "Other"

- Q6 header "Non-goals" / "非目标", question: "Anything you explicitly do NOT want to work on?"
  (zh): "有什么明确不想做的事情？"
  options: `["None"]` + "Other"

**After Phase 5:** Save state with `completed_stages: [1,2,3,4,5]`.

---

## Phase 6: Paseo Substrate Config (Skippable)

**Question 0 (gate):**
- **header**: "Paseo"
- **question** (en): "Configure multi-agent orchestration (Paseo)? This enables parallel sub-agent dispatch for the research pipeline."
  (zh): "是否配置多智能体编排（Paseo）？这将启用研究流水线的并行子智能体调度。"
- **options**: `["Skip (use defaults)", "Yes, configure"]`

If "Skip": set `answers.paseo_configured = false`, move to Phase 7.

If "Yes", use AskUserQuestion with 3 questions:

- Q1 header "Executor", question: "Executor model for workflow agents?"
  options: `["claude/sonnet-4-6 (default)", "claude/opus-4-6"]` + "Other"

- Q2 header "Reviewer", question: "Cross-model reviewer?"
  options: `["codex/gpt-5.5 (default)", "codex/o3"]` + "Other"

- Q3 header "Heartbeat", question: "Enable overnight heartbeat for autonomous runs?"
  options: `["Off (default)", "Every 13 minutes"]` + "Other"

**After Phase 6:** Save state with `completed_stages: [1,2,3,4,5,6]`.

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
- In `## Experiment Environment`: uncomment the block matching `answers.gpu_type` and fill in the fields from answers. Leave other blocks commented.
- If `answers.paseo_configured == true`: append the Paseo section from `$TEMPLATES_DIR/CLAUDE_MD_PASEO_SECTION.md` with values filled in. Otherwise leave the Paseo section with defaults or commented.

**If `CLAUDE.md` DOES exist:**
Merge strategy — preserve all existing content:
1. If `<!-- ARIS:BEGIN -->` block exists, preserve it
2. If `## Pipeline Status` section exists, update the `language:` field only
3. If `## Pipeline Status` does NOT exist, insert the filled Pipeline Status block after the first H1
4. If `## Experiment Environment` section exists, update it with the new config
5. If `## Experiment Environment` does NOT exist, insert the filled block
6. Same for `## Project Constraints`, `## Non-Goals`, `## Compute Budget`
7. If `## ARIS Paseo` does NOT exist and `answers.paseo_configured == true`, append it

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
# --- resolve research-wiki helper ---
WIKI_SCRIPT=""
if [ -z "${ARIS_REPO:-}" ] && [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi
WIKI_SCRIPT=".aris/dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || WIKI_SCRIPT="dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || { [ -n "${ARIS_REPO:-}" ] && WIKI_SCRIPT="$ARIS_REPO/dist/tools/research-wiki.js"; }
[ -f "$WIKI_SCRIPT" ] || WIKI_SCRIPT=""
```

**If `research-wiki/` does NOT exist or is empty:**

```bash
if [ -n "$WIKI_SCRIPT" ]; then
  node "$WIKI_SCRIPT" init research-wiki/
else
  # Fallback: create structure manually
  mkdir -p research-wiki/{papers,ideas,experiments,claims,graph}
  echo "# Research Wiki Index\n\n_Auto-generated. Do not edit._" > research-wiki/index.md
  echo "# Research Wiki Log\n\n_Append-only timeline._" > research-wiki/log.md
  echo "# Gap Map\n\n_Field gaps with stable IDs._" > research-wiki/gap_map.md
  echo "# Query Pack\n\n_Auto-generated for /idea-creator. Max 8000 chars._" > research-wiki/query_pack.md
  touch research-wiki/graph/edges.jsonl
fi
```

**If key papers were provided as arXiv IDs** (detected by `\d{4}\.\d{4,5}` pattern):

```bash
if [ -n "$WIKI_SCRIPT" ] && [ -n "$ARXIV_IDS" ]; then
  node "$WIKI_SCRIPT" sync research-wiki/ --arxiv-ids "$ARXIV_IDS"
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

### 7f. Write final setup state

```json
{
  "version": 1,
  "completed": true,
  "completed_stages": [1, 2, 3, 4, 5, 6],
  "answers": { ... },
  "artifacts": [
    "CLAUDE.md",
    "RESEARCH_BRIEF.md",
    "research-wiki/",
    ".gitignore"
  ],
  "timestamp": "<ISO 8601>"
}
```

Write to `.aris/setup-state.json`.

---

## Phase 8: Summary & Next Steps

Print a summary of what was created:

```
(en)
✅ Research project "{project_name}" initialized successfully.

Created:
  • CLAUDE.md — project dashboard (language: {language}, GPU: {gpu_type})
  • RESEARCH_BRIEF.md — research direction brief
  • research-wiki/ — knowledge base (5 subdirs, 5 seed files)
  • .gitignore — updated with ARIS entries

(zh)
✅ 研究项目「{project_name}」初始化成功。

已创建：
  • CLAUDE.md — 项目仪表盘（语言：{language}，GPU：{gpu_type}）
  • RESEARCH_BRIEF.md — 研究方向简报
  • research-wiki/ — 知识库（5 个子目录，5 个种子文件）
  • .gitignore — 已添加 ARIS 条目

⚠️ If ARIS skills were installed or updated during this setup, they won't
   appear until you reload. Run `/reload-skills` or start a new Claude Code session.

   如果此次设置安装或更新了 ARIS 技能，需要重新加载才能使用。
   请运行 `/reload-skills` 或启动新的 Claude Code 会话。
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

2. **All stages shown by default.** Phase 3 and Phase 6 are skippable but always presented —
   include a "Skip this stage" option, never silently skip.

3. **State persistence.** Write `.aris/setup-state.json` after every completed stage. On resume,
   skip completed stages and pre-populate answers.

4. **Merge, don't overwrite.** If `CLAUDE.md` exists, preserve content and merge new sections.
   Ask before overwriting `RESEARCH_BRIEF.md`.

5. **Bilingual.** Question text, section headings, and status messages follow the detected
   language. File paths, JSON keys, YAML fields, and code remain English.

6. **Template required.** Templates are resolved from `$TEMPLATES_DIR`. If templates cannot be
   found, emit an error and exit — do not generate config from memory.

7. **Wiki helper optional.** If `research-wiki.js` cannot be resolved, fall back to manual
   directory creation. Never block on a missing helper for an optional artifact.
