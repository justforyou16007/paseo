---
name: analysis-convergence
description: 'Convergence/divergence/NaN analysis of a training run. Reads metric series (log files or W&B), applies the frozen early_stop thresholds (max-hours, convergence patience, divergence multiplier, entropy collapse) as machine-checkable signals, and produces a structured verdict PROPOSAL — the accepting verdict is the cross-model verifier in /analyze-results, never this skill. Use when analyzing whether training converged, diverged, plateaued, or collapsed.'
argument-hint: "[— manifest: <path>] [— exp: <name>] [— logs: <path>] [— metrics: <path>]"
allowed-tools: Bash(*), Read, Grep, Glob, Write, Edit
---

# Analysis Sub-Skill: Convergence

One focused analysis: **did the training run converge, diverge, or collapse?**

Dispatched exclusively by `/analyze-results` (the hub skill) as a paseo
sub-agent. You produce an artifact + a machine-checkable signal table; you
never render the final completeness verdict.

## Inputs

Read from the input manifest (worker mode) or arguments (direct):

- `metrics` — metric series source: a log file with `step/epoch/loss` lines,
  or a W&B run reference, or a JSON metrics file
- `early_stop` — the frozen thresholds from `env.json` `monitor.early_stop`
  (max_training_time_hours, convergence {patience, min_delta}, divergence
  {threshold_multiplier}, entropy_collapse {threshold}). When absent, use
  documented defaults and say so in the report.
- `exp` — experiment name (for labeling outputs)

## Procedure

1. **Extract the series.** Parse `step|iteration|iter`, `epoch`, `loss|train_loss`,
   `entropy` from log lines (same regexes the ops' job-status facts use), or
   pull `train/loss` + `train/entropy` history from W&B.
2. **Apply the four machine checks** (each is a threshold, not a judgment):
   - Max time: run wall time vs `max_training_time_hours`
   - Convergence: last `patience` points, best-vs-current delta < `min_delta`
   - Divergence: current loss > `threshold_multiplier` × best loss so far
   - Entropy collapse: entropy < threshold
3. **Scan for NaN/Inf** in the series.
4. **Write the artifact** to `$OUTPUT_DIR/analysis-convergence.md`:
   - the extracted series (table or sparkline summary)
   - each check's PASS/FLAG with numbers
   - a `verdict_proposal: converged|diverged|collapsed|plateaued|inconclusive`
     with the evidence, explicitly labeled a *proposal*

## Output contract

```json
{
  "skill": "analysis-convergence",
  "exp": "<exp>",
  "signals": {
    "max_time": "ok|exceeded",
    "convergence": "converged|plateaued|no_signal",
    "divergence": "ok|diverged",
    "entropy_collapse": "ok|collapsed|not_tracked",
    "nan_inf": "none|found"
  },
  "verdict_proposal": "converged|diverged|collapsed|plateaued|inconclusive",
  "artifact": "<OUTPUT_DIR>/analysis-convergence.md"
}
```

## Rules

- **Facts and proposals only.** The accepting verdict is the cross-model
  verifier dispatched by `/analyze-results` — never this skill.
- Thresholds come from the frozen `monitor.early_stop` config; never invent
  thresholds. When the config is absent, state the defaults you used.
- Report file paths, not inline numbers, in the final reply (the hub reads
  the artifact).
