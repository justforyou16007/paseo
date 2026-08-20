---
name: gap-planner
description: 'Post-idea gap audit and experiment planning for auto-research-loop. Runs once after constrained idea-discovery. The gap-planner itself identifies, merges, closes, defers, refutes, and prioritizes gaps from experiment evidence, then turns the already-selected idea plus the audited gaps into the next EXPERIMENT_PLAN.md. Use for "gap analysis", "plan next experiments", "gap-planner", or "实验缺口规划".'
argument-hint: "[— manifest: <path>]"
allowed-tools: Bash(*), Read, Write, Grep, Glob
---

# Gap Planner

Run once, after idea-discovery. This skill is the gap audit stage. Do not add a
separate gap-audit skill, dispatch another gap reviewer, or call gap-planner
once before and once after idea discovery.

Gap-planner owns every gap ruling and the resulting experiment plan. It must
base gap state changes on experiment evidence, not on the attractiveness of a
proposed idea. Follow `../shared-references/worker-manifest.md`.

## Manifest Protocol

When invoked with `— manifest: <path>`, read that `input-manifest.json` and its
`worker`, `iteration`, `run_id`, `inputs`, `context`, and `output_dir`. Require
`worker` to equal `gap-planner`, `context.source_iteration` to equal
`iteration - 1`, and `context.selected_idea_id` to identify exactly one
candidate in `inputs.idea_report`. Write `receipt.json` last beside the
manifest.

Metric values come only from the manifest's `context`. Do not read or reinterpret
`CLAUDE.md`. Do not assume a paper or LaTeX directory exists.

```json
{
  "worker": "gap-planner",
  "iteration": 3,
  "run_id": "<run-id>",
  "inputs": {
    "idea_report": "<workers/3-idea-discovery/outputs/IDEA_REPORT.md>",
    "analysis": "<workers/2-auto-review-loop/outputs/final-analysis/EXPERIMENT_RESULTS.md>",
    "tracker": "<workers/2-auto-review-loop/outputs/final-inputs/EXPERIMENT_TRACKER.md>",
    "results": "<workers/2-auto-review-loop/outputs/final-inputs/EXPERIMENT_RESULTS.md>",
    "review": "<workers/2-auto-review-loop/outputs/AUTO_REVIEW.md>",
    "prior_gap_map": "<research-wiki/gap_map.md>"
  },
  "context": {
    "source_iteration": 2,
    "selected_idea_id": "idea-3-1",
    "metric_name": "F1",
    "metric_target": 0.85,
    "metric_direction": "higher_better",
    "metric_tolerance": 0.01,
    "metric_current": 0.72,
    "metric_baseline": 0.65,
    "metric_history": [{"iter": 1, "value": 0.65}, {"iter": 2, "value": 0.72}]
  },
  "output_dir": "<worker-dir>/outputs"
}
```

Fail on a missing input, mismatched run/iteration, or an output path outside
`output_dir`.

## Workflow

### 1. Audit the gap map

Read every manifest input. The experiment analysis, tracker, results, review,
and prior gap map are evidence. `IDEA_REPORT.md` is not evidence that a gap
exists or is closed; use it only after the gap decisions are complete to map
the selected idea's provisional target descriptions or old ids to canonical
ids.

Gap-planner must:

- identify new empirically testable gaps;
- merge duplicates into the oldest stable gap id;
- close a gap only when cited experiment evidence meets its closing condition;
- mark contradicted gaps `refuted` and low-value unresolved gaps `deferred`;
- rank open gaps by metric impact, evidence strength, and experiment cost;
- map the selected idea to one or more canonical open gaps without changing
  the selected idea.

Write these files directly under `output_dir`:

- `GAP_AUDIT.json` - structured decisions;
- `gap_map.md` - the complete audited map;
- `GAP_ANALYSIS.md` - concise reasoning with evidence paths.

`GAP_AUDIT.json` must follow this schema:

```json
{
  "schema_version": 1,
  "run_id": "<run-id>",
  "iteration": 3,
  "source_iteration": 2,
  "auditor": "gap-planner",
  "decisions": [
    {
      "gap_id": "G3",
      "action": "keep|merge|close|refute|defer|add",
      "merged_into": null,
      "priority": "high|medium|low|null",
      "evidence": ["<input-path>#<section>"],
      "reason": "<concise reason>"
    }
  ],
  "open_gap_ids": ["G3"],
  "closed_gap_ids": ["G1", "G2"],
  "total_gaps": 3,
  "selected_idea": {
    "id": "idea-3-1",
    "canonical_gap_ids": ["G3"]
  }
}
```

Before planning, perform deterministic structure checks: matching run,
planning iteration, source iteration, and selected idea; unique gap ids; no
open/closed overlap; valid actions; evidence for every add/merge/close/refute
decision; and selected-idea mappings that contain only canonical open gaps. A
failed check produces a failed receipt rather than silently repairing the audit.

### 2. Compose the next experiment plan

Read the exact selected candidate from `IDEA_REPORT.md`. Do not select a
different method.

For each canonical target gap in `GAP_AUDIT.json`, copy its audited priority
and closing condition. Add only the concrete code and configuration steps
already present in the selected candidate. Every milestone must include
`gap_id`, hypothesis, exact modification, command/config, dataset and split,
seeds, metric, success threshold, expected artifact, dependency, and estimated
runtime. If no target remains open or the idea report lacks any required plan
detail, fail instead of inventing it.

Write `EXPERIMENT_PLAN.md` under `output_dir`. It must be self-contained for
`/experiment-bridge`.

## Receipt

```json
{
  "worker": "gap-planner",
  "iteration": 3,
  "run_id": "<run-id>",
  "status": "done",
  "error": null,
  "primary_output": "EXPERIMENT_PLAN.md",
  "summary": {
    "operation": "audit-and-plan",
    "selected_idea_id": "idea-3-1",
    "decisions": 6,
    "milestones": 3
  },
  "dashboard_patch": {
    "gaps.open": ["G3"],
    "gaps.closed": ["G1", "G2"],
    "gaps.total": 3,
    "gap_audit_path": ".aris/runs/<run-id>/workers/3-gap-planner/outputs/GAP_AUDIT.json",
    "plan_path": ".aris/runs/<run-id>/workers/3-gap-planner/outputs/EXPERIMENT_PLAN.md"
  },
  "completed_at": "<ISO-8601>",
  "has_errors": false,
  "error_count": 0
}
```

On failure, use the complete failed-receipt form from `worker-manifest.md`.

## Authority Boundary

- Idea-discovery: generate candidates and select the method before this skill
  runs.
- Gap-planner: audit all gap state changes and compose the experiment plan.
- Auto-research-loop: metric stop arithmetic and phase scheduling only.
