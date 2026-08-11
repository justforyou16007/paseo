# Worker Manifest Protocol

This document defines the contract between orchestrator skills (e.g.,
`/auto-research-loop`, `/research-pipeline`) and their worker sub-agents.

## Purpose

Orchestrators must keep bounded context growth across iterations. The manifest
protocol achieves this by:

1. Orchestrators write a **manifest** file listing all inputs a worker needs
2. Workers read the manifest on startup — self-sufficient, no orchestrator context dependency
3. Workers write a **receipt** with a `dashboard_patch` — telling the orchestrator
   exactly how to update its state, without the orchestrator reading output files

## Directory Structure

```
.aris/runs/<run_id>/
├── dashboard.json                   ← orchestrator's single state source
├── workers/
│   ├── <iter>-<phase>/
│   │   ├── input-manifest.json      ← written by orchestrator before dispatch
│   │   ├── receipt.json             ← written by worker on completion
│   │   ├── progress_error.md    ← system error log (append-only, one line per error)
│   │   └── outputs/                 ← worker's complete output files
│   │       └── ...
```

## `input-manifest.json` Schema

Written by the orchestrator before dispatching the worker.

```json
{
  "worker": "<skill-name>",
  "iteration": <int>,
  "run_id": "<run-id>",
  "inputs": {
    "<logical-name>": "<file-path>",
    ...
  },
  "context": {
    "build_cmd": "pip install -e .",
    "<key>": "<scalar-or-array>",
    ...
  },
  "output_dir": "<path-to-outputs-dir>"
}
```

### Fields

- **`worker`** — the skill name to dispatch (e.g., `idea-discovery`)
- **`iteration`** — which iteration of the loop this is
- **`run_id`** — the run identifier for receipt naming
- **`inputs`** — map of logical names to file paths. The worker reads these
  files to get its context. The orchestrator populates this from:
  - Prior workers' output directories
  - Project-level files (CLAUDE.md, research-wiki/, etc.)
  - The dashboard itself (for top-level context)
- **`context`** — small scalar/array values the worker needs without reading
  files (open gap IDs, metric target, reference knowledge). Keep this bounded.
- **`output_dir`** — where the worker MUST write all its output files

### Worker behavior on startup

1. Read `input-manifest.json` from its working directory (path passed in prompt)
2. Read files listed in `inputs` as needed
3. Use `context` values for scalar parameters
4. Write ALL output artifacts to `output_dir`
5. Write `receipt.json` as the last action
6. On any system error during execution: append one `LEVEL | location | reason`
   line to `progress_error.md` in the worker directory

## `receipt.json` Schema

Written by the worker after completing its work.

```json
{
  "worker": "<skill-name>",
  "iteration": <int>,
  "status": "done|failed",
  "error": null,
  "primary_output": "<relative-path-within-output_dir>",
  "summary": {
    ...worker-specific scalar fields...
  },
  "dashboard_patch": {
    "<dashboard-field>": <new-value>,
    "<nested.field>": <new-value>,
    ...
  },
  "completed_at": "<ISO-8601>",
  "has_errors": false,
  "error_count": 0
}
```

### Fields

- **`status`** — `done` or `failed`. On failure, include `error` field.
- **`error`** — structured failure data (required when `status == "failed"`):
  ```json
  {
    "category": "env_error|code_error|infra_error|unknown",
    "script": "prepare.sh|run.sh|collect.sh|info.sh|null",
    "exit_code": 1,
    "stderr_tail": ["<last 20 lines of stderr>"],
    "failure_patterns_matched": [],
    "message": "<one-sentence description>",
    "attempts": 1,
    "recoverable": true
  }
  ```
  - `category` routes the failure:
    - `env_error` — environment problem (prepare.sh failed, conda broken, SSH down).
      Caller routes to `/experiment-env-manager — mode: error-report`.
    - `code_error` — experiment code bug (traceback, assertion error). Not an env issue.
    - `infra_error` — ARIS infrastructure (helper missing, manifest malformed).
      Also recorded in `progress_error.md`.
    - `unknown` — cannot classify. Caller dispatches `/experiment-env-manager` for diagnosis.
  - `recoverable` — `true` if the caller can retry or route to env-manager for repair.
  - `stderr_tail` — last 20 lines of stderr from the failed command.
  - `script` — which generated script failed (null if not script-related).
- **`primary_output`** — the main output file path (relative to output_dir)
- **`summary`** — worker-specific scalar data. The orchestrator reads these
  fields for gate arithmetic (e.g., `primary_metric`, `ideas_count`,
  `gap_ids`, `verdict`). Keep bounded.
- **`dashboard_patch`** — a JSON patch object that the orchestrator merges
  into `dashboard.json`. This is how workers update the orchestrator's state
  without the orchestrator reading output files.
- **`has_errors`** — `true` if `progress_error.md` is non-empty. The orchestrator
  reads this scalar; it does NOT read the error file itself (Rule 5).
- **`error_count`** — number of lines in `progress_error.md`.

### `dashboard_patch` merge algorithm

The orchestrator applies `dashboard_patch` from `receipt.json` to `dashboard.json`
using a **dot-notation-aware, idempotent merge**:

1. For each key in `dashboard_patch`:
   - If the key contains dots (e.g. `"metric.current"`), split on `.` and
     traverse/create nested objects. Set the leaf value.
   - If the key is a plain name, set the top-level field directly.
2. Array fields: the patch provides the **full new value**, not an append.
   The orchestrator does assignment (`=`), never append (`+=`).
3. **Idempotency guard for `metric.history`:** The orchestrator checks
   `receipt.iteration` against existing history entries before appending.
   If an entry for this iteration already exists (from a prior crash+resume
   that already merged), skip the append. Concretely:
   ```
   if not any(h.iter == receipt.iteration for h in dashboard.metric.history):
       dashboard.metric.history.append({iter: receipt.iteration, value: patch.primary_metric, ...})
   ```
4. **Receipt tracking:** After merging, the orchestrator records the receipt
   path in `dashboard.applied_receipts` (an array of strings). On resume,
   if a receipt path is already in `applied_receipts`, skip the merge.
   This is the primary crash-safety mechanism for idempotent resume.
5. Only set fields the worker is authoritative for.

## `progress_error.md`

Workers and verifiers append to this file when they encounter **system-level
errors** — ARIS infrastructure problems, not experiment failures.

**System errors (write here):**
- Helper not found (`research-wiki.js`, `run-state.js` resolution failure)
- Malformed manifest (invalid JSON, missing required fields)
- Expected input file missing
- Permission denied on scripts/paths
- Paseo MCP tool failure (provider unavailable, skill not installed)
- Schema validation error (receipt/dashboard field mismatch)

**NOT system errors (do not write here):**
- Experiment failures (OOM, divergence) → `error_report.md` in outputs
- Audit FAIL verdict → legitimate outcome
- User interaction → AskUserQuestion

### Format

One line per error, max 120 chars: `LEVEL | location | reason`

```
ERROR | research-wiki.js:add_edge | not found at .aris/dist/tools/research-wiki.js
WARN  | receipt.json:dashboard_patch | field "metric.current" null, skipped
ERROR | manifest:inputs.gap_map | file missing: research-wiki/gap_map.md
ERROR | mcp__paseo__create_agent | provider "codex" unavailable
```

- **Level**: `ERROR` (blocks progress) or `WARN` (non-blocking)
- **Location**: `<component>:<detail>`
- **Reason**: one phrase, no stack traces
- Append-only. Absent or empty = no errors.

## `dashboard.json` Schema

The orchestrator's single state source. ~50 lines, ~300 tokens.

```json
{
  "run_id": "...",
  "project": "...",
  "status": "running|finishing|completed",
  "iteration": 3,
  "max_iterations": 5,
  "current_phase": "experiment-bridge",
  "config": {
    "baseline_plan": "refine-logs/EXPERIMENT_PLAN.md",
    "auto_write": false,
    "render_html": true,
    "patience": 2
  },

  "metric": {
    "name": "F1",
    "target": 0.85,
    "direction": "higher_better",
    "tolerance": 0.01,
    "current": 0.72,
    "baseline": 0.65,
    "history": [
      { "iter": 1, "value": 0.65, "idea": "baseline" },
      { "iter": 2, "value": 0.72, "idea": "attention-pruning" }
    ]
  },

  "best_idea": {
    "id": "idea:attention-pruning",
    "title": "Attention pruning with dynamic threshold",
    "metric": 0.72,
    "iteration": 2
  },

  "gaps": {
    "open": ["G3", "G5"],
    "closed": ["G1", "G2", "G4"],
    "total": 5
  },

  "last_review": {
    "verdict": "continue",
    "score": 7,
    "iteration": 2
  },

  "stop_reason": null,
  "started_at": "...",
  "updated_at": "...",
  "system_errors": {
    "total": 0,
    "last": null
  },
  "applied_receipts": []
}
```

`config` stores immutable run inputs that affect dispatch or terminal behavior.
An orchestrator restores these values on resume instead of re-reading current
arguments or project defaults. Workflows that do not need extra run inputs may
omit the object.

### `status` values

| Value | Meaning |
|---|---|
| `running` | The orchestrator loop is actively dispatching phases |
| `finishing` | The stop gate fired; the loop exited but summary/paper-writing are still pending |
| `completed` | All terminal actions done; nothing to resume |

On resume, `finishing` means: skip the iteration loop, continue from summary.
Only `completed` means nothing to do. There is no `stopped` status.

### `primary_output` and `output_dir` path semantics

- `output_dir` in `input-manifest.json` is an **absolute path** to
  `.aris/runs/<run_id>/workers/<iter>-<phase>/outputs/`.
- `primary_output` in `receipt.json` is a **relative path within output_dir**.
  The orchestrator resolves the full path as `output_dir + "/" + primary_output`.
- Workers MUST write all output artifacts to `output_dir`. When a subsequent
  worker needs a prior worker's output, the orchestrator sets the full path
  (`$WORKERS_DIR/<prior-iter>-<prior-phase>/outputs/<file>`) in the next
  manifest's `inputs`.

## Orchestrator Workflow (per phase)

```
1. Read dashboard.json
2. Determine next phase from current_phase
3. mkdir -p workers/<iter>-<phase>/outputs/
4. Write workers/<iter>-<phase>/input-manifest.json
5. Dispatch: "Run /<skill> — manifest: <manifest-path>"
6. Wait for notifyOnFinish
7. Read workers/<iter>-<phase>/receipt.json
7.5. If receipt.has_errors: increment dashboard.system_errors.total by
     receipt.error_count, set dashboard.system_errors.last to "<iter>-<phase>".
     Do NOT read progress_error.md (Rule 5 — humans inspect it for debugging).
8. Apply dashboard_patch to dashboard.json
9. Update current_phase in dashboard
10. Gate arithmetic on dashboard fields
11. → next phase or stop
```

## Backward Compatibility

All orchestrator-dispatched workers use the manifest protocol. Skills that
are also invoked directly (e.g. `/idea-discovery` from the command line)
retain their direct-call argument parsing; the manifest startup check
(`if "$ARGUMENTS" contains "— manifest:"`) selects the mode.

Legacy receipt paths (`.aris/runs/<run_id>.<phase>.done.json`) are used only
in direct-call mode for internal sub-agent coordination within a skill.
Orchestrators never read these paths.

## Anti-patterns

- Orchestrator reading `outputs/` files → violates Rule 5
- Worker ignoring manifest and hardcoding paths → fragile across projects
- dashboard_patch setting fields the worker isn't authoritative for → state corruption
- Orchestrator composing prose from receipt fields → delegate to a worker instead
