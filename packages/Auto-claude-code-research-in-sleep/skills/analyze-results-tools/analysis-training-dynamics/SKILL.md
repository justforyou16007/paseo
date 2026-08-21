---
name: analysis-training-dynamics
description: 'Training-dynamics interpretation: loss curves, learning-rate schedule behavior, gradient-norm trends, overfitting/underfitting signs across train/eval splits. Produces an interpretive report with evidence-backed observations — the accepting verdict is the cross-model verifier in /analyze-results. Use when analyzing HOW training behaved (curve shapes, dynamics), not whether it converged (see analysis-convergence).'
argument-hint: "[— manifest: <path>] [— exp: <name>] [— logs: <path>] [— metrics: <path>]"
allowed-tools: Bash(*), Read, Grep, Glob, Write, Edit
---

# Analysis Sub-Skill: Training Dynamics

One focused analysis: **how did training behave over time?**

Dispatched exclusively by `/analyze-results` as a paseo sub-agent. You
produce an interpretive report; the cross-model verifier decides whether the
overall analysis is complete — never this skill.

## Inputs

Read from the input manifest (worker mode) or arguments (direct):

- `metrics` — per-step/per-epoch series: train/eval loss, LR, gradient norm,
  any auxiliary metrics (from logs, W&B, or JSON metrics files)
- `exp` — experiment name

## Procedure

1. **Extract series** — train loss, eval loss, LR schedule, gradient norm
   (when present), per epoch/step.
2. **Read the shapes** — each observation must cite the data:
   - Loss curve: smooth/oscillating/staircase; where it flattens
   - Train-vs-eval gap: growing (overfitting), parallel (healthy), closing
   - LR schedule: warmup spikes, decay milestones visible in the loss
   - Gradient norm: spikes, vanishing, explosion
   - Speed: steps/sec drift (throttling, thermal, contention)
3. **Write the artifact** to `$OUTPUT_DIR/analysis-training-dynamics.md` with
   each observation as: Observation (numbers) → Interpretation → Implication
   for the research question → Next step that would test it.

## Output contract

```json
{
  "skill": "analysis-training-dynamics",
  "exp": "<exp>",
  "observations": <count>,
  "flags": ["overfitting_suspected", "lr_spike", "..."],
  "artifact": "<OUTPUT_DIR>/analysis-training-dynamics.md"
}
```

`flags` are machine-derivable labels for the observations (gap width crossed
a stated threshold, spike count, etc.) — each flag must map to a numbered
observation in the artifact.

## Rules

- Interpretations must be evidence-backed: every claim cites a series and a
  number. No vibes.
- You may flag *suspected* overfitting/divergence; you never conclude the
  experiment "failed" or "succeeded" — that is the verifier's call.
- Report file paths, not inline numbers, in the final reply.
