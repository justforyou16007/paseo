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

## `receipt.json` Schema

Written by the worker after completing its work.

```json
{
  "worker": "<skill-name>",
  "iteration": <int>,
  "status": "done|failed",
  "primary_output": "<relative-path-within-output_dir>",
  "summary": {
    ...worker-specific scalar fields...
  },
  "dashboard_patch": {
    "<dashboard-field>": <new-value>,
    "<nested.field>": <new-value>,
    ...
  },
  "completed_at": "<ISO-8601>"
}
```

### Fields

- **`status`** — `done` or `failed`. On failure, include `error` field.
- **`primary_output`** — the main output file path (relative to output_dir)
- **`summary`** — worker-specific scalar data. The orchestrator reads these
  fields for gate arithmetic (e.g., `primary_metric`, `ideas_count`,
  `gap_ids`, `verdict`). Keep bounded.
- **`dashboard_patch`** — a JSON patch object that the orchestrator merges
  into `dashboard.json`. This is how workers update the orchestrator's state
  without the orchestrator reading output files.

### `dashboard_patch` rules

- Only set fields the worker is authoritative for
- Use dot notation for nested fields: `"metric.current": 0.82`
- Array fields: provide the full new array (not append — orchestrator does `=` not `+=`)
- The orchestrator applies the patch via: read dashboard → merge patch → write dashboard

## `dashboard.json` Schema

The orchestrator's single state source. ~50 lines, ~300 tokens.

```json
{
  "run_id": "...",
  "project": "...",
  "status": "running|stopped|completed",
  "iteration": 3,
  "max_iterations": 5,
  "current_phase": "experiment-bridge",

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
  "updated_at": "..."
}
```

## Orchestrator Workflow (per phase)

```
1. Read dashboard.json
2. Determine next phase from current_phase
3. mkdir -p workers/<iter>-<phase>/outputs/
4. Write workers/<iter>-<phase>/input-manifest.json
5. Dispatch: "Run /<skill> — manifest: <manifest-path>"
6. Wait for notifyOnFinish
7. Read workers/<iter>-<phase>/receipt.json
8. Apply dashboard_patch to dashboard.json
9. Update current_phase in dashboard
10. Gate arithmetic on dashboard fields
11. → next phase or stop
```

## Backward Compatibility

Workers that don't yet support the manifest protocol can still be dispatched
with the old `--extra` style. The orchestrator detects whether a skill supports
manifests by checking if it cites this document in its body. Transition is
incremental — skills adopt the manifest protocol one by one.

## Anti-patterns

- Orchestrator reading `outputs/` files → violates Rule 5
- Worker ignoring manifest and hardcoding paths → fragile across projects
- dashboard_patch setting fields the worker isn't authoritative for → state corruption
- Orchestrator composing prose from receipt fields → delegate to a worker instead
