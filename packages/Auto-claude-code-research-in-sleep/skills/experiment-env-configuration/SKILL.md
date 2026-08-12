---
name: experiment-env-configuration
description: 'Pure PRD-to-scripts generator. Reads a structured PRD or patch JSON and emits a frozen project-local experiment skill at `.claude/skills/run-<project>-experiment/`. No user interaction — all input comes from the PRD or patch file. Covers experiment-file placement (local/remote), dependency environment, the run command/CLI, and the three feedback channels (error, result, analysis). Every step becomes a script or CLI so all runs are fully automatic. Use when env-manager dispatches configuration from a validated PRD.'
argument-hint: "[— project: <name>] [— prd: <path>] [— patch: <path>]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob
---

# Experiment Environment Configuration

Configure the experiment environment for: **$ARGUMENTS**

## Purpose

A research project runs the *same* experiment loop dozens of times: put the code
somewhere runnable, activate the right dependency environment, launch, then read
back errors / metrics / analysis. Today that knowledge lives in one agent's head
and is re-derived every round.

This skill reads a structured PRD (produced by `/experiment-env-manager`) and
writes the answer down as an executable project-local skill. After it completes,
every later stage (`/experiment-bridge`, `/run-experiment`, `/auto-research-loop`)
invokes the generated skill instead of re-asking anything.

```
Phase 0    Pre-flight: resolve roots, detect existing config, validate input mode
Phase 1    Read preparation config from PRD (files + SSH)
Phase 2    Read preparation config from PRD (environment + resources)
Phase 3    Read run config from PRD
Phase 4    Read feedback config from PRD (error, result, analysis)
Phase 4.5  Transport config — write .aris/experiment-env.json (internal) + CLAUDE.md env block
Phase 5    Emit the project-local skill bundle (SKILL.md + scripts/ + env.json)
Phase 5.5  Establish runnable baseline (mock if PRD specifies) — requires Phase 5 scripts
Phase 6    Verify and promote: syntax check + dry-runs → finalize, print summary
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
| 7 | `.aris/env-config/<project>/receipt.json` | Configuration receipt |

Rows 1–6.4 are written to a **staging directory first** and only moved into
`.claude/skills/` after Phase 6 verification passes.

> **This skill does NOT modify the ARIS repo.** The environment is project data,
> not ARIS code — it belongs in the project directory. The existing `EnvBackend`
> backends (`local`, `remote`, `vast`, `modal`, `docker`) are still used as the
> transport when one of them fits; anything they do not cover is expressed as a
> script in the generated skill.

> **This skill does NOT dispatch any sub-agents.** It is a pure generator: read
> PRD, emit scripts. Audit is handled by `/experiment-env-manager`, which
> dispatches `/experiment-env-audit` separately after this skill completes.

---

## Phase 0: Pre-flight

1. **Resolve project root.**
   ```bash
   ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
   cd "$ROOT" || exit 1
   ```

2. **Derive the project slug.** `basename "$ROOT"`, lowercased, consecutive
   non-alphanumerics collapsed to a single `-`, leading/trailing `-` stripped.
   This becomes `<project>` in `run-<project>-experiment`.
   Validate against `/^[a-z0-9][a-z0-9-]*$/`; if it fails, fall back to `project`.

   Example: `Foo__Bar!` → `foo-bar` (not `foo--bar-`).

3. **Compute paths.** `SKILL_DIR=".claude/skills/run-<project>-experiment"`
   and `STAGING_DIR=".aris/env-config/<project>/draft"`.

4. **Determine input mode.**

   | `$ARGUMENTS` | Mode | Behavior |
   |---|---|---|
   | `— prd: <path>` | **fresh** | Always run — ignore any existing config. Read the PRD file, validate it parses as JSON, proceed to Phase 1. |
   | `— patch: <path>` | **patch** | Requires `$SKILL_DIR/env.json` to exist. Read the patch file, validate JSON, skip to Patch Mode (below). |
   | Neither `— prd` nor `— patch` | **error** | Exit with error: "PRD or patch path is required. This skill does not run interactively." |

   If `— project: <name>` is provided, use that as the project slug instead of
   deriving from `basename`.

---

## Phase 1: Read Preparation — Experiment Files

Goal: know **where the experiment code must physically be** for a run to work,
and **how it gets there**. All values come from the PRD.

```
Read `prd.preparation.files.location`    → set location
Read `prd.preparation.files.remote_path` → set remote_path
Read `prd.preparation.files.transfer`    → set transfer
Read `prd.preparation.files.excludes`    → set excludes[]
Read `prd.preparation.files.ssh_alias`   → set ssh_alias
```

**Required fields:** `location`. When `location` is not `"local"`, `remote_path`
and `transfer` are also required. When `location` is `"remote"`, `ssh_alias`
is also required.

If any required field is missing → error exit: "PRD missing required field:
preparation.files.<field>".

**Defaults when omitted (non-required fields only):**
- `excludes`: use `DEFAULT_EXCLUDES`
- `remote_path` (when location is `"local"`): use `$ROOT`
- `ssh_alias` (when location is `"local"` or `"container"`): `null`

**Record as:** `preparation.files = { location, remote_path, transfer, excludes[], ssh_alias }`.

---

## Phase 2: Read Preparation — Environment and Resources

Goal: the experiment code must be **runnable** — the right interpreter, the right
packages, and a way to *prove* it before launching.

### 2a. Dependency Environment

```
Read `prd.preparation.environment.type`       → set type
Read `prd.preparation.environment.name`       → set name
Read `prd.preparation.environment.activation` → set activation
Read `prd.preparation.environment.build_cmd`  → set build_cmd
Read `prd.preparation.environment.verify_cmd` → set verify_cmd
```

**Required fields:** `type`, `activation`, `verify_cmd`.

If any required field is missing → error exit: "PRD missing required field:
preparation.environment.<field>".

**Defaults when omitted:**
- `name`: empty string (no named environment)
- `build_cmd`: empty string (code runs directly, no build step)

**Record as:** `preparation.environment = { type, name, activation, build_cmd, verify_cmd }`.

### 2b. Compute Resources

```
Read `prd.resources` → set resources config
```

If `prd.resources` is `null` or absent → skip (no resources to schedule).
Set `resources = null` in the config and proceed.

When present, read:

```
Read `prd.resources.type`                → set type (gpu|node|cpu|custom)
Read `prd.resources.ids`                 → set ids[]
Read `prd.resources.label`               → set label
Read `prd.resources.bind_env`            → set bind_env
Read `prd.resources.bind_mode`           → set bind_mode (env|prefix)
Read `prd.resources.free_check`          → set free_check object
Read `prd.resources.exhaustion_patterns` → set exhaustion_patterns[]
```

**Required fields (when resources is present):** `type`, `ids`.

**Validation (when resources is present):**
- `free_check` must be either `null` or a complete object with `cmd`,
  `threshold`, `unit`, `compare`, and `index_by`. Reject `{}` (empty object) or
  partial objects missing any of these fields → error exit: "PRD has
  incomplete resources.free_check — provide all members or set to null."
- `exhaustion_patterns` must be either absent/null or a non-empty array of
  non-empty strings.

**Record as:**
```json
"resources": {
  "type": "<gpu|node|cpu|custom>",
  "ids": ["..."],
  "label": "...",
  "bind_env": "...",
  "bind_mode": "env|prefix",
  "free_check": { "cmd": "...", "threshold": 0, "unit": "...", "compare": "lt|gt|eq", "index_by": "physical|positional" },
  "exhaustion_patterns": ["..."]
}
```

---

## Phase 3: Read Run Config

Goal: reduce "run an experiment" to **one command with parameters**, so later
stages never reconstruct it.

```
Read `prd.run.entry_point`   → set entry_point
Read `prd.run.arg_style`     → set arg_style
Read `prd.run.launch_mode`   → set launch_mode
Read `prd.run.gpu_selection`  → set gpu_selection
Read `prd.run.template`      → set template
```

**Required fields:** `entry_point`, `template`.

If any required field is missing → error exit: "PRD missing required field:
run.<field>".

**Defaults when omitted:**
- `arg_style`: `"cli"` (CLI flags)
- `launch_mode`: `"screen"` (screen/tmux detached)
- `gpu_selection`: `"CUDA_VISIBLE_DEVICES"`

**Record as:** `run = { entry_point, arg_style, launch_mode, gpu_selection, template }`
where `template` is the fully-assembled command with `{{placeholders}}` for the
per-run values, e.g.:

```
{{activation}} && cd {{remote_path}} && CUDA_VISIBLE_DEVICES={{gpu}} \
  screen -dmS {{exp_name}} bash -c '{{entry_point}} {{args}} 2>&1 | tee logs/{{exp_name}}.log'
```

---

## Phase 4: Read Feedback Config

This is the part previous flows left implicit. An experiment is not "done" when
the process exits; it is done when all three channels have been read.

### 4a. Error feedback — did the run fail, and why?

```
Read `prd.feedback.error.signal`           → set signal
Read `prd.feedback.error.log_path`         → set log_path
Read `prd.feedback.error.task_type`        → set task_type
Read `prd.feedback.error.failure_patterns` → set failure_patterns[]
```

**Required fields:** `signal`.

**Defaults when omitted:**
- `log_path`: `"logs/{{exp_name}}.log"`
- `task_type`: `"unknown"`
- `failure_patterns`: use `DEFAULT_FAILURE_PATTERNS`

`collect.sh` greps these patterns and surfaces matching lines. `analyze.sh`
Stage 1 uses the same list for comprehensive error log collection. A silent
failure that looks identical to "still running" is the worst outcome — the
pattern list should be as comprehensive as possible for the specific task type.

Record `feedback.error = { signal, log_path, task_type, failure_patterns[] }`.

### 4b. Result feedback — what did the run measure?

```
Read `prd.feedback.result.path_template`      → set path_template
Read `prd.feedback.result.format`             → set format
Read `prd.feedback.result.primary_metric_key` → set primary_metric_key
Read `prd.feedback.result.extra_keys`         → set extra_keys[]
```

**Required fields:** `primary_metric_key`.

If `primary_metric_key` is missing → error exit: "PRD missing required field:
feedback.result.primary_metric_key".

**Defaults when omitted:**
- `path_template`: `"results/{{exp_name}}.json"`
- `format`: `"json"`
- `extra_keys`: `[]`

Record `feedback.result = { path_template, format, primary_metric_key, extra_keys[] }`.

### 4c. Analysis feedback — what do the numbers mean?

```
Read `prd.feedback.analysis.mode`        → set mode
Read `prd.feedback.analysis.logic`       → set logic
Read `prd.feedback.analysis.output_path` → set output_path
```

**Defaults when omitted:**
- `mode`: `"standard"` (standard statistical analysis driven by /analyze-results)
- `logic`: `""` (empty — /analyze-results uses its default)
- `output_path`: `"refine-logs/EXPERIMENT_RESULTS.md"`

Record `feedback.analysis = { mode, logic, output_path }`.

**Analysis is driven by `/analyze-results`.** `analyze.sh` Stage 2 collects
result file paths; `/analyze-results` handles all analysis logic, iteration,
and supplementary experiment dispatch. The `— method` parameter on
`/analyze-results` accepts a user's existing analysis script as the starting
point.

---

## Phase 4.5: Transport Config (internal)

All PRD reading phases are now complete. Assemble the canonical JSON and write the
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

## Phase 5: Emit the Project-Local Skill Bundle

Everything below is written under `$STAGING_DIR` = `.aris/env-config/<project>/draft/`
in the **project**, NOT into `.claude/skills/` yet. The bundle is promoted after
Phase 6 verification passes.

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
    "files": {
      "location": "...",
      "remote_path": "...",
      "transfer": "...",
      "excludes": ["..."],
      "ssh_alias": "..."
    },
    "environment": { "type": "...", "name": "...", "activation": "...", "build_cmd": "...", "verify_cmd": "..." }
  },
  "resources": {
    "type": "gpu|node|cpu|custom",
    "ids": ["..."],
    "label": "...",
    "bind_env": "...",
    "bind_mode": "env|prefix",
    "free_check": { "cmd": "...", "threshold": 0, "unit": "...", "compare": "lt", "index_by": "physical|positional" },
    "exhaustion_patterns": ["..."]
  },
  "run": { "entry_point": "...", "arg_style": "...", "launch_mode": "...", "gpu_selection": "...", "template": "..." },
  "feedback": {
    "error": {
      "signal": "...",
      "log_path": "...",
      "task_type": "<task type from PRD>",
      "failure_patterns": ["<from PRD>"]
    },
    "result": { "path_template": "...", "format": "...", "primary_metric_key": "...", "extra_keys": ["..."] },
    "analysis": { "mode": "...", "logic": "...", "output_path": "..." }
  }
}
```

`status` is written as `"draft"` here and is flipped to `"pending_audit"` by
Phase 6. Downstream skills gate on `status == "complete"` (set by env-manager
after audit passes), so an un-audited configuration is inert rather than
silently authoritative.

`backend_hint` records whether an existing `EnvBackend` (`local`/`remote`/`vast`/
`modal`/`docker`) covers this environment. When it does, the generated scripts
call `env-helper.js` and inherit its retry/sync behavior. When it is `custom`,
the scripts issue the commands directly. **No ARIS source file is edited either way.**

### 5b. The seven scripts

Each is POSIX `sh`, `set -eu`, reads `env.json` via `jq`, and accepts
`--dry-run` (print the command, execute nothing). All must be executable
(`chmod +x`).

**`prepare.sh`** — three steps:

1. **Sync** — transfer code per `preparation.files`.
   When `location == "remote"`, use `ssh_alias` from `preparation.files.ssh_alias`
   (read from env.json, not hardcoded) for rsync/scp/git operations.
2. **Build** — if `preparation.environment.build_cmd` is set, run the build
   command on the execution machine. Incremental build is fine.
   If `build_cmd` is empty, skip this step (code runs directly).
3. **Verify** — run `preparation.environment.verify_cmd`. Non-zero exit
   means do not proceed to `run.sh`.

**`run.sh <exp_name> [--gpu N] [--args "..."] [--entry-point <path>]`** —
substitute into `run.template` and launch. Prints the resolved command before
executing so the log records exactly what ran.

When `--entry-point <path>` is provided, override `run.entry_point` with the
given path. This is used by Phase 5.5 mock baseline to run the generated mock
script instead of the project's real entry point.

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
error patterns in `feedback.error.failure_patterns[]`. Collect:
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
  "resources": {
    "type": "gpu|node|cpu|custom",
    "ids": ["..."],
    "label": "...",
    "bind_env": "...",
    "bind_mode": "env|prefix",
    "free_check": { "cmd": "...", "threshold": 0, "unit": "...", "compare": "lt", "index_by": "physical|positional" },
    "exhaustion_patterns": ["..."]
  },
  "hardware": { "gpu_type": "...", "gpu_count": 0, "device": "cuda|mps|cpu", "gpu_free_threshold_mib": 500 },
  "compute_budget": "...",
  "error_patterns": ["Traceback", "CUDA out of memory", "Killed", "RuntimeError", "No such file"],
  "wandb": { "enabled": false, "project": "...", "entity": "..." },
  "paths": { "remote_path": "...", "result_dir": "results/", "log_dir": "logs/" },
  "connection": {
    "ssh_alias": "<from preparation.files.ssh_alias>",
    "conda_env": "...",
    "conda_hook": "...",
    "transfer": "rsync|git|shared|cli-upload"
  },
  "backend_hint": "local|remote|vast|modal|docker|custom"
}
```

`connection.ssh_alias` is read from `env.json` `preparation.files.ssh_alias`.
It is `null` for local environments.

`resources` is the canonical resource slot config read by `/experiment-queue`
for scheduling. `hardware` is a backward-compatible alias computed from
`resources` when the resource type is `"gpu"` (otherwise `gpu_count: 0`).
Downstream skills that only need GPU metadata can continue reading `hardware`.

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
description: 'Run one experiment for the <project> research project: prepare (sync code + verify dependency environment), run (launch via the frozen command), and feed back (errors, metrics, analysis). Generated by /experiment-env-configuration from a verified PRD — do not re-answer configuration questions, the answers are frozen in env.json. Use whenever an experiment must be executed or re-executed for this project.'
argument-hint: "<exp_name> [— args: ...] [— gpu: N] [— skip-prepare] [— entry-point: <path>]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob
---
```

Body sections, in order:

1. **Frozen configuration** — a human-readable rendering of `env.json`
   (where code lives, which env, the run command, the three feedback channels).
   Marked explicitly: *"These values were verified during configuration.
   Do not re-derive them. To change them, use `/experiment-env-manager`."*
2. **Step 1 — Prepare** — `scripts/prepare.sh`; hard-stop on failure.
   Skippable with `— skip-prepare` when a run in the same session already prepared.
3. **Step 2 — Run** — `scripts/run.sh <exp_name>` with the resolved arguments.
   When `— entry-point: <path>` is provided, pass `--entry-point <path>` to run.sh.
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
   a one-line status (file-paths-only).

---

## Phase 5.5: Establish a Runnable Baseline

**Trigger:** `prd.baseline.kind == "mock"`. When absent or `kind != "mock"`,
skip this phase entirely.

**Prerequisite:** Phase 5 has written all scripts to `$STAGING_DIR/scripts/`.
This phase executes them for real (not dry-run) to prove the environment works
end-to-end before Phase 6 promotes.

1. Generate `.aris/env-config/<project>/mock/smoke_baseline.py` — minimal but
   **real**: import the framework per `preparation.environment`, allocate a
   tensor on the selected device, run ~10 steps on synthetic data, write
   `{"<primary_metric_key>": <float>, "steps": 10}` to
   `results/<exp_name>.json`, print a completion marker, `exit 0`.

2. Execute end-to-end through the **staging** bundle's scripts using the
   `--entry-point` flag to run the mock instead of the project's real entry
   point:
   ```bash
   sh "$STAGING_DIR/scripts/prepare.sh"
   sh "$STAGING_DIR/scripts/run.sh" smoke \
     --entry-point ".aris/env-config/<project>/mock/smoke_baseline.py"
   sh "$STAGING_DIR/scripts/collect.sh" smoke
   ```

3. On success:
   - Record evidence at `.aris/env-config/<project>/mock/SMOKE_RESULT.json`
     + `smoke.log`.
   - **Copy smoke metrics into the staging bundle for env-audit Check P:**
     ```bash
     cp ".aris/env-config/<project>/mock/SMOKE_RESULT.json" \
        "$STAGING_DIR/smoke_baseline.json"
     ```
     This file is promoted alongside the bundle (ends up at
     `$SKILL_DIR/smoke_baseline.json`), so `/experiment-env-audit` Check P
     reads it from `$BUNDLE_DIR/smoke_baseline.json` — the same path in both
     staging and promoted locations.
   - Append a `mock-baseline` row to `refine-logs/EXPERIMENT_TRACKER.md`.

4. On failure: fix the **configuration** (not the mock), up to
   `MAX_VERIFY_RETRIES` = 3 times. Persistent failure means the environment
   genuinely doesn't work → `status: "incomplete"` + hard stop with the real
   error message.

Record in `env.json` (within `$STAGING_DIR`):

```json
"baseline": {
  "kind": "mock|reproduced",
  "script": ".aris/env-config/<project>/mock/smoke_baseline.py",
  "evidence": ".aris/env-config/<project>/mock/SMOKE_RESULT.json",
  "smoke_baseline_path": "smoke_baseline.json",
  "verified_at": "<ISO-8601>"
}
```

When `baseline.kind == "mock"`, the generated skill accepts `— entry-point: <path>`
to override the default entry point. Dry-runs substitute the mock, so Phase 6's
"no unsubstituted `{{placeholder}}`" rule needs no carve-out.

---

## Phase 6: Verify and Promote

### 6a. Syntax verification (in staging)

1. **Scripts are valid shell:** `sh -n` each script in `$STAGING_DIR/scripts/`.
2. **`env.json` parses and is structurally complete:**
   ```bash
   jq -e '.run.template != "" and .feedback.result.primary_metric_key != ""' \
     "$STAGING_DIR/env.json"
   ```
3. **SSH alias consistency (for remote):** when `preparation.files.location == "remote"`,
   verify `preparation.files.ssh_alias` is set and non-empty in `env.json`.
   Also verify `info.sh` output `connection.ssh_alias` matches.

### 6b. Preliminary promotion

Copy the draft to the final path:

```bash
mkdir -p "$(dirname "$SKILL_DIR")"
cp -R "$STAGING_DIR" "$SKILL_DIR"
chmod +x "$SKILL_DIR"/scripts/*.sh
# mark as pending audit — env-manager will flip to "complete" after audit passes
tmp="$SKILL_DIR/env.json.tmp.$$"
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

### 6f. Write receipt

Write the receipt with `status: "pending_audit"`:

```bash
tmp="$SKILL_DIR/env.json.tmp.$$"
jq '.status = "pending_audit"' "$SKILL_DIR/env.json" > "$tmp" && mv "$tmp" "$SKILL_DIR/env.json"
```

The env-manager is responsible for dispatching audit and flipping status to
`"complete"` after audit passes.

### 6g. Demote (on syntax/dry-run failure)

If any step in 6a or 6c fails:

```bash
rm -rf "$SKILL_DIR"
# draft stays in $STAGING_DIR for inspection
```

Report `status: "failed"` with the specific failure.

### 6h. Register in CLAUDE.md (patch mode only)

In patch mode, if the patch modifies fields that are reflected in the
`## Experiment Environment` section of CLAUDE.md, update those fields.

### 6i. Skill is discoverable

`$SKILL_DIR/SKILL.md` exists with valid frontmatter whose `name` matches the
directory name, and `jq -e '.status' "$SKILL_DIR/env.json"` exits 0.

Then print:

```
Experiment environment configured for "<project>".

Generated:
  .claude/skills/run-<project>-experiment/SKILL.md
  .claude/skills/run-<project>-experiment/env.json
  .claude/skills/run-<project>-experiment/scripts/{prepare,run,collect,analyze}.sh

Frozen configuration:
  Files:     <location> → <remote_path> via <transfer>
  SSH:       <ssh_alias or "n/a (local)">
  Env:       <type> "<name>", verified by: <verify_cmd>
  Run:       <entry_point> (<launch_mode>, <gpu_selection>)
  Error:     <signal>, log at <log_path>
  Result:    <primary_metric_key> from <path_template>
  Analysis:  <mode> → <output_path>

Verification:
  Shell syntax:   PASS/FAIL
  Dry runs:       PASS/FAIL
  env.json:       PASS/FAIL
  Status:         pending_audit

Next: env-manager will dispatch audit.
```

When verification fails:

```
Experiment environment NOT configured for "<project>" — verification failed.

Draft (not promoted): .aris/env-config/<project>/draft/
Failure:              <specific error>

Fix the issue in the PRD and re-run.
```

### Receipt file

Write `.aris/runs/<run_id>.experiment-env-configuration.<project>.done.json`:

```json
{
  "skill": "experiment-env-configuration",
  "project": "<project>",
  "mode": "fresh|patch",
  "status": "pending_audit|failed",
  "skill_dir": ".claude/skills/run-<project>-experiment",
  "env_json_path": ".claude/skills/run-<project>-experiment/env.json",
  "scripts_regenerated": ["prepare.sh", "run.sh", "collect.sh", "analyze.sh", "monitor.sh", "info.sh", "teardown.sh"],
  "completed_at": "<ISO-8601>"
}
```

In patch mode, `scripts_regenerated` lists only the scripts that were actually
regenerated (not all seven).

---

## Phase 6.5: Save Exploration to References

**Only runs in fresh mode after Phase 6 promotes successfully.**

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

## Patch Mode

When `— patch: <path>` is provided:

1. **Read existing config.** Load `$SKILL_DIR/env.json`. If it does not exist,
   error exit: "No existing config to patch. Use `— prd` for fresh configuration."

2. **Parse patch JSON.** Expected format:
   ```json
   {
     "mode": "patch", "project": "...", "patch_id": "<uuid>",
     "changes": [
       { "field": "preparation.environment.build_cmd", "value": "pip install -e ." },
       { "field": "feedback.error.failure_patterns", "action": "append", "value": ["OOMError"] },
       { "field": "preparation.files.ssh_alias", "value": "my-server" }
     ],
     "reason": "audit check O: build step missing"
   }
   ```
   `action` defaults to `"set"` (replace). `"append"` appends to an existing array.

   **Validation:** reject patches with:
   - Empty or missing `patch_id`
   - Empty `changes[]` array
   - Any `changes[]` entry with an empty `field` or missing `value`
   - Any `value` that is unresolved prose (e.g., "MANAGER_MUST_DERIVE")

3. **Apply changes.** For each entry in `changes[]`, set or append the value
   at the specified `field` path in the existing `env.json`.

4. **Determine affected scripts.** Use the field-to-script mapping:

   | env.json path prefix | Affected scripts |
   |---|---|
   | `preparation.files.*` | `prepare.sh`, `info.sh` |
   | `preparation.environment.*` | `prepare.sh` |
   | `resources.*` | `info.sh` |
   | `run.*` | `run.sh` |
   | `feedback.error.*` | `collect.sh`, `analyze.sh` |
   | `feedback.result.*` | `collect.sh` |
   | `feedback.analysis.*` | `analyze.sh` |

5. **Regenerate only affected scripts** from the updated `env.json` values.
   Leave unaffected scripts untouched.

6. **Promote.** Write the updated `env.json` and regenerated scripts to
   `$SKILL_DIR`. Set `status: "pending_audit"`.

7. **Write receipt** with `mode: "patch"`, `status: "pending_audit"`, and
   `scripts_regenerated: [<only the affected scripts>]`.

---

## Constants

- **SKILL_DIR_TEMPLATE** = `.claude/skills/run-<project>-experiment`
- **STAGING_DIR_TEMPLATE** = `.aris/env-config/<project>/draft`
- **CONFIG_VERSION** = 1
- **DEFAULT_EXCLUDES** = `.git, __pycache__, results/, logs/, checkpoints/, *.pt, *.ckpt, data/`
- **DEFAULT_FAILURE_PATTERNS** = `Traceback`, `CUDA out of memory`, `Killed`, `AssertionError`, `RuntimeError`, `No such file`
- **MAX_VERIFY_RETRIES** = 3
- **REF_DIR_TEMPLATE** = `$CLAUDE_SKILL_DIR/references` → `.claude/skills/experiment-env-configuration/references`
- **MOCK_DIR_TEMPLATE** = `.aris/env-config/<project>/mock`
- **HANDLE_DIR** = `handles/` (inside the generated skill directory)

## Critical Rules

1. **This skill has no user interaction.** All input comes from the PRD or
   patch file. There are no `AskUserQuestion` calls, no interactive Q&A, no
   prompts for user confirmation. If a required field is missing from the
   PRD, the skill errors out — it does not ask for the missing value.
2. **Audit is handled by env-manager.** This skill writes `pending_audit`
   and stops. It does not dispatch any sub-agents, does not invoke
   `/experiment-env-audit` or `/experiment-audit`, and does not gate on
   audit verdicts. The env-manager dispatches audit separately and handles
   the `pending_audit` → `complete` transition.
3. **Never write to the ARIS repo.** Every artifact goes under the project's
   `.claude/skills/run-<project>-experiment/`. The environment is project data.
4. **Never guess a run command.** If the PRD does not provide `run.entry_point`
   or `run.template`, error exit. A guessed command wastes GPU hours and
   produces results that look real.
5. **Prefer an existing backend.** If `local`/`remote`/`vast`/`modal`/`docker`
   covers the environment, set `backend_hint` and call `env-helper.js` from the
   generated scripts. Only fall back to `custom` direct commands when none fits.
6. **Analysis is driven by `/analyze-results`.** `analyze.sh` Stage 2 provides
   data collection; `/analyze-results` owns the analysis logic, iterates until
   a cross-model verifier passes, and can trigger supplementary experiments.
   Never duplicate analysis logic that belongs in `/analyze-results`.
7. **The primary metric key must match `CLAUDE.md` `## Metric Target`.** A
   mismatch silently breaks every downstream Type-A stop check. Verify in Phase 6.
8. **Every generated script supports `--dry-run`** and is verified with it before
   this skill reports success.
9. **File-paths-only receipts.** The generated skill writes
   `.aris/runs/<run_id>.experiment.<exp_name>.done.json`; the dispatching parent
   reads that file, never the agent's prose.
10. **Downstream skills use the 7-script interface, not internal files.**
    `.aris/experiment-env.json` and `env-helper.js` are internal implementation
    details of the generated scripts. Downstream skills (`/monitor-experiment`,
    `/experiment-queue`, `/experiment-bridge`, `/auto-review-loop`,
    `/experiment-plan`, `/ablation-planner`) call the scripts (`prepare.sh`,
    `run.sh`, `collect.sh`, `analyze.sh`, `monitor.sh`, `info.sh`,
    `teardown.sh`) and read the structured JSON output — never the internals.
11. **References are an accelerator, not a requirement.** The skill runs
    correctly without `references/index.md`. It creates the directory and
    index on first successful configuration.
12. **A mock baseline is not a guess.** It is generated by this skill, executed
    end-to-end in the real environment, and verified with real output. Freezing
    a command that was never executed — in any mode — is still forbidden (Rule 4).
13. **Slug normalization.** Project slug derivation collapses consecutive
    non-alphanumerics to a single `-` and strips leading/trailing `-`.
    `Foo__Bar!` → `foo-bar`. This matches the env-manager's algorithm.
14. **Validate patch input.** Reject patches with empty patch_id, empty changes,
    or unresolved prose values before mutation.

## External dependencies (reused, not modified)

- `src/tools/experiment-env/env-helper.ts` — `provision | sync | deploy | monitor | collect | destroy`.
  Used by generated scripts when `backend_hint != "custom"`.
- `src/tools/experiment-env/parse-env.ts` — `ENV_TYPES` / `ENV_SCHEMAS`; read to
  decide whether an existing backend covers the environment.
- `skills/analyze-results/SKILL.md` — the default analysis implementation.
- `skills/run-experiment/SKILL.md` — the transport-level runner; the generated
  skill wraps it rather than replacing it.
- `skills/shared-references/integration-contract.md` section 2 — helper resolution chain.
- `references/index.md` — experience cache; written after successful
  configuration, read at Phase 4.5 to seed similar environments.
