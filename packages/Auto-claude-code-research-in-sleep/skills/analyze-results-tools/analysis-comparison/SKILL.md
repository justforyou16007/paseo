---
name: analysis-comparison
description: 'Cross-experiment comparison and statistics: comparison tables (systems × metrics, deltas vs baseline), multi-seed aggregation (mean ± std, p-values when seeds ≥ 3), trend detection over parameter sweeps, outlier flagging. Machine-checkable Type-A work — tables must parse, statistics must recompute. Use when comparing experiments against each other or against a baseline.'
argument-hint: "[— manifest: <path>] [— tracker: <path>] [— results: <path>]"
allowed-tools: Bash(*), Read, Grep, Glob, Write, Edit
---

# Analysis Sub-Skill: Comparison

One focused analysis: **how do the experiments compare?**

Dispatched exclusively by `/analyze-results` as a paseo sub-agent.

## Inputs

Read from the input manifest (worker mode) or arguments (direct):

- `results` — result files (JSON/CSV) or the `result_files` manifest from
  `collect-outputs.sh` receipts (`.aris/runs/<run_id>.experiment.<exp>.done.json`)
- `tracker` — `EXPERIMENT_TRACKER.md` (run metadata: system, config, seed)
- `primary_metric_key` — from `env.json` `feedback.result`

## Procedure

1. **Build the comparison table** — rows = runs, columns = independent
   variables (system, hyperparameters, seed) + dependent variables (primary
   metric, secondary metrics). Compute delta vs baseline for every row.
2. **Aggregate across seeds** — mean ± std per configuration; flag
   reproducibility issues (std > 10% of mean).
3. **Statistics** — when a comparison has ≥ 3 seeds, compute a paired t-test
   (or Wilcoxon when n < 8 and non-normal); report p-value and the test used.
   With fewer seeds, mark the comparison "insufficient seeds — not conclusive".
4. **Sweep trends** — for parameter sweeps, identify monotonic / U-shaped /
   plateau relationships with the turning point.
5. **Outliers** — flag any run > 3σ from its configuration's mean.
6. **Write the artifact** to `$OUTPUT_DIR/analysis-comparison.md`.

## Output contract

```json
{
  "skill": "analysis-comparison",
  "runs_compared": <n>,
  "baseline": "<run id or null>",
  "significant_comparisons": [
    { "a": "<run>", "b": "<run>", "delta": 0.0, "p": 0.0, "test": "paired-t" }
  ],
  "insufficient_seeds": ["<run ids>"],
  "outliers": ["<run ids>"],
  "artifact": "<OUTPUT_DIR>/analysis-comparison.md"
}
```

## Rules

- **Type-A correctness is checkable** — every table row must trace to a
  result file; every statistic must recompute from the raw numbers. The
  verifier will spot-check.
- Raw numbers before interpretation: the artifact's tables are the source of
  truth; prose explains, never replaces.
- Report file paths, not inline numbers, in the final reply.
