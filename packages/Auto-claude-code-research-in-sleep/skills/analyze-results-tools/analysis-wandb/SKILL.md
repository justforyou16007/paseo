---
name: analysis-wandb
description: 'W&B data retrieval and run-state summary: pulls metric history, run status, and dashboard links for one or more runs and writes them as local artifacts so other analysis sub-skills can work without W&B access. Pure data acquisition (Type-A). Use when W&B is configured and the analysis needs the actual series or run state.'
argument-hint: "[— manifest: <path>] [— runs: <run-ids>] [— project: <wandb-project>]"
allowed-tools: Bash(*), Read, Grep, Glob, Write, Edit
---

# Analysis Sub-Skill: W&B Retrieval

One focused task: **get the W&B data onto disk.**

Dispatched exclusively by `/analyze-results` as a paseo sub-agent. This is
data acquisition, not interpretation — the series you export feed
`analysis-convergence` and `analysis-training-dynamics`.

## Inputs

Read from the input manifest (worker mode) or arguments (direct):

- `runs` — one or more W&B run ids (or exp names to resolve via handles/receipts)
- `project` / `entity` — from `env.json` `wandb` config (`ops/env-info.sh`
  output `.wandb`), never hardcoded

## Procedure

1. **Resolve runs** — run ids directly, or map exp names via
   `.aris/runs/<run_id>.experiment.<exp>.done.json` `wandb.run_id`.
2. **Pull history** — for each run, export the metric history
   (train/eval loss, LR, custom metrics) via the W&B API to
   `$OUTPUT_DIR/wandb/<run-id>.json`.
3. **Summarize run state** — status (running/finished/crashed), duration,
   final step, dashboard URL.
4. **Write the index** — `$OUTPUT_DIR/wandb/index.json` mapping run id →
   export file, state, URL.

## Output contract

```json
{
  "skill": "analysis-wandb",
  "runs": [
    { "run_id": "...", "state": "finished", "export": "<OUTPUT_DIR>/wandb/<run-id>.json", "url": "..." }
  ],
  "index": "<OUTPUT_DIR>/wandb/index.json"
}
```

## Rules

- No interpretation — export numbers and state, nothing else. Analysis of
  the series belongs to the other sub-skills.
- When a run is unreachable (deleted, permissions), record the failure in
  the output contract and continue with the rest; never abort the batch.
- Report file paths, not inline numbers, in the final reply.
