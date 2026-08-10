---
name: experiment-env-configuration
description: 'Interactively configure a project''s experiment environment ONCE, then freeze the whole prepare → run → feedback loop into a reusable project-local skill at `.claude/skills/run-<project>-experiment/`. Covers experiment-file placement (local/remote), dependency environment, the run command/CLI, and the three feedback channels (error, result, analysis). The frozen configuration is cross-model audited by /experiment-audit before the skill is created. Every step becomes a script or CLI so the second and later runs are fully automatic with no re-configuration. Use when user says "configure experiment environment", "实验环境配置", "set up how experiments run", or when a baseline reproduction finishes and the flow must be made replayable.'
argument-hint: "[— project: <name>] [— reconfigure] [— reviewer: codex|oracle-pro|manual]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, AskUserQuestion, WebSearch, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__wait_for_agent, mcp__paseo__archive_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission
---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in
> [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill;
> Rule 4: Paseo MCP Only, Strict). The Phase 5.5 audit is dispatched via
> `mcp__paseo__create_agent` — not the host `Skill` / `Agent` / `Task` tools.

> **Gate provenance** (`shared-references/acceptance-gate.md` step 5).
> This skill has one STOP gate: *may the project-local experiment skill be created?*
> It is **compound and therefore split, not averaged**:
> - **Type-A** (self-checkable, Phase 5 + Phase 5.5a): the bundle is syntactically
>   valid, `env.json` is complete, all four scripts dry-run clean, the audit **was
>   invoked**, and `ENV_CONFIG_AUDIT.json` exists and parses.
> - **Type-B** (**never self-judged**, Phase 5.5b): *is this frozen configuration
>   trustworthy — will it actually reproduce the run it claims to freeze?* This
>   verdict is produced by `/experiment-env-audit` (which dispatches `/experiment-audit` on a different model family) and is
>   **read verbatim**. This skill never forms its own opinion of it.
>
> Removing the cross-model reviewer must not leave this skill able to decide it
> may create the skill. It cannot: Phase 6 promotion keys off
> `ENV_CONFIG_AUDIT.json.overall_verdict`, and a missing file is a hard stop.

# Experiment Environment Configuration

Configure the experiment environment for: **$ARGUMENTS**

## Purpose

A research project runs the *same* experiment loop dozens of times: put the code
somewhere runnable, activate the right dependency environment, launch, then read
back errors / metrics / analysis. Today that knowledge lives in one agent's head
and is re-derived every round.

This skill runs the configuration **once**, interactively, and writes the answer
down as an executable project-local skill. After it completes, every later
stage (`/experiment-bridge`, `/run-experiment`, `/auto-research-loop`) invokes
the generated skill instead of re-asking anything.

```
Phase 0    Pre-flight: resolve roots, detect existing config
Phase 0.5  User describes environment CLI → index lookup for reuse
Phase 1    Experiment preparation — files (where the code must live, how it gets there)
Phase 2    Experiment preparation — environment (which dependency env, how it is verified)
Phase 3    Run — the single command/CLI that executes an experiment
Phase 3.5  Establish runnable baseline (mock if no evidence exists)
Phase 4    Feedback — error channel, result channel, analysis channel
Phase 4.5  Transport config — write .aris/experiment-env.json (internal) + CLAUDE.md env block
Phase 5    Emit the project-local skill bundle (SKILL.md + scripts/ + env.json) — DRAFT only
Phase 5.5  Trustworthiness audit (DRIVE/ACQUIT gate, cross-model, /experiment-audit)
Phase 6    Promote: verify dry-runs + audit verdict → finalize status, print summary
Phase 6.5  Save exploration to references/index.md for future reuse
```

**What gets written (all inside the PROJECT, never the ARIS repo):**

| # | Path | Contents |
|---|------|----------|
| 1 | `.claude/skills/run-<project>-experiment/SKILL.md` | The replayable prepare→run→feedback procedure |
| 2 | `.claude/skills/run-<project>-experiment/scripts/prepare.sh` | Sync code + verify dependency env |
| 3 | `.claude/skills/run-<project>-experiment/scripts/run.sh` | Launch one experiment (takes a run-spec) |
| 4 | `.claude/skills/run-<project>-experiment/scripts/collect.sh` | Pull back logs + results |
| 5 | `.claude/skills/run-<project>-experiment/scripts/analyze.sh` | Produce the analysis artifact |
| 6 | `.claude/skills/run-<project>-experiment/env.json` | Frozen answers (the config of record) |
| 6.1 | `.claude/skills/run-<project>-experiment/scripts/monitor.sh` | Poll running job status: returns JSON with status/GPU/logs/W&B |
| 6.2 | `.claude/skills/run-<project>-experiment/scripts/info.sh` | Dump environment metadata: hardware, error patterns, W&B, connection |
| 6.3 | `.claude/skills/run-<project>-experiment/scripts/teardown.sh` | Release environment resources (destroy instances, stop containers) |
| 6.4 | `.claude/skills/run-<project>-experiment/handles/` | Per-experiment handle JSON files (replaces /tmp/handle.json) |
| 7 | `.aris/env-config/<project>/ENV_CONFIG_AUDIT.md` | Cross-model audit report (Phase 5.5) |
| 8 | `.aris/env-config/<project>/ENV_CONFIG_AUDIT.json` | Machine-readable verdict — the gate reads this |

Rows 1–6.4 are written to a **staging directory first** and only moved into
`.claude/skills/` after the Phase 5.5 audit returns a passing verdict. Nothing
becomes an invocable skill on the strength of this skill's own say-so.

> **This skill does NOT modify the ARIS repo.** Earlier versions of this flow
> (`add-compute-backend`) scaffolded a TypeScript `EnvBackend` subclass into
> `src/tools/experiment-env/`. That coupled every project's environment to an
> ARIS source edit + rebuild. The environment is project data, not ARIS code —
> it belongs in the project directory. The existing `EnvBackend` backends
> (`local`, `remote`, `vast`, `modal`, `docker`) are still used as the transport
> when one of them fits; anything they do not cover is expressed as a script in
> the generated skill.

---

## Phase 0: Pre-flight

1. **Resolve project root.**
   ```bash
   ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
   cd "$ROOT" || exit 1
   ```

2. **Derive the project slug.** `basename "$ROOT"`, lowercased, non-alphanumerics
   collapsed to `-`. This becomes `<project>` in `run-<project>-experiment`.
   Validate against `/^[a-z0-9][a-z0-9-]*$/`; if it fails, fall back to `project`.

3. **Idempotency check.** Compute `SKILL_DIR=".claude/skills/run-<project>-experiment"`
   and `STAGING_DIR=".aris/env-config/<project>/draft"`.

   | State | Action |
   |---|---|
   | `$SKILL_DIR/SKILL.md` exists AND `$ARGUMENTS` has no `— reconfigure` | Read `$SKILL_DIR/env.json`, run **Phase 6 verification only**, report `status: already_configured`, and STOP. |
   | `$SKILL_DIR/SKILL.md` exists AND `— reconfigure` given | Back up to `$SKILL_DIR.bak-<UTC timestamp>/`, then run all phases (fresh staging). |
   | absent | Run all phases. |

   This is what makes the second and later experiment rounds free of
   configuration: the skill short-circuits unless explicitly asked to redo.

4. **Harvest existing answers** — these seed the Phase 1–4 questions as
   pre-filled first options so the user usually just presses enter:
   - `CLAUDE.md` `## Remote Server` / `## Experiment Environment` blocks
   - `.aris/experiment-env.json` (written by `/run-experiment` Step 1)
   - `.aris/setup-state.json` (`gpu_type`, `conda_env`, answers from `/research-setup`)
   - The most recent `refine-logs/EXPERIMENT_TRACKER.md` rows — the commands that
     actually worked during baseline reproduction are the best possible default.

5. **Parse reviewer override.** If `$ARGUMENTS` contains `— reviewer: <backend>`,
   set `REVIEWER_BACKEND = <backend>` (valid: `codex`, `oracle-pro`, `manual`).
   Otherwise default to `codex`. This is passed through to `/experiment-audit`.

---

## Phase 0.5: User Describes Environment CLI → Index Lookup

Before diving into structured questions, ask the user to describe their
environment workflow in their own words. This provides the seed for all
subsequent phases.

**Q1** — header: "环境描述", question:
"请描述你通常如何在命令行中使用实验环境（包括连接方式、代码部署、运行实验、获取结果的完整流程）。例如：
- 'ssh gpu-server, conda activate ml, cd ~/project, python train.py --lr 1e-4, scp results back'
- 'docker run --gpus all -v ./:/workspace my-image python train.py'
- 'modal run launcher.py'
请尽量具体，包括实际使用的命令："

Free text answer. Parse the description to extract: connection method, dependency
type, transfer method, run command pattern, result location.

**Index lookup.** Check `$REF_DIR/index.md` for a matching previously-explored
environment:

1. Extract key traits from the user's description: connection method
   (SSH/docker/modal/local), dependency type (conda/venv/container/system),
   transfer method (rsync/git/shared/cli-upload).
2. Match against the Entries table in `index.md` by Location + Dependency.
3. **If a match exists**: read the corresponding `<project>-env.md` reference.

   `AskUserQuestion`:
   - header: "复用配置"
   - question: "发现与你描述的环境类似的已有配置：\n<summary from reference>\n\n是否复用此配置？"
   - options:
     - `"直接复用"` — copy the reference's configuration, skip Phase 1-4,
       go directly to Phase 5 (emit bundle) with answers adapted to current project
     - `"参考但重新配置"` — use the reference to pre-fill Phase 1-4 defaults,
       but still ask all questions
     - `"不使用，从头配置"` — ignore the reference, proceed to Phase 1

4. **If no match or no index**: proceed to Phase 1 with the CLI description
   as the seed for pre-filling questions.

Record as: `cli_description = "<raw text>"`, `index_match = "<project>|none"`,
`reuse_mode = "full|seed|none"`.

---

## Phase 1: Preparation — Experiment Files

Goal: know **where the experiment code must physically be** for a run to work,
and **how it gets there**.

Use `AskUserQuestion`.

**Q1** — header: "Location", question: "Where do experiments actually execute?"
- `"Local machine"` — "Code runs from the project directory as-is; no transfer."
- `"Remote server (SSH)"` — "Code must be copied to a remote host before running."
- `"Container"` — "Code is mounted or baked into a container image."
- `"Managed/serverless"` — "A CLI uploads the code at submit time (Modal, etc.)."

**Q2** — header: "Remote path", question: "Absolute path on the execution machine where code must live?"
- Seed the first option from `.aris/experiment-env.json` `code_dir`, else
  `/workspace/<project>` for container/remote, else `$ROOT` for local.
- Skip this question entirely when Q1 = "Local machine".

**Q3** — header: "Transfer", question: "How does code get from here to there?"
- `"rsync over SSH"` — "rsync -avz --exclude .git ./ <alias>:<path>/"
- `"git push/pull"` — "Push here, pull on the execution machine."
- `"Shared filesystem"` — "Already visible on both sides; nothing to do."
- `"Uploaded by the CLI"` — "The submit CLI handles upload."

**Q4** — header: "Excludes", question: "Which paths must NOT be transferred?"
- Seed with `.git, __pycache__, results/, logs/, checkpoints/, *.pt, *.ckpt, data/`.
- Large checkpoints and datasets on the sync path are the single most common
  cause of a "hung" experiment launch.

**Record as:** `preparation.files = { location, remote_path, transfer, excludes[] }`.

---

## Phase 2: Preparation — Dependency Environment

Goal: the experiment code must be **runnable** — the right interpreter, the right
packages, and a way to *prove* it before launching.

**Q1** — header: "Env type", question: "What provides the dependency environment?"
- `"Conda"` — "conda activate <env> before running."
- `"venv / uv"` — "source <path>/bin/activate."
- `"Container image"` — "Dependencies baked into the image."
- `"System Python"` — "No isolation; run the interpreter directly."

**Q2** — header: "Env name", question: "Environment name or activation path?"
- Seed from `.aris/experiment-env.json` `conda_env`, else `.aris/setup-state.json`.

**Q3** — header: "Activation", question: "Exact activation line (the hook, if any)?"
- Seed from `conda_hook`, typically
  `source ~/miniconda3/etc/profile.d/conda.sh && conda activate <env>`.
- Getting the hook wrong is why `conda activate` fails under
  `ssh host 'command'` — a non-login shell has no `conda` function.

**Q4** — header: "Verify", question: "One command that proves the environment is usable?"
- Seed with `python -c "import torch; print(torch.__version__, torch.cuda.is_available())"`.
- This becomes the last line of `prepare.sh`. A run must never be launched into
  an environment that has not answered this successfully.

**Q5** — header: "Build" / "构建", question: "代码同步后需要什么构建/安装步骤？（如 `pip install -e .`、`make`、`cmake --build` 等。如果代码可直接执行则留空）"
(en): "What build/install steps are needed after code is synced? (e.g., `pip install -e .`, `make`, `cmake --build`. Leave blank if code runs directly)"
options: `["无需构建，直接可执行"]` + "Other"

**Record as:** `preparation.environment = { type, name, activation, build_cmd, verify_cmd }`.

---

## Phase 3: Run — the Experiment Command

Goal: reduce "run an experiment" to **one command with parameters**, so later
stages never reconstruct it.

**Q1** — header: "Entry point", question: "Script or module that runs one experiment?"
- Seed from the baseline reproduction: grep `refine-logs/EXPERIMENT_TRACKER.md`
  and `.aris/runs/*.json` for the command that succeeded.

**Q2** — header: "Arguments", question: "How are experiment parameters passed?"
- `"CLI flags"` — "--lr 1e-4 --seed 0"
- `"Config file"` — "python train.py --config configs/exp.yaml"
- `"Environment variables"` — "LR=1e-4 SEED=0 python train.py"
- `"Positional"` — "python train.py 1e-4 0"

**Q3** — header: "Launch mode", question: "How is a long run kept alive?"
- `"screen/tmux detached"` — "screen -dmS <name> — survives SSH disconnect."
- `"nohup background"` — "nohup ... & — survives logout."
- `"Job scheduler"` — "sbatch / qsub / kubectl — the scheduler owns the lifetime."
- `"Foreground"` — "Blocks until done; only sane for short runs."

**Q4** — header: "GPU selection", question: "How is the GPU chosen?"
- `"CUDA_VISIBLE_DEVICES"` — "Set per run by the caller."
- `"Scheduler-assigned"` — "The job scheduler allocates."
- `"All available"` — "Multi-GPU / DDP; the script decides."
- `"CPU only"` — "No GPU."

**Record as:** `run = { entry_point, arg_style, launch_mode, gpu_selection, template }`
where `template` is the fully-assembled command with `{{placeholders}}` for the
per-run values, e.g.:

```
{{activation}} && cd {{remote_path}} && CUDA_VISIBLE_DEVICES={{gpu}} \
  screen -dmS {{exp_name}} bash -c 'python {{entry_point}} {{args}} 2>&1 | tee logs/{{exp_name}}.log'
```

---

## Phase 3.5: Establish a Runnable Baseline

**Trigger:** Phase 3 Q1 found no evidence of a previously executed command —
`refine-logs/EXPERIMENT_TRACKER.md` has no success rows, `.aris/runs/*.json`
is empty, and the project has no recognizable training entry point.

1. Generate `.aris/env-config/<project>/mock/smoke_baseline.py` — minimal but
   **real**: import the framework per `preparation.environment`, allocate a
   tensor on the selected device, run ~10 steps on synthetic data, write
   `{"<primary_metric_key>": <float>, "steps": 10}` to
   `results/<exp_name>.json`, print a completion marker, `exit 0`.

2. Execute end-to-end through the draft bundle's scripts (not dry-run):
   `prepare.sh` → `run.sh smoke` → `collect.sh smoke`.

3. On success: record evidence at
   `.aris/env-config/<project>/mock/SMOKE_RESULT.json` + `smoke.log`, and
   append a `mock-baseline` row to `refine-logs/EXPERIMENT_TRACKER.md`.

4. On failure: fix the **configuration** (not the mock), up to
   `MAX_VERIFY_RETRIES` = 3 times. Persistent failure means the environment
   genuinely doesn't work → `status: "incomplete"` + hard stop with the real
   error message.

Record in `env.json`:

```json
"baseline": {
  "kind": "mock|reproduced",
  "script": ".aris/env-config/<project>/mock/smoke_baseline.py",
  "evidence": ".aris/env-config/<project>/mock/SMOKE_RESULT.json",
  "verified_at": "<ISO-8601>"
}
```

When `baseline.kind == "mock"`, the generated skill accepts `— entry-point: <path>`
to override the default entry point. Dry-runs substitute the mock, so Phase 6's
"no unsubstituted `{{placeholder}}`" rule needs no carve-out.

---

## Phase 4: Feedback — the Three Channels

This is the part previous flows left implicit. An experiment is not "done" when
the process exits; it is done when all three channels have been read.

### 4a. Error feedback — did the run fail, and why?

**Q1** — header: "Failure signal", question: "How do you know a run failed?"
- `"Non-zero exit code"`
- `"Traceback in the log"`
- `"Missing result file"` — "Success is defined by the result artifact existing."
- `"Scheduler status"` — "squeue/kubectl reports FAILED."

**Q2** — header: "任务类型", question: "这个项目主要执行什么类型的实验任务？（如：PyTorch 训练、分布式 DDP、强化学习、数据预处理、推理评估、自定义流程等）"

Free text answer. Record as `feedback.error.task_type`.

**Q3** — header: "错误收集", question:
"对于这类任务，你认为哪些错误信息和日志内容需要重点收集？（如：loss nan、梯度爆炸、NCCL 超时、特定框架的错误格式等。可以留空，skill 会自动搜索补充）"

Free text answer. Parse into `feedback.error.user_patterns[]`.

**Web search.** Use `WebSearch` to find common error patterns and log collection
best practices for the stated task type:

- Query 1: `"<task_type> common errors failure modes log patterns"`
- Query 2: `"<task_type> <framework if mentioned> debugging error collection best practices"`

Parse search results to extract error patterns, log signatures, and collection
recommendations. Record as `feedback.error.web_patterns[]`.

**Merge.** Take the union of `user_patterns[]` and `web_patterns[]`:
- Deduplicate by semantic overlap (e.g. "OOM" and "CUDA out of memory" → keep both)
- Present the merged list to the user:

**Q4** — header: "确认收集列表", question:
"以下是合并后的错误收集列表（来自你的输入 + 互联网搜索）：\n<merged list>\n\n需要增减吗？"

Free text answer. User can add/remove items, or confirm as-is.

Record the final confirmed list as `feedback.error.failure_patterns[]`.

`collect.sh` greps these patterns and surfaces matching lines. `analyze.sh`
Stage 1 uses the same list for comprehensive error log collection. A silent
failure that looks identical to "still running" is the worst outcome — the
pattern list should be as comprehensive as possible for the specific task type.

### 4b. Result feedback — what did the run measure?

**Q1** — header: "Result file", question: "Where does the run write its metrics?"
- Seed from the baseline artifacts, e.g. `results/<exp_name>.json`.

**Q2** — header: "Format", question: "What format?" — `"JSON"` / `"CSV"` / `"Parsed from log"` / `"W&B"`.

**Q3** — header: "Primary metric", question: "Which key is the headline metric?"
- Seed from `CLAUDE.md` `## Metric Target` (`primary: <number> <unit>`) — the
  metric name there MUST match the key read here, or the loop's Type-A stop
  check silently compares nothing.

Record `feedback.result = { path_template, format, primary_metric_key, extra_keys[] }`.

### 4c. Analysis feedback — what do the numbers mean?

**Q1** — header: "Analysis", question: "实验结果需要什么样的分析？"
- `"标准统计分析"` — "对比表 + 显著性检验 + insights（由 /analyze-results 驱动）"
- `"自定义分析脚本"` — "项目已有分析脚本，指定路径（/analyze-results 将其作为 — method 参数）"
- `"每次实验不同"` — "分析逻辑因实验而异，只记录输入"

**Q2** — header: "Analysis logic", question: "What comparison or test is required?"
- e.g. "compare each run against the baseline row, bootstrap 95% CI over seeds".
- Free text; this becomes the body of `analyze.sh` (or its dispatch to a skill).

**Q3** — header: "Output", question: "Where does the analysis artifact go?"
- Seed with `refine-logs/EXPERIMENT_RESULTS.md` — where `/experiment-bridge`
  already looks. Diverging from that path means later stages will not find it.

Record `feedback.analysis = { mode, logic, script_path, output_path }`.

**Analysis is driven by `/analyze-results`.** `analyze.sh` Stage 2 collects
result file paths; `/analyze-results` handles all analysis logic, iteration,
and supplementary experiment dispatch. The `— method` parameter on
`/analyze-results` accepts a user's existing analysis script as the starting
point.

---

## Phase 4.5: Transport Config (internal)

All four Q&A phases are now complete. Assemble the canonical JSON and write the
**internal** transport-layer artifacts. These are implementation details consumed
by the generated scripts — downstream skills do NOT read them directly.

1. **`.aris/experiment-env.json`** — assemble from `preparation.files`,
   `preparation.environment`, `run`, and `feedback`. Field names must match
   `src/tools/experiment-env/parse-env.ts` `ENV_SCHEMAS`. When the answers match
   a registered `ENV_TYPE` (`local|remote|vast|modal|docker`), validate via:
   ```bash
   echo '<candidate-json>' | node "$ENV_HELPER" parse --json - --source CLAUDE.md
   ```
   When no registered type fits, write directly with `env_type: "custom"` (the
   `validate()` function rejects unknown types, so skip `parse`).

2. **`CLAUDE.md` `## Experiment Environment`** — if the section exists, replace
   it in place. If absent, insert after `## Compute Budget`. If `CLAUDE.md`
   itself is absent, skip and log (in the `/research-setup` flow it will already
   exist from Phase 7b).

3. **Consult references** — check `$REF_DIR/index.md` for entries matching the
   current environment's location + dependency type. If a match exists, read the
   reference file and use it to seed script templates and known workarounds.
   If no `$REF_DIR` or no match, proceed from scratch — references are an
   accelerator, not a requirement.

---

## Phase 5: Emit the Project-Local Skill Bundle (DRAFT)

Everything below is written under `$STAGING_DIR` = `.aris/env-config/<project>/draft/`
in the **project**, NOT into `.claude/skills/` yet. The bundle is promoted only
after Phase 5.5's audit passes.

### 5a. `env.json` — the config of record

```json
{
  "version": 1,
  "project": "<project>",
  "generated": "<ISO-8601 UTC>",
  "source": "experiment-env-configuration",
  "status": "draft",
  "backend_hint": "<local|remote|vast|modal|docker|custom>",
  "preparation": {
    "files": { "location": "...", "remote_path": "...", "transfer": "...", "excludes": ["..."] },
    "environment": { "type": "...", "name": "...", "activation": "...", "build_cmd": "...", "verify_cmd": "..." }
  },
  "run": { "entry_point": "...", "arg_style": "...", "launch_mode": "...", "gpu_selection": "...", "template": "..." },
  "feedback": {
    "error": {
      "signal": "...",
      "log_path": "...",
      "task_type": "<user's task type description>",
      "user_patterns": ["<from user Q3>"],
      "web_patterns": ["<from web search>"],
      "failure_patterns": ["<merged and confirmed final list from Q4>"],
      "collect_full_traces": true,
      "context_lines": 5
    },
    "result": { "path_template": "...", "format": "...", "primary_metric_key": "...", "extra_keys": ["..."] },
    "analysis": { "mode": "...", "logic": "...", "script_path": "...", "output_path": "..." }
  },
  "audit": { "status": "pending", "verdict": null, "report": null, "audited_at": null }
}
```

`status` is written as `"draft"` here and is flipped to `"complete"` **only** by
Phase 6, and only when the Phase 5.5 verdict allows it. Downstream skills gate on
`status == "complete"`, so an un-audited or failed configuration is inert rather
than silently authoritative.

`audit` is filled in by Phase 5.5 from `ENV_CONFIG_AUDIT.json`. Its `verdict` is
**transcribed, never computed** — see the Gate provenance note at the top.

`backend_hint` records whether an existing `EnvBackend` (`local`/`remote`/`vast`/
`modal`/`docker`) covers this environment. When it does, the generated scripts
call `env-helper.js` and inherit its retry/sync behavior. When it is `custom`,
the scripts issue the commands directly. **No ARIS source file is edited either way.**

### 5b. The seven scripts

Each is POSIX `sh`, `set -eu`, reads `env.json` via `jq`, and accepts
`--dry-run` (print the command, execute nothing). All four must be executable
(`chmod +x`).

**`prepare.sh`** — three steps:

1. **Sync** — transfer code per `preparation.files`.
2. **Build** — if `preparation.environment.build_cmd` is set, run the build
   command on the execution machine. Incremental build is fine — the audit
   phase (`/experiment-env-audit` Check L2) separately verifies that source
   changes propagate correctly through the build pipeline.
   If `build_cmd` is empty, skip this step (code runs directly).
3. **Verify** — run `preparation.environment.verify_cmd`. Non-zero exit
   means do not proceed to `run.sh`.

**`run.sh <exp_name> [--gpu N] [--args "..."]`** — substitute into
`run.template` and launch. Prints the resolved command before executing so the
log records exactly what ran.

`run.sh` saves the running experiment's handle to `handles/<exp_name>.json`
(replacing the previous convention of `/tmp/handle.json`):
```json
{ "exp_name": "...", "pid_or_session": "...", "launched_at": "<ISO-8601>" }
```

**`collect.sh <exp_name>`** — pull back `feedback.error.log_path` and
`feedback.result.path_template`; grep the log for `failure_patterns`; print a
verdict line: `RESULT ok <primary_metric>=<value>` or `RESULT failed <first matching pattern>`.

`collect.sh` also writes the enriched receipt to
`.aris/runs/<run_id>.experiment.<exp_name>.done.json`:

```json
{
  "exp_name": "...",
  "status": "ok|failed",
  "primary_metric": null,
  "metrics": {},
  "result_path": "...",
  "log_path": "...",
  "analysis_path": "...",
  "failure_reason": null,
  "failure_patterns_matched": [],
  "error_report": "<output_dir>/error_report.md",
  "error_count": 0,
  "error_types": [],
  "gpu_usage": { "memory_used_mib": 0, "utilization_pct": 0 },
  "wandb": null,
  "handle": "handles/<exp>.json",
  "elapsed_seconds": 0,
  "completed_at": "<ISO-8601>"
}
```

This receipt replaces multiple formerly separate data sources: env-helper
monitor output, SSH W&B queries, CLAUDE.md parsing, and hardcoded error
patterns — all in one file that downstream skills can read directly.

**`analyze.sh`** — two-stage output:

**Stage 1: Comprehensive error log collection.** Scan ALL log files for the
error patterns in `feedback.error.failure_patterns[]` (the merged list from
user input + web search, confirmed in Phase 4a Q4). Collect:
- Full stack traces (from error marker through the final error line)
- Surrounding context (5 lines before and after each match)
- Log file path and line number for each error
- Deduplicated error summary (same root cause collapsed)

Write to `<output_dir>/error_report.md`:
```
## Error Report — <exp_name>
### Errors Found: <count>
#### Error 1: <error type> at <log_file>:<line>
<context + full trace>
### Summary
- Total errors: <n>
- Unique error types: <n>
- Most frequent: <type> (<count> occurrences)
```

**Stage 2: Result collection for /analyze-results.** Collect all result file
paths and output a manifest to stdout (JSON list of `{path, format, experiment}`
entries). `/analyze-results` reads this manifest as its input when it drives
the iterative analysis loop. The actual analysis logic lives in
`/analyze-results`, not in this script.

Stage 1 always runs. A run with zero errors produces an error_report.md
confirming "0 errors found".

**`monitor.sh <exp_name>`** — check status of a running experiment. Reads the
handle from `handles/<exp_name>.json`, queries the backend (screen session /
process / modal app / local pid), and outputs a **single JSON object** to stdout:

```json
{
  "status": "running|done|failed|unknown",
  "exit_code": null,
  "gpu_usage": { "memory_used_mib": 0, "utilization_pct": 0 },
  "tail": ["<last 20 log lines>"],
  "elapsed_seconds": 0,
  "wandb": { "run_id": "...", "url": "...", "project": "...", "entity": "..." }
}
```

This replaces the pattern where `/monitor-experiment` called `env-helper.js
monitor` directly and pulled W&B metrics via raw SSH Python snippets. The W&B
query is done internally using `wandb` config from `env.json`.

**`info.sh`** — dump environment metadata as a **single JSON object** to stdout.
Downstream skills call this instead of reading `.aris/experiment-env.json` directly:

```json
{
  "project": "<project>",
  "hardware": { "gpu_type": "...", "gpu_count": 0, "device": "cuda|mps|cpu", "gpu_free_threshold_mib": 500 },
  "compute_budget": "...",
  "error_patterns": ["Traceback", "CUDA out of memory", "Killed", "RuntimeError", "No such file"],
  "wandb": { "enabled": false, "project": "...", "entity": "..." },
  "paths": { "remote_path": "...", "result_dir": "results/", "log_dir": "logs/" },
  "connection": { "ssh_alias": "...", "conda_env": "...", "conda_hook": "...", "transfer": "rsync|git|shared|cli-upload" },
  "backend_hint": "local|remote|vast|modal|docker|custom"
}
```

`/experiment-plan` reads `hardware` for compute estimates; `/experiment-bridge`
reads `error_patterns` (replacing hardcoded OOM/CUDA patterns) and `wandb`;
`/experiment-queue` reads `connection` to populate manifest fields.

**`teardown.sh [--force]`** — release environment resources. For `vast`:
destroy the instance; for `modal`: stop the app; for `docker`: stop and remove
the container; for `remote`/`local`: no-op (or kill stale screen sessions with
`--force`). Exit 0 on success, 1 on failure.

### 5c. `SKILL.md` — the replayable procedure

Frontmatter:

```yaml
---
name: run-<project>-experiment
description: 'Run one experiment for the <project> research project: prepare (sync code + verify dependency environment), run (launch via the frozen command), and feed back (errors, metrics, analysis). Generated by /experiment-env-configuration from a verified baseline reproduction — do not re-answer configuration questions, the answers are frozen in env.json. Use whenever an experiment must be executed or re-executed for this project.'
argument-hint: "<exp_name> [— args: ...] [— gpu: N] [— skip-prepare]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob
---
```

Body sections, in order:

1. **Frozen configuration** — a human-readable rendering of `env.json`
   (where code lives, which env, the run command, the three feedback channels).
   Marked explicitly: *"These values were verified during baseline reproduction.
   Do not re-derive them. To change them, run `/experiment-env-configuration —
   reconfigure`."*
2. **Step 1 — Prepare** — `scripts/prepare.sh`; hard-stop on failure.
   Skippable with `— skip-prepare` when a run in the same session already prepared.
3. **Step 2 — Run** — `scripts/run.sh <exp_name>` with the resolved arguments.
4. **Step 3 — Error feedback** — `scripts/collect.sh <exp_name>`; on
   `RESULT failed`, report the matched pattern and the last 40 log lines, and stop.
5. **Step 4 — Result feedback** — read `primary_metric_key`; append a row to
   `refine-logs/EXPERIMENT_TRACKER.md`.
6. **Step 5 — Analysis feedback** — `scripts/analyze.sh`; the artifact lands at
   `feedback.analysis.output_path`.
7. **Receipt** — write `.aris/runs/<run_id>.experiment.<exp_name>.done.json`:
   ```json
   { "exp_name": "...", "status": "ok|failed", "primary_metric": <number|null>,
     "result_path": "...", "analysis_path": "...", "log_path": "...",
     "failure_reason": "<null or matched pattern>", "completed_at": "<ISO-8601>" }
   ```
   This is the file a dispatching parent reads. The agent's reply text is at most
   a one-line status (`paseo-subagent-dispatch.md` Rule 3, file-paths-only).

---

## Phase 5.5: Trustworthiness Audit (moved to Phase 6d)

The audit is now dispatched in **Phase 6d**, after preliminary promotion to the
final path. This ensures the audit runs against the scripts at their real
location (`.claude/skills/run-<project>-experiment/`), not the staging directory.

See Phase 6d for the dispatch, Phase 6e for the verdict gate, and Phase 5.5c
below for the user-assisted repair loop on FAIL.

> `/experiment-env-audit` (which dispatches `/experiment-audit` internally) is
> **advisory to its other callers and stays that way** —
> its own contract ("never block") is unchanged and `/research-pipeline` still
> continues on FAIL. The blocking behaviour lives **here, in the caller**. This
> skill declines to finalize a bundle its auditor did not clear; the auditor is
> not made to halt anyone.

This half is Type-A — "the audit was invoked and its verdict file exists and
parses" is machine-checkable, so this skill may judge it:

```bash
AUDIT_JSON=".aris/env-config/<project>/ENV_CONFIG_AUDIT.json"
test -f "$AUDIT_JSON" && jq -e '.overall_verdict' "$AUDIT_JSON" >/dev/null
```

If the file is missing or unparseable, that is a **hard stop**: `audit.status =
"error"`, no promotion. A skill that promotes when the auditor failed to answer
is self-acquitting by omission.

### 5.5b. Read the verdict (Type-B — this skill MUST NOT form its own opinion)

Transcribe, do not evaluate:

```bash
VERDICT=$(jq -r '.overall_verdict' "$AUDIT_JSON" | tr 'A-Z' 'a-z')
```

| `overall_verdict` | Promotion | `env.json.status` | Behaviour |
|---|---|---|---|
| `pass` | **allowed** | `complete` | Phase 6 promotes the bundle. |
| `warn` | **allowed, tagged** | `complete` | Promote, and copy the WARN action items into the generated `SKILL.md` under a `## Known caveats (from audit)` section so every later run sees them. |
| `fail` | **refused** | `audit_failed` | Do **not** create `.claude/skills/run-<project>-experiment/`. The draft stays in staging. Print the failing checks and their action items. |
| `fail` (user overrides) | **allowed, tagged** | `user_override` | User chose to override the audit. Promote with `## ⚠️ Audit overridden by user` caveat section. |
| missing / unparseable | **refused** | `audit_error` | As above; report that the audit did not return a verdict. |

Record into the draft `env.json`:

```json
"audit": {
  "status": "passed|passed_with_warnings|failed|error",
  "verdict": "<verbatim overall_verdict from the audit JSON>",
  "report": ".aris/env-config/<project>/ENV_CONFIG_AUDIT.md",
  "audited_at": "<ISO-8601 UTC>",
  "failing_checks": ["G", "H"]
}
```

**The `verdict` field is copied verbatim.** This skill does not reinterpret a
FAIL as "a warning really", does not average A–K into an overall of its own, and
does not re-run the audit hoping for a better answer. One audit, one verdict.

### 5.5c. On FAIL — ask user for help (every round)

When the audit returns FAIL, immediately involve the user:

1. Print the failing checks and action items from `ENV_CONFIG_AUDIT.md`.

2. `AskUserQuestion`:
   - header: "审计失败"
   - question: "环境配置审计未通过：\n<failing checks with action items>\n\n请提供修复指导，或选择其他操作："
   - options:
     - `"我来协助修复"` — user will provide fix guidance
     - `"跳过此检查，强制部署"` — override the audit
     - `"放弃本次配置"` — abort

3. On "协助修复":
   - `AskUserQuestion` with header "修复指导", question "请描述如何修复上述问题：",
     free text answer
   - Apply fixes to the draft artifacts as directed by the user
   - Re-run Phase 5.5a (fresh `/experiment-env-audit` dispatch)
   - If FAIL again → repeat from step 1 (no autonomous round limit — the user
     controls when to stop via "跳过" or "放弃")

4. On "跳过此检查，强制部署":
   - Set `audit.status = "user_override"` and `audit.verdict = "fail_overridden"`
   - Promote the bundle to `.claude/skills/run-<project>-experiment/`
   - Add `## ⚠️ Audit overridden by user` section to the generated SKILL.md
     listing the failing checks and the user's decision to override
   - This is a conscious user decision, not the skill's judgment

5. On "放弃":
   - Return `status: "audit_failed"` with the failing checks
   - The draft stays in staging

---

## Phase 6: Verify, Promote, Audit, Finalize

Scripts must be audited at their **final path** — a script that works from the
draft directory but breaks after promotion is a false positive. The flow is:
verify syntax → promote (preliminary, `status: "pending_audit"`) → audit at
promoted path → finalize or demote.

### 6a. Syntax verification (in staging)

1. **Scripts are valid shell:** `sh -n` each script in `$STAGING_DIR/scripts/`.
2. **`env.json` parses and is structurally complete:**
   ```bash
   jq -e '.run.template != "" and .feedback.result.primary_metric_key != ""' \
     "$STAGING_DIR/env.json"
   ```

### 6b. Preliminary promotion

Copy the draft to the final path so all paths resolve correctly during audit:

```bash
mkdir -p "$(dirname "$SKILL_DIR")"
cp -R "$STAGING_DIR" "$SKILL_DIR"
chmod +x "$SKILL_DIR"/scripts/*.sh
# mark as pending audit — NOT complete yet
tmp=$(mktemp)
jq '.status = "pending_audit"' "$SKILL_DIR/env.json" > "$tmp" && mv "$tmp" "$SKILL_DIR/env.json"
```

### 6c. Dry-run verification (at promoted path)

```bash
sh "$SKILL_DIR/scripts/prepare.sh" --dry-run
sh "$SKILL_DIR/scripts/run.sh" smoke --dry-run
sh "$SKILL_DIR/scripts/collect.sh" smoke --dry-run
sh "$SKILL_DIR/scripts/analyze.sh" --dry-run
sh "$SKILL_DIR/scripts/monitor.sh" --dry-run 2>/dev/null || true
sh "$SKILL_DIR/scripts/info.sh" > /dev/null
sh "$SKILL_DIR/scripts/teardown.sh" --dry-run 2>/dev/null || true
```

Each must exit 0 and print a plausible command — no unsubstituted
`{{placeholder}}` may survive. If any fails, demote (step 6g) and report.

### 6d. Dispatch audit (at promoted path)

Dispatch `/experiment-env-audit` targeting the **promoted** location:

```
mcp__paseo__create_agent
  title:    "env-config audit: <project>"
  provider: claude
  cwd:      $ROOT
  initialPrompt: |
    /experiment-env-audit — project: <project> — reviewer: <REVIEWER_BACKEND> — target: promoted
```

Wait, read verdict, archive agent. The audit now runs against `.claude/skills/run-<project>-experiment/` — the same path downstream skills will use.

### 6e. Gate — read audit verdict

Same Type-A / Type-B split as before. On FAIL → Phase 5.5c user-assisted
repair loop (fix, re-promote, re-audit). On repeated FAIL → user can override
or abort.

If verdict permits (pass / warn / user_override):

### 6f. Finalize

```bash
tmp=$(mktemp)
jq '.status = "complete"' "$SKILL_DIR/env.json" > "$tmp" && mv "$tmp" "$SKILL_DIR/env.json"
```

On `passed_with_warnings`, append WARN action items to `$SKILL_DIR/SKILL.md`
under `## Known caveats (from audit)`.

### 6g. Demote (on failure)

If audit fails and user chooses "放弃":

```bash
rm -rf "$SKILL_DIR"
# draft stays in $STAGING_DIR for inspection
```

Report `status: "audit_failed"` with paths to the draft and audit report.

### 6h. Register in CLAUDE.md

After finalization (step 6f), update `## Experiment Skill` in CLAUDE.md with
the skill path and script paths (same as previously defined in step 7).

### 6i. Skill is discoverable

`$SKILL_DIR/SKILL.md` exists with valid frontmatter whose `name` matches the
directory name, and `jq -e '.status == "complete"' "$SKILL_DIR/env.json"` exits 0.

Then print:

```
Experiment environment configured for "<project>".

Generated:
  .claude/skills/run-<project>-experiment/SKILL.md
  .claude/skills/run-<project>-experiment/env.json
  .claude/skills/run-<project>-experiment/scripts/{prepare,run,collect,analyze}.sh

Frozen configuration:
  Files:     <location> → <remote_path> via <transfer>
  Env:       <type> "<name>", verified by: <verify_cmd>
  Run:       <entry_point> (<launch_mode>, <gpu_selection>)
  Error:     <signal>, log at <log_path>
  Result:    <primary_metric_key> from <path_template>
  Analysis:  <mode> → <output_path>

Verification:
  Shell syntax:   PASS/FAIL
  Dry runs:       PASS/FAIL
  env.json:       PASS/FAIL
  Audit (Type-B): PASS/WARN/FAIL   ← cross-model, <REVIEWER_BACKEND>
  Promoted:       yes/no
  Discoverable:   PASS/FAIL

Audit report: .aris/env-config/<project>/ENV_CONFIG_AUDIT.md

Next: /run-<project>-experiment <exp_name>
Re-runs need no configuration. To change it: /experiment-env-configuration — reconfigure
```

When the gate refuses promotion, print this instead — and do not print a "Next:"
line, because there is no skill to invoke:

```
Experiment environment NOT configured for "<project>" — audit did not pass.

Draft (not promoted): .aris/env-config/<project>/draft/
Audit report:         .aris/env-config/<project>/ENV_CONFIG_AUDIT.md
Verdict:              FAIL

Failing checks:
  <ID>. <check name> — <one-line action item from the report>
  ...

The project-local experiment skill was not created. Fix the items above, then:
  /experiment-env-configuration — reconfigure
```

---

## Phase 6.5: Save Exploration to References

**Only runs when Phase 6 promotes successfully** (status = `complete`).

1. Extract environment summary from the promoted `env.json`: location,
   dependency type, transfer method, launch mode, GPU selection, and any
   gotchas encountered during configuration.

2. Write (or update) `$REF_DIR/<project-slug>-env.md` with the summary,
   key configuration values (activation, verify_cmd, run template, result
   path, primary metric), gotchas/workarounds, and script references.

3. Update `$REF_DIR/index.md` — append a row to the Entries table with the
   project name, location, dependency type, transfer method, reference file
   path, and date.

If `$REF_DIR` does not exist, create it. If `index.md` does not exist, create
it with the standard header and an empty table.

**References are an accelerator, not a requirement.** The skill runs correctly
without them; they reduce exploration time for similar environments.

---

## Constants

- **SKILL_DIR_TEMPLATE** = `.claude/skills/run-<project>-experiment`
- **STAGING_DIR_TEMPLATE** = `.aris/env-config/<project>/draft`
- **AUDIT_DIR_TEMPLATE** = `.aris/env-config/<project>`
- **CONFIG_VERSION** = 1
- **DEFAULT_EXCLUDES** = `.git, __pycache__, results/, logs/, checkpoints/, *.pt, *.ckpt, data/`
- **DEFAULT_FAILURE_PATTERNS** = `Traceback`, `CUDA out of memory`, `Killed`, `AssertionError`, `RuntimeError`, `No such file`
- **MAX_VERIFY_RETRIES** = 3
- **REVIEWER_BACKEND** = `codex` (override with `— reviewer: oracle-pro|manual`)
- **REF_DIR_TEMPLATE** = `$CLAUDE_SKILL_DIR/references` → `.claude/skills/experiment-env-configuration/references` → `$ARIS_REPO/skills/experiment-env-configuration/references`
- **MOCK_DIR_TEMPLATE** = `.aris/env-config/<project>/mock`
- **HANDLE_DIR** = `handles/` (inside the generated skill directory)

## Critical Rules

1. **Never write to the ARIS repo.** Every artifact goes under the project's
   `.claude/skills/run-<project>-experiment/`. The environment is project data.
2. **Idempotent by default.** Existing `SKILL.md` + no `— reconfigure` = verify
   and stop. This is the property that makes later rounds fully automatic.
3. **Never guess a run command.** If the answer cannot be derived from the
   user or existing sources, ask the user. A guessed command wastes GPU hours
   and produces results that look real.
4. **Prefer an existing backend.** If `local`/`remote`/`vast`/`modal`/`docker`
   covers the environment, set `backend_hint` and call `env-helper.js` from the
   generated scripts. Only fall back to `custom` direct commands when none fits.
5. **Analysis is driven by `/analyze-results`.** `analyze.sh` Stage 2 provides
   data collection; `/analyze-results` owns the analysis logic, iterates until
   a cross-model verifier passes, and can trigger supplementary experiments.
   Never duplicate analysis logic that belongs in `/analyze-results`.
6. **The primary metric key must match `CLAUDE.md` `## Metric Target`.** A
   mismatch silently breaks every downstream Type-A stop check. Verify in Phase 6.
7. **Every generated script supports `--dry-run`** and is verified with it before
   this skill reports success.
8. **File-paths-only receipts.** The generated skill writes
   `.aris/runs/<run_id>.experiment.<exp_name>.done.json`; the dispatching parent
   reads that file, never the agent's prose.
9. **No promotion without a passing cross-model verdict.** The bundle is drafted
   in staging and copied into `.claude/skills/` only after `/experiment-env-audit`
   returns `pass` or `warn`. Passing Phase 6 steps 1–3 is necessary and **not**
   sufficient — those are Type-A checks and cannot answer "is this configuration
   trustworthy".
10. **Never self-judge the audit result.** This skill may verify that the audit
    *ran* (Type-A) and must read `overall_verdict` verbatim (Type-B). It must not
    reinterpret, average, override, or re-run-until-favourable a verdict. The user
    controls how many repair rounds to attempt. Each round dispatches a fresh
    `/experiment-env-audit`.
11. **The audit stays advisory to everyone else.** `/experiment-env-audit`'s own
    contract (which internally dispatches `/experiment-audit`) is untouched; the
    block is implemented here, in the caller. Do not edit `/experiment-env-audit`
    or `/experiment-audit` to halt pipelines — other flows depend on them
    continuing.
12. **Downstream skills use the 7-script interface, not internal files.**
    `.aris/experiment-env.json` and `env-helper.js` are internal implementation
    details of the generated scripts. Downstream skills (`/monitor-experiment`,
    `/experiment-queue`, `/experiment-bridge`, `/auto-review-loop`,
    `/experiment-plan`, `/ablation-planner`) call the scripts (`prepare.sh`,
    `run.sh`, `collect.sh`, `analyze.sh`, `monitor.sh`, `info.sh`,
    `teardown.sh`) and read the structured JSON output — never the internals.
13. **References are an accelerator, not a requirement.** The skill runs
    correctly without `references/index.md`. It creates the directory and
    index on first successful configuration.
14. **A mock baseline is not a guess.** It is generated by this skill, executed
    end-to-end in the real environment, and verified with real output. Freezing
    a command that was never executed — in any mode — is still forbidden (Rule 3).

## External dependencies (reused, not modified)

- `src/tools/experiment-env/env-helper.ts` — `provision | sync | deploy | monitor | collect | destroy`.
  Used by generated scripts when `backend_hint != "custom"`.
- `src/tools/experiment-env/parse-env.ts` — `ENV_TYPES` / `ENV_SCHEMAS`; read to
  decide whether an existing backend covers the environment.
- `skills/experiment-audit/SKILL.md` — the Phase 5.5 auditor. Invoked as a paseo
  sub-agent; its non-blocking contract is respected (this skill blocks, not it).
- `skills/analyze-results/SKILL.md` — the default analysis implementation.
- `skills/run-experiment/SKILL.md` — the transport-level runner; the generated
  skill wraps it rather than replacing it.
- `skills/shared-references/acceptance-gate.md` — DRIVE/ACQUIT; the Type-A /
  Type-B split that Phase 5.5 implements.
- `skills/shared-references/reviewer-independence.md` — why the auditor reads the
  files itself and receives paths, not this skill's summary of them.
- `skills/shared-references/integration-contract.md` §2 — helper resolution chain.
- `skills/shared-references/paseo-subagent-dispatch.md` — Rule 1 (one agent = one
  skill), Rule 3 (file-paths-only receipts), Rule 4 (Paseo MCP only).
- `references/index.md` — experience cache; written after successful
  configuration, read at Phase 4.5 to seed similar environments.
