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
Phase 4    Read feedback config from PRD (error, result) + monitor config
Phase 4.5  Transport config — write .aris/experiment-env.json (internal) + CLAUDE.md env block
Phase 5    Emit the project-local skill bundle (router SKILL.md + lib/ + ops/ + env.json)
Phase 5.5  Establish runnable baseline (simple baseline if PRD specifies) — requires Phase 5 scripts
Phase 6    Verify and promote: syntax check + dry-runs → finalize, print summary
```

**What gets written (all inside the PROJECT, never the ARIS repo):**

| # | Path | Contents |
|---|------|----------|
| 1 | `.claude/skills/run-<project>-experiment/SKILL.md` | Short op router: one operation per invocation |
| 2 | `.claude/skills/run-<project>-experiment/env.json` | Frozen answers (the config of record, v2) |
| 3 | `.claude/skills/run-<project>-experiment/scripts/lib/env.sh` | Shared library: env.json read, backend dispatch, handle IO |
| 4 | `.claude/skills/run-<project>-experiment/scripts/ops/env-info.sh` | Static environment metadata JSON |
| 5 | `.claude/skills/run-<project>-experiment/scripts/ops/query-resources.sh` | Live free-resource query |
| 6 | `.claude/skills/run-<project>-experiment/scripts/ops/sync-code.sh` | Transfer code to the execution machine |
| 7 | `.claude/skills/run-<project>-experiment/scripts/ops/build-env.sh` | Build + verify the dependency environment |
| 8 | `.claude/skills/run-<project>-experiment/scripts/ops/launch-job.sh` | Launch one job; write handle |
| 9 | `.claude/skills/run-<project>-experiment/scripts/ops/job-status.sh` | Job status + resource consumption JSON |
| 10 | `.claude/skills/run-<project>-experiment/scripts/ops/job-logs.sh` | Job log query (tail/since/full) |
| 11 | `.claude/skills/run-<project>-experiment/scripts/ops/collect-outputs.sh` | Pull back results + logs; write enriched receipt |
| 12 | `.claude/skills/run-<project>-experiment/scripts/ops/stop-job.sh` | Stop one running job |
| 13 | `.claude/skills/run-<project>-experiment/scripts/ops/release-resources.sh` | Release environment resources |
| 14 | `.claude/skills/run-<project>-experiment/handles/` | Per-experiment handle JSON files |
| 15 | `.aris/env-config/<project>/receipt.json` | Configuration receipt |

Each op is a **process-invariant operation**: it moves files, launches
processes, or reads state — it never analyzes results. Analysis (convergence,
divergence, training dynamics, comparisons) lives in `/analyze-results` and its
sub-skills, never in the generated bundle.

Rows 1–14 are written to a **staging directory first** and only moved into
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
   Validate against `/^[a-z0-9][a-z0-9-]*$/`; if it fails, stop and report the invalid project slug.

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

`collect-outputs.sh` greps these patterns and surfaces matching lines. A silent
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

### 4c. Monitor config — how is a running job watched?

```
Read `prd.monitor.interval_cron`          → set interval_cron
Read `prd.monitor.escalate_cron`          → set escalate_cron
Read `prd.monitor.max_hours`              → set max_hours
Read `prd.monitor.early_stop`             → set early_stop
Read `prd.monitor.stall`                  → set stall
```

**Defaults when omitted:**
- `interval_cron`: `"*/20 * * * *"` (every 20 minutes, off the :00/:30 marks)
- `escalate_cron`: `"23 * * * *"` (hourly after 6 healthy ticks)
- `max_hours`: `48`
- `early_stop`: `{ "enabled": false }` — when enabled, carries
  `max_training_time_hours`, `convergence {enabled, patience, min_delta}`,
  `divergence {enabled, threshold_multiplier}`, `entropy_collapse {enabled,
  threshold}` (same shape `/research-setup` collects). These conditions are
  **inputs to the analysis sub-skills**, not enforced by the ops — the ops and
  the heartbeat wake contract only surface machine-checkable facts.
- `stall`: `{ "no_log_growth_minutes": 45, "gpu_idle_threshold_pct": 5,
  "consecutive_alert_ticks": 3 }`

Record `monitor = { interval_cron, escalate_cron, max_hours, early_stop, stall }`.

**Analysis is NOT configured here.** Analysis (convergence, training dynamics,
comparisons, W&B interpretation) is owned by `/analyze-results` and its
sub-skills under `skills/analyze-results-tools/`. The generated bundle only
freezes where results and logs land (`feedback.*`) so analysis sub-skills can
find them.

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

---

## Phase 5: Emit the Project-Local Skill Bundle

Everything below is written under `$STAGING_DIR` = `.aris/env-config/<project>/draft/`
in the **project**, NOT into `.claude/skills/` yet. The bundle is promoted after
Phase 6 verification passes.

### 5a. `env.json` — the config of record (v2)

```json
{
  "version": 2,
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
    "result": { "path_template": "...", "format": "...", "primary_metric_key": "...", "extra_keys": ["..."] }
  },
  "monitor": {
    "interval_cron": "*/20 * * * *",
    "escalate_cron": "23 * * * *",
    "max_hours": 48,
    "early_stop": { "enabled": false },
    "stall": { "no_log_growth_minutes": 45, "gpu_idle_threshold_pct": 5, "consecutive_alert_ticks": 3 }
  }
}
```

`status` is written as `"draft"` here and is flipped to `"pending_audit"` by
Phase 6. Downstream skills gate on `status == "complete"` (set by env-manager
after audit passes), so an un-audited configuration is inert rather than
silently authoritative.

`backend_hint` records whether an existing `EnvBackend` (`local`/`remote`/`vast`/
`modal`/`docker`) covers this environment. When it does, the generated ops
call `env-helper.js` and inherit its retry/sync behavior. When it is `custom`,
the ops issue the commands directly. **No ARIS source file is edited either way.**

`monitor` is read by `/run-experiment` Step 5.5 (heartbeat arming) and by the
monitor wake contract in the router SKILL.md. It is NOT read by any op except
`job-status.sh` surfacing facts (elapsed time vs max_hours, log mtime age)
without judging them.

### 5b. The shared library and the ten ops

Every script under `scripts/` is POSIX `sh`, `set -eu`, reads `env.json` via
`jq`, and accepts `--dry-run` (print the command, execute nothing). All must
be executable (`chmod +x`). Each op sources `scripts/lib/env.sh`.

#### The shared library — `scripts/lib/env.sh`

Provides, as POSIX sh functions (no analysis logic, ever):

- `env_load` — locate and validate `env.json` (walks up from the script dir)
- `env_get <jq-path>` — read one config value
- `backend_run <remote-cmd>` — run a command on the execution machine
  (`backend_hint != "custom"` → `env-helper.js` transport; else direct ssh/local)
- `handle_write <exp_name> <pid_or_session> <gpu>` / `handle_read <exp_name>` —
  atomic JSON handle IO under `handles/`
- `json_out <exit_code> <payload>` — emit the op's result JSON to stdout on
  success, or the structured error JSON to stderr on failure (see 5b.0)
- `dry_run_guard` — when `--dry-run` is set, print the command and exit 0

#### 5b.0 — The uniform op exit contract (failure-recovery entry point)

Every op follows the same exit contract. This is what makes the unified repair
loop possible — callers never write per-op failure handling.

- **Success:** exit 0; a single JSON object on **stdout**.
- **Failure:** exit non-zero; a structured error JSON on **stderr**:

```json
{
  "op": "sync-code",
  "exit_code": 1,
  "stderr_tail": ["<last 20 lines of stderr>"],
  "failure_patterns_matched": ["<any feedback.error.failure_patterns hit>"],
  "handle": "handles/<exp>.json"
}
```

`handle` is present only for ops that had already launched something
(`launch-job`). Ops must guarantee this JSON even when the underlying command
dies mid-write (build it in a temp file, then emit).

#### The ten ops — `scripts/ops/`

**`env-info.sh`** — static environment metadata as a single JSON object on
stdout. Downstream skills call this instead of reading `env.json` directly:

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

`connection.ssh_alias` is `null` for local environments. `resources` is the
canonical resource slot config read by `/experiment-queue` for scheduling;
`hardware` is the resource view computed from `resources` when the resource type
is `"gpu"`. `/experiment-plan` reads `hardware`; `/experiment-bridge`
reads `error_patterns` and `wandb`; `/experiment-queue` reads `connection`.

**`query-resources.sh`** — live free-resource query. Runs
`resources.free_check.cmd` on the execution machine, filters by
`threshold`/`compare`/`index_by`, and outputs:

```json
{ "queried_at": "<ISO-8601>", "free_ids": [0, 1], "per_slot": [ { "id": 0, "value": 120, "unit": "mib" } ] }
```

**`sync-code.sh`** — transfer code per `preparation.files` (rsync/scp/git via
`ssh_alias` read from env.json, never hardcoded). Output: `{ "synced": true,
"files": <count>, "excludes": [...] }`. Fails (per 5b.0) when the transfer
command exits non-zero.

**`build-env.sh`** — build + verify, one closed loop:
1. If `preparation.environment.build_cmd` is set, run it on the execution
   machine (incremental is fine). If empty, skip.
2. Run `preparation.environment.verify_cmd`. Non-zero exit fails the op —
   do not proceed to `launch-job.sh`.

Output: `{ "built": true, "verified": true }`.

**`launch-job.sh <exp_name> [--gpu N] [--args "..."] [--print-command]`** —
substitute into `run.template` and launch. Prints the resolved command before
executing so the log records exactly what ran. `--args` replaces the default
run arguments (used by Phase 5.5's simple baseline). `--print-command` prints
the resolved command **without launching** — consumed by `queue-manager.ts`
so the queue renders commands through the same frozen template instead of
re-assembling its own.

Saves the handle to `handles/<exp_name>.json`:
```json
{ "exp_name": "...", "pid_or_session": "...", "gpu": 0, "launched_at": "<ISO-8601>" }
```
Output: `{ "exp_name": "...", "handle": "handles/<exp>.json", "command": "<resolved>" }`.

**`job-status.sh [<exp_name>] [--queue <run_dir>]`** — status + resource
consumption of a running job. Reads the handle from `handles/<exp_name>.json`;
with no argument, uses the newest handle. `--queue` reads a
`queue_manager`-produced `queue_state.json` (read-only) and reports per-job
status. Outputs a single JSON object:

```json
{
  "status": "running|done|failed|unknown",
  "exit_code": null,
  "gpu_usage": { "memory_used_mib": 0, "utilization_pct": 0 },
  "elapsed_seconds": 0,
  "log_age_seconds": 0,
  "max_hours": 48,
  "session_alive": true,
  "wandb": { "run_id": "...", "url": "...", "project": "...", "entity": "..." }
}
```

`elapsed_seconds`, `log_age_seconds`, `max_hours`, `session_alive` are
**facts surfaced for the heartbeat wake contract** — this op never decides
whether the job should stop. The W&B query (when `wandb.enabled`) is done
internally using config from `env.json`.

**`job-logs.sh <exp_name> [--tail N] [--since <duration>] [--full]`** — log
query. Defaults to the last 20 lines. `--full` emits the entire log (failure
diagnosis needs the whole trace; status polling needs only the tail). Output:
`{ "exp_name": "...", "log_path": "...", "lines": ["..."] }`.

**`collect-outputs.sh <exp_name>`** — pull back
`feedback.error.log_path` and `feedback.result.path_template`; grep the log for
`failure_patterns`; print a verdict line: `RESULT ok <primary_metric>=<value>`
or `RESULT failed <first matching pattern>`. Also gathers the full error-log
context (stack traces ±5 lines, deduplicated summary) into
`<output_dir>/error_report.md` — data collection only, no interpretation.

Writes the enriched receipt to `.aris/runs/<run_id>.experiment.<exp_name>.done.json`:

```json
{
  "exp_name": "...",
  "status": "ok|failed",
  "primary_metric": null,
  "metrics": {},
  "result_files": [{ "path": "...", "format": "json", "experiment": "..." }],
  "result_path": "...",
  "log_path": "...",
  "error_report": "<output_dir>/error_report.md",
  "failure_reason": null,
  "failure_patterns_matched": [],
  "gpu_usage": { "memory_used_mib": 0, "utilization_pct": 0 },
  "wandb": null,
  "handle": "handles/<exp>.json",
  "elapsed_seconds": 0,
  "completed_at": "<ISO-8601>"
}
```

`result_files` is the manifest `/analyze-results` reads as input — analysis
sub-skills start from this list, so no separate manifest script is needed.
This receipt is the single input record for downstream analysis; it contains
the environment, result paths, metrics, and failure details needed by the
analysis skills.

**`stop-job.sh <exp_name> [--force]`** — stop one running job. `screen -X
quit` / `tmux kill-session` / `kill <pid>` / `modal app stop` per handle +
`launch_mode`. `--force` escalates to `kill -9`. Output:
`{ "exp_name": "...", "stopped": true }`. Used by the heartbeat wake contract
(machine-checkable early stop), the repair loop, and manual intervention.

**`release-resources.sh [--force]`** — release environment resources. For
`vast`: destroy the instance; for `modal`: stop the app; for `docker`: stop
and remove the container; for `remote`/`local`: no-op (or kill stale screen
sessions with `--force`). Exit 0 on success, 1 on failure.

### 5c. `SKILL.md` — the op router

Frontmatter:

```yaml
---
name: run-<project>-experiment
description: 'One experiment operation per invocation for the <project> research project: env-info, query-resources, sync-code, build-env, launch-job, job-status, job-logs, collect-outputs, stop-job, release-resources. Process operations only — analysis lives in /analyze-results. Generated by /experiment-env-configuration from a verified PRD — answers are frozen in env.json; change them via /experiment-env-manager.'
argument-hint: "<operation> [args] — exactly one operation per invocation"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob
---
```

Body sections, in order:

1. **Frozen configuration** — a human-readable rendering of `env.json`
   (where code lives, which env, the run command, the feedback channels,
   the monitor block). Marked explicitly: *"These values were verified during
   configuration. Do not re-derive them. To change them, use
   `/experiment-env-manager`."*
2. **Operations table** — one row per op: name, invocation, stdout contract,
   side effects. The rule: **exactly one operation per invocation**; run the
   script, report its JSON or verdict line, stop. Never chain ops in one
   invocation.
3. **Op failure routing** (verbatim, so every caller inherits it):

   ```
   When an op exits non-zero:
   1. Read the structured error JSON from the op's stderr.
   2. Write it to .aris/env-config/<project>/error-reports/<TS>.json
      (fields: op, exit_code, stderr_tail, failure_patterns_matched, handle?).
   3. Dispatch /experiment-env-manager — mode: error-report — error-report: <path>
      as a paseo sub-agent. The CALLER performs the dispatch; this generated
      skill never spawns agents itself (it has no agent-spawning tools).
   4. env-manager classifies:
      - transient        → retry the same op (≤3 times, 30s backoff)
      - env-recoverable  → patch env.json → regenerate affected ops → retry
      - signal-kill / code-bug → stop and surface upward (do not retry)
   5. On env-manager receipt result == "fixed": retry the op once.
      On "not_env_issue" or "escalated": stop and report the error report path.
   Never hand-edit env.json or the ops to work around a failure.
   ```

4. **Monitor wake contract** (verbatim — this text is what a monitoring
   heartbeat's prompt contains; it judges machine-checkable facts only):

   ```
   Run: sh <skill_dir>/scripts/ops/job-status.sh <exp_name>
   Then decide, purely from the returned JSON:
   - status done|failed → run ops/collect-outputs.sh <exp_name>; the receipt at
     .aris/runs/<run_id>.experiment.<exp>.done.json is the result; report
     file-paths-only and stop.
   - session_alive false, or elapsed_seconds > max_hours*3600, or
     (gpu utilization < monitor.stall.gpu_idle_threshold_pct AND
      log_age_seconds > monitor.stall.no_log_growth_minutes*60) for
     monitor.stall.consecutive_alert_ticks ticks → run ops/stop-job.sh
     <exp_name>, then ops/collect-outputs.sh <exp_name>; receipt status is
     "early_stopped" with the reason; report and stop.
   - anything else (including suspected NaN/divergence you are unsure about) →
     append one line {ts, status, elapsed_seconds} to
     .aris/runs/<run_id>.monitor.jsonl and stop. Suspected-quality signals are
     a FACT to record, never a verdict — analysis belongs to /analyze-results
     after the job terminates.
   Never: judge quality, compare against baselines, launch new jobs, or
   prompt other agents.
   ```

5. **Rules** — one op per invocation; file-paths-only reports; never edit
   `env.json` or the ops; analysis is `/analyze-results`'s job, never this skill's.

---

## Phase 5.5: Establish a Runnable Baseline

**Trigger:** `prd.baseline.kind == "simple"` (legacy PRDs that say `"mock"`
are treated as `"simple"`). When absent or `kind` is anything else, skip this
phase entirely.

**What a simple baseline is:** one real run of the project's own
`run.entry_point` at reduced scale (whatever `prd.baseline.simple_args`
specifies — fewer steps, fewer epochs, a small data subset), executed
through the same ops a normal experiment uses. The metric it produces is
genuine output of the actual method at small scale — never a synthetic
script or an invented number. It proves the environment end-to-end AND seeds
`refine-logs/EXPERIMENT_TRACKER.md` with a real data point. It is NOT the
paper baseline: `/auto-research-loop` iteration 1 still reproduces the full
baseline.

**Prerequisite:** Phase 5 has written all scripts to `$STAGING_DIR/scripts/`.
This phase executes them for real (not dry-run) to prove the environment works
end-to-end before Phase 6 promotes.

1. Resolve the reduced-scale arguments from `prd.baseline.simple_args`. If it
   is absent or empty, do NOT guess a scale-down — ask the user
   (AskUserQuestion, forwarded through paseo) for the smallest meaningful run
   of the real entry point, then record the answer.

2. Execute end-to-end through the **staging** bundle's ops, launching the
   project's real entry point with the simple args:
   ```bash
   sh "$STAGING_DIR/scripts/ops/sync-code.sh"
   sh "$STAGING_DIR/scripts/ops/build-env.sh"
   sh "$STAGING_DIR/scripts/ops/launch-job.sh" simple-baseline \
     --args "<prd.baseline.simple_args>"
   sh "$STAGING_DIR/scripts/ops/collect-outputs.sh" simple-baseline
   ```

3. On success:
   - Record evidence: copy the collected result (the artifact resolved from
     `feedback.result.path_template` for exp `simple-baseline`) and the run
     log into `.aris/env-config/<project>/baseline/` as `RUN_RESULT.json`
     and `run.log`.
   - **Copy the result into the staging bundle for env-audit Check P:**
     ```bash
     cp ".aris/env-config/<project>/baseline/RUN_RESULT.json" \
        "$STAGING_DIR/simple_baseline.json"
     ```
     This file is promoted alongside the bundle (ends up at
     `$SKILL_DIR/simple_baseline.json`), so `/experiment-env-audit` Check P
     reads it from `$BUNDLE_DIR/simple_baseline.json` — the same path in
     both staging and promoted locations.
   - Append a `simple-baseline` row to `refine-logs/EXPERIMENT_TRACKER.md`,
     recording the scale (e.g., "100 steps") so nobody mistakes the number
     for the full baseline.

4. On failure: fix the **configuration** (not the entry point), up to
   `MAX_VERIFY_RETRIES` = 3 times. Persistent failure means the environment
   genuinely doesn't work -> `status: "incomplete"` + hard stop with the real
   error message.

Record in `env.json` (within `$STAGING_DIR`):

```json
"baseline": {
  "kind": "simple|reproduced",
  "args": "<the reduced-scale args that ran>",
  "evidence": ".aris/env-config/<project>/baseline/RUN_RESULT.json",
  "simple_baseline_path": "simple_baseline.json",
  "verified_at": "<ISO-8601>"
}
```

Dry-runs substitute the real template with the simple args, so Phase 6's
"no unsubstituted `{{placeholder}}`" rule needs no carve-out.

---

## Phase 6: Verify and Promote

### 6a. Syntax verification (in staging)

1. **Scripts are valid shell:** `sh -n` every script in `$STAGING_DIR/scripts/`
   (lib + all ops).
2. **`env.json` parses and is structurally complete:**
   ```bash
   jq -e '.version == 2 and .run.template != "" and .feedback.result.primary_metric_key != "" and (.monitor.interval_cron | test("\\*"))' \
     "$STAGING_DIR/env.json"
   ```
3. **SSH alias consistency (for remote):** when `preparation.files.location == "remote"`,
   verify `preparation.files.ssh_alias` is set and non-empty in `env.json`.
   Also verify `ops/env-info.sh` output `connection.ssh_alias` matches.

### 6b. Preliminary promotion

Copy the draft to the final path:

```bash
mkdir -p "$(dirname "$SKILL_DIR")"
cp -R "$STAGING_DIR" "$SKILL_DIR"
chmod +x "$SKILL_DIR"/scripts/lib/*.sh "$SKILL_DIR"/scripts/ops/*.sh
# mark as pending audit — env-manager will flip to "complete" after audit passes
tmp="$SKILL_DIR/env.json.tmp.$$"
jq '.status = "pending_audit"' "$SKILL_DIR/env.json" > "$tmp" && mv "$tmp" "$SKILL_DIR/env.json"
```

### 6c. Dry-run verification (at promoted path)

```bash
for op in env-info query-resources sync-code build-env launch-job job-status job-logs collect-outputs stop-job release-resources; do
  sh "$SKILL_DIR/scripts/ops/${op}.sh" --dry-run 2>/dev/null || true
done
sh "$SKILL_DIR/scripts/ops/env-info.sh" > /dev/null
```

Side-effecting ops must print a plausible command under `--dry-run` — no
unsubstituted `{{placeholder}}` may survive. Read-only ops (`env-info`,
`query-resources`, `job-status`, `job-logs`) are safe to run for real. If any
check fails, demote (step 6g) and report.

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
  .claude/skills/run-<project>-experiment/scripts/lib/env.sh
  .claude/skills/run-<project>-experiment/scripts/ops/{env-info,query-resources,sync-code,build-env,launch-job,job-status,job-logs,collect-outputs,stop-job,release-resources}.sh

Frozen configuration:
  Files:     <location> → <remote_path> via <transfer>
  SSH:       <ssh_alias or "n/a (local)">
  Env:       <type> "<name>", verified by: <verify_cmd>
  Run:       <entry_point> (<launch_mode>, <gpu_selection>)
  Error:     <signal>, log at <log_path>
  Result:    <primary_metric_key> from <path_template>
  Monitor:   every <interval_cron>, escalate to <escalate_cron>, cap <max_hours>h

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
  "scripts_regenerated": ["lib/env.sh", "ops/env-info.sh", "ops/query-resources.sh", "ops/sync-code.sh", "ops/build-env.sh", "ops/launch-job.sh", "ops/job-status.sh", "ops/job-logs.sh", "ops/collect-outputs.sh", "ops/stop-job.sh", "ops/release-resources.sh"],
  "completed_at": "<ISO-8601>"
}
```

In patch mode, `scripts_regenerated` lists only the scripts that were actually
regenerated (not all eleven).


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

4. **Determine affected ops.** Use the field-to-op mapping:

   | env.json path prefix | Affected ops |
   |---|---|
   | `preparation.files.*` | `sync-code.sh`, `env-info.sh` |
   | `preparation.environment.*` | `build-env.sh` |
   | `resources.*` | `env-info.sh`, `query-resources.sh` |
   | `run.*` | `launch-job.sh` |
   | `feedback.error.*` | `collect-outputs.sh`, `job-logs.sh` |
   | `feedback.result.*` | `collect-outputs.sh` |
   | `monitor.*` | `job-status.sh` (facts surfacing) |

   **Version requirement:** patches apply only to `env.json` version `2`. For
   any other version, stop and regenerate the bundle from the current schema;
   preserve `handles/` in place.

5. **Regenerate only affected ops** from the updated `env.json` values.
   Leave unaffected scripts untouched. When a patched field changes what a
   previously generated op renders (e.g. a new `ssh_alias`), also refresh
   `lib/env.sh` when `backend_hint` changed.

6. **Promote.** Write the updated `env.json` and regenerated scripts to
   `$SKILL_DIR`. Set `status: "pending_audit"`.

7. **Write receipt** with `mode: "patch"`, `status: "pending_audit"`, and
   `scripts_regenerated: [<only the affected scripts>]`.

---

## Constants

- **SKILL_DIR_TEMPLATE** = `.claude/skills/run-<project>-experiment`
- **STAGING_DIR_TEMPLATE** = `.aris/env-config/<project>/draft`
- **CONFIG_VERSION** = 2
- **OPS** = `env-info`, `query-resources`, `sync-code`, `build-env`, `launch-job`, `job-status`, `job-logs`, `collect-outputs`, `stop-job`, `release-resources`
- **DEFAULT_EXCLUDES** = `.git, __pycache__, results/, logs/, checkpoints/, *.pt, *.ckpt, data/`
- **DEFAULT_FAILURE_PATTERNS** = `Traceback`, `CUDA out of memory`, `Killed`, `AssertionError`, `RuntimeError`, `No such file`
- **MAX_VERIFY_RETRIES** = 3
- **BASELINE_DIR_TEMPLATE** = `.aris/env-config/<project>/baseline`
- **HANDLE_DIR** = `handles/` (inside the generated skill directory)
- **DEFAULT_MONITOR** = `{ interval_cron: "*/20 * * * *", escalate_cron: "23 * * * *", max_hours: 48, early_stop: {enabled: false}, stall: {no_log_growth_minutes: 45, gpu_idle_threshold_pct: 5, consecutive_alert_ticks: 3} }`

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
5. **Use one explicit backend.** If `local`/`remote`/`vast`/`modal`/`docker`
   covers the environment, set `backend_hint` and call `env-helper.js` from the
   generated scripts. Use `custom` only when the PRD explicitly selects it and
   provides its commands; never infer it after another backend fails.
6. **Analysis is driven by `/analyze-results`.** `collect-outputs.sh` provides
   data collection (the `result_files` manifest in its receipt);
   `/analyze-results` and its sub-skills (`skills/analyze-results-tools/`)
   own all analysis logic, iterate until a cross-model verifier passes, and can
   trigger supplementary experiments. Never duplicate analysis logic that
   belongs in `/analyze-results` — see also Rule 15.
7. **The primary metric key must match `CLAUDE.md` `## Metric Target`.** A
   mismatch silently breaks every downstream Type-A stop check. Verify in Phase 6.
8. **Every generated script supports `--dry-run`** and is verified with it before
   this skill reports success.
9. **File-paths-only receipts.** The generated skill writes
   `.aris/runs/<run_id>.experiment.<exp_name>.done.json`; the dispatching parent
   reads that file, never the agent's prose.
10. **Downstream skills use the op interface, not internal files.**
    `.aris/experiment-env.json` and `env-helper.js` are internal implementation
    details of the generated ops. Downstream skills (`/run-experiment`,
    `/experiment-queue`, `/experiment-bridge`, `/auto-review-loop`,
    `/experiment-plan`, `/ablation-planner`, `/analyze-results`) invoke the
    generated router skill or call `scripts/ops/<name>.sh` directly and read
    the structured JSON output — never the internals.
11. **A simple baseline is a real run, not a mock.** It is the project's own
    entry point executed at reduced scale through the configured environment,
    and verified with its real output. Synthetic scripts with invented metrics
    are forbidden. Freezing a command that was never executed — in any mode —
    is still forbidden (Rule 4).
12. **Slug normalization.** Project slug derivation collapses consecutive
    non-alphanumerics to a single `-` and strips leading/trailing `-`.
    `Foo__Bar!` → `foo-bar`. This matches the env-manager's algorithm.
13. **Validate patch input.** Reject patches with empty patch_id, empty changes,
    or unresolved prose values before mutation.
14. **Ops are process-invariant only.** No op analyzes results — convergence,
    divergence, training-dynamics interpretation, and comparisons live in
    `/analyze-results` and its sub-skills. An op may collect and surface facts
    (metrics, log lines, elapsed time); it never interprets them.
15. **Uniform failure contract.** Every op emits the structured error JSON on
    stderr per 5b.0. The failure-recovery loop (`/experiment-env-manager`
    `— mode: error-report`) depends on this shape; an op that fails without it
    breaks the repair loop for every caller.

## External dependencies (reused, not modified)

- `src/tools/experiment-env/env-helper.ts` — `provision | sync | deploy | monitor | collect | destroy`.
  Used by generated ops when `backend_hint != "custom"`.
- `src/tools/experiment-env/parse-env.ts` — `ENV_TYPES` / `ENV_SCHEMAS`; read to
  decide whether an existing backend covers the environment.
- `skills/analyze-results/SKILL.md` + `skills/analyze-results-tools/*` — all
  analysis; the generated bundle's `collect-outputs.sh` receipt feeds them.
- `skills/run-experiment/SKILL.md` — the transport-level runner; the generated
  skill wraps it rather than replacing it.
- `skills/shared-references/integration-contract.md` section 2 — helper resolution chain.
