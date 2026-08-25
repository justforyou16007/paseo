---
name: analyze-results
description: 'Iterative experiment analysis HUB (总分结构): routes each analysis dimension to a focused sub-skill (analysis-wandb / analysis-convergence / analysis-training-dynamics / analysis-comparison under skills/analyze-results-tools/), assembles their artifacts, dispatches a cross-model verifier to evaluate completeness, and iterates until the verifier passes. Use when user says "analyze results", "分析结果", "compare experiments", "结果分析", or after experiments complete and results need interpretation.'
argument-hint: "[— project: <name>] [— max-rounds: N] [— method: <existing-analysis-script-or-command>]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, AskUserQuestion, WebSearch, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__archive_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission
---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in
> [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill;
> Rule 4: Paseo MCP Only, Strict). The Phase 3 verifier is dispatched via
> `mcp__paseo__create_agent` — not the host `Skill` / `Agent` / `Task` tools.

> **Gate provenance** (`shared-references/acceptance-gate.md` step 5).
> This skill has one STOP gate: *is the analysis sufficiently complete and rigorous?*
> - **Type-A** (self-checkable): tables parse, statistics are computed, files exist.
> - **Type-B** (never self-judged): *is the analysis thorough enough to support
>   claims?* This verdict is produced by a fresh cross-model verifier and read
>   verbatim. This skill never forms its own opinion of completeness.

# Analyze Results

Iterative experiment analysis for: **$ARGUMENTS**

## Purpose

Experiment analysis is not a one-shot operation. The first pass often reveals
gaps: missing experiments, insufficient seeds, uncovered error modes, or shallow
insights. This skill drives an iterative loop:

1. Collect the result manifest (from collect-outputs.sh receipts)
2. Route each analysis dimension to a sub-skill; dispatch as sub-agents
3. Dispatch a cross-model verifier to evaluate completeness
4. If incomplete: re-dispatch sub-skills / trigger supplementary experiments
5. Repeat until the verifier passes or the user accepts

```
Phase 0    Resolve project + locate generated skill
Phase 1    Bootstrap — collect the result manifest from experiment receipts
Phase 2    Analysis — dispatch analysis sub-skills (hub-and-spoke)
Phase 3    Dispatch verifier (Type-B gate) — cross-model completeness audit
Phase 4    Iteration loop — address verifier gaps, re-analyze, re-verify
Phase 5    Final output — complete analysis report
```

---

## Manifest Protocol (Worker Mode)

When invoked with `— manifest: <path>`, this skill runs as a worker under an
orchestrator (`/research-pipeline` or `/auto-research-loop`). The manifest
provides all inputs; the skill writes its receipt to the manifest's directory.
The required input-manifest file is the complete input authority for this worker.

**Startup check:**
```
if "$ARGUMENTS" contains "— manifest:"; then
    MANIFEST_PATH=<extracted path>
    MANIFEST=$(cat "$MANIFEST_PATH")
    WORKER_DIR=$(dirname "$MANIFEST_PATH")
    OUTPUT_DIR=$(jq -r '.output_dir' <<< "$MANIFEST")
    mkdir -p "$OUTPUT_DIR"
    # Read inputs from manifest.inputs (file paths)
    # Read context from manifest.context (scalar values)
fi
```

**Worker input authority:** require `manifest.inputs.results` and
`manifest.inputs.tracker`. Accept optional `experiment_plan`,
`experiment_skill`, and `error_report` paths. In worker mode:

- analyze exactly the supplied results and tracker, plus any supplemental files
  created during this invocation;
- write the analysis only to `$OUTPUT_DIR/EXPERIMENT_RESULTS.md`;
- use the supplied plan for coverage checks when present; when absent, mark
  plan-coverage as not applicable;
- do not replace these inputs with project-root `results/`, `logs/`,
  `refine-logs/`, or any analysis file outside the manifest. A project-wide scan is forbidden
  in worker mode — the manifest snapshot is the whole input set.

There is no project-root discovery mode. The manifest is the complete input
set for every invocation.

**Receipt (write last to `$WORKER_DIR/receipt.json`):**

When dispatched by `/auto-research-loop`, this skill writes the authoritative metric
value to `metric.current`. `dashboard-merge.js apply` appends the per-iteration
`metric.history` entry from `metric.current` in a single atomic write.

```json
{
  "worker": "analyze-results",
  "iteration": 1,
  "run_id": "<run-id>",
  "status": "done",
  "error": null,
  "primary_output": "EXPERIMENT_RESULTS.md",
  "summary": { "verdict": "<pass|warn|user_override>", "iterations": "<int>" },
  "dashboard_patch": {
    "metric.current": 0.82,
    "metric.delta": 0.05,
    "statistical_significance": true
  },
  "completed_at": "<ISO-8601>",
  "has_errors": false,
  "error_count": 0
}
```

On failure, write receipt with `"status": "failed"` and structured `error` object
per `worker-manifest.md`. Append system errors to `$WORKER_DIR/progress_error.md`.

The skill requires `— manifest:` and always writes a receipt.

**Output path mapping:** Every output path in this skill maps to
`$OUTPUT_DIR/<filename>`. The orchestrator's input manifests reference these
paths directly.

| Worker output |
|---|
| `$OUTPUT_DIR/EXPERIMENT_RESULTS.md`, `$OUTPUT_DIR/EXPERIMENT_TRACKER.md` |

---

## Phase 0: Resolve Project

Resolve `PROJECT` from manifest context or the repository name.
If `inputs.experiment_skill` names an `env.json`, derive `SKILL_DIR` from its
parent and read that exact file. Do not search for another generated experiment
skill. Then continue with the worker input authority above.

---

## Phase 1: Bootstrap — collect the analysis inputs

The input to every analysis round is the **result manifest**: the
`result_files` list from `collect-outputs.sh` receipts
(`.aris/runs/<run_id>.experiment.<exp>.done.json`), plus the error reports the
same receipts reference. Analysis data collection is DONE — the ops already
collected it; this skill never re-scans logs itself.

**Worker mode:** start from `manifest.inputs.results` and
`manifest.inputs.tracker`. A user method may add calculations, but it must be
pointed at those exact inputs and must not substitute files found under
project-root result directories. Keep supplemental outputs under `$OUTPUT_DIR`.

The manifest's result receipt list is authoritative. Do not scan project-root
`results/` or `logs/` when the manifest is missing or incomplete.

**If `— method: <path-or-command>` is provided:** execute the user's method,
capture its output, and seed the first round with it — what it already covers
doesn't need re-analysis; what it misses becomes the iteration target.

---

## Phase 2: Dispatch Analysis Sub-Skills (hub-and-spoke)

**This skill is the hub: it routes, sub-skills analyze.** Each sub-skill is
dispatched as its own paseo sub-agent (Rule 1: one agent = one skill), reads
its inputs from an input manifest, and writes its own artifact. The hub reads
only the artifacts' output contracts (file paths + machine-checkable fields)
— never the full artifacts. Analysis logic NEVER lives in this skill.

### The analysis tool index

| Sub-skill | Use when | Machine-checkable? |
|---|---|---|
| `analysis-wandb` | W&B is configured and any other sub-skill needs series or run state | Yes (data acquisition) |
| `analysis-convergence` | Training runs exist and the question is converged / diverged / collapsed (applies the frozen `monitor.early_stop` thresholds) | Partially (thresholds are mechanical; the verdict is a *proposal*) |
| `analysis-training-dynamics` | The question is HOW training behaved — loss-curve shape, train/eval gap, LR schedule, gradient norms | No (interpretive report; verifier adjudicates) |
| `analysis-comparison` | Two or more runs exist and the question is which is better, by how much, with what significance | Yes (tables parse; stats recompute) |

### Routing rules (deterministic)

1. W&B configured (`env-info.sh` `.wandb.enabled` or receipts carry `wandb`) AND
   any sub-skill needs series → dispatch `analysis-wandb` FIRST; its exports
   feed the others.
2. Any training run in the manifest → dispatch `analysis-convergence`
   (thresholds from `monitor.early_stop`).
3. Multiple runs → dispatch `analysis-comparison`.
4. Train/eval series exist (W&B export or logs) → dispatch
   `analysis-training-dynamics`.
5. A `— method` user script covers a dimension → skip that dimension's
   sub-skill; record the skip in the final report.
6. Dispatch one sub-agent per sub-skill, sequentially (create → end turn →
   notification → read output contract → archive → next). Each sub-agent's
   input manifest carries: metric/result paths, the relevant `env.json`
   blocks, `exp` names, and its `$OUTPUT_DIR`.

### Step 2z: Assemble the hub artifact

Merge the sub-skills' output contracts (NOT their full artifacts) into
`$OUTPUT_DIR/EXPERIMENT_RESULTS.md`. The
assembled report links each sub-skill's artifact; it does not duplicate them.

---

## Phase 3: Dispatch Verifier (Type-B Gate)

**The completeness question is Type-B.** This skill produced the analysis —
the same reasoning that finds its own work adequate would also miss its own
blind spots. A fresh cross-model verifier evaluates completeness.

Dispatch a **paseo sub-agent** per Rule 1 / Rule 4. The verifier MUST be
cross-model (Type-B gate per `acceptance-gate.md`): use a codex reviewer, not
claude. Per `paseo-reviewer-dispatch.md`, pass explicit `settings.modeId`
for cross-provider dispatch.

```
mcp__paseo__create_agent
  title:    "analysis completeness audit: <project>"
  provider: codex/gpt-5.5
  settings:
    modeId: "full-access"
    thinkingOptionId: "xhigh"
  cwd:      $ROOT
  initialPrompt: |
    Review the experiment analysis for completeness and rigor.

    Artifacts to read (paths only — read them yourself):
      Analysis output:     <resolved analysis output>
      Error report:        <manifest input/output path, or "not supplied">
      Experiment plan:     <manifest input path, or "not supplied">
      Experiment tracker:  <manifest input path in worker mode; direct path otherwise>
      Result files:        <manifest input path in worker mode; direct paths otherwise>
      Sub-skill artifacts: <OUTPUT_DIR>/analysis-*.md and wandb/ (from Phase 2)
      env.json:            <manifest experiment_skill path, if supplied>

    Evaluate against these criteria — report each as PASS | WARN | FAIL:

    A. Coverage — are all planned experiments represented in results?
       FAIL if a supplied experiment plan exists and >20% of entries have no
       result. Mark not applicable when no plan was supplied.
    B. Statistical rigor — do claims have sufficient statistical support?
       FAIL if single-seed results are presented as conclusive.
    C. Comparison completeness — are all critical baselines compared?
       FAIL if the primary baseline comparison is missing.
    D. Error coverage — does the error report capture all anomalies?
       WARN if log files contain unmatched suspicious patterns.
    E. Insight depth — are findings evidence-backed, not just numbers?
       WARN if insights lack interpretation or next-step reasoning.
    F. Reproducibility — could someone replicate from this report?
       WARN if key hyperparameters or configs are omitted.

    Output:
      .aris/env-config/<project>/ANALYSIS_AUDIT.md (human-readable report)
      .aris/env-config/<project>/ANALYSIS_AUDIT.json:
      {
        "overall_verdict": "pass|warn|fail",
        "checks": { "A": "pass|warn|fail", "B": "...", ... },
        "gaps": [
          { "check": "A", "description": "...",
            "suggested_action": "run_experiment|re_dispatch_subskill|add_analysis" }
        ]
      }

    Reply with the two file paths only.
```

Then end the turn; on the finish notification read the receipt and `mcp__paseo__archive_agent`.

**Type-A self-check:** `ANALYSIS_AUDIT.json` exists and parses.
**Type-B read:** transcribe `overall_verdict` and `gaps[]` verbatim.

---

## Phase 4: Iteration Loop

Read `ANALYSIS_AUDIT.json`:

**If `overall_verdict == "pass"`:** proceed to Phase 5.

**If `overall_verdict == "warn"`:** present the gaps, write a blocked
receipt, and stop this invocation. Do not turn an incomplete audit into a
final analysis with caveats. Start a new invocation after the reported gaps
are resolved.

**If `overall_verdict == "fail"`:** present gaps to the user, then iterate.

1. `AskUserQuestion`:
   - header: "分析审计未通过"
   - question: "Verifier 发现以下不足：\n<gaps with descriptions and suggested actions>\n\n请选择："
   - options:
     - `"执行全部补充"` — auto-execute all suggested actions
     - `"选择性补充"` — user picks which gaps to address
     - `"分析已足够，跳过"` — accept current analysis, set `user_override`

2. For each gap to address:

   **`suggested_action: run_experiment`**
   - Dispatch `run-<project>-experiment` via paseo sub-agent with the
     specific experiment parameters from the gap description
   - Wait for its monitoring heartbeat's terminal receipt
   - Re-run Phase 1 → 2 → 3

   **`suggested_action: re_dispatch_subskill`**
   - The gap is in analysis coverage: re-dispatch the relevant sub-skill
     with an explicit instruction addressing the gap (e.g., broader series
     extraction, an additional comparison), or fix the op failure report
     pipeline when the data itself is missing
   - Re-run Phase 1 → 2 → 3

   **`suggested_action: add_analysis`**
   - A missing dimension: write a NEW sub-skill under
     `skills/analyze-results-tools/` following the existing four (focused
     scope, artifact + output contract, no verdict), add it to the Phase 2
     tool index and routing rules, dispatch it
   - Re-run Phase 1 → 2 → 3

3. Each iteration dispatches a **fresh** verifier (not a continuation —
   the reviewer must not be anchored on the previous round).

4. Continue until `overall_verdict != "fail"` or user chooses "跳过".

Default `— max-rounds: 5` (user can override). If max rounds reached,
present the remaining gaps and ask whether to continue or accept.

User override sets `analysis_audit.status = "user_override"`.

---

## Phase 5: Final Output

When analysis is complete (verifier passes or user accepts):

Write `refine-logs/EXPERIMENT_RESULTS.md`:

```markdown
# Experiment Results — <project>

## Analysis Status
- Verifier verdict: <pass|warn|user_override>
- Iterations: <N> rounds
- Method: <initial_method or "sub-skill dispatch">

## Raw Data Tables
<all experiments, all metrics, organized by experiment group>

## Comparison Tables
<vs baseline, vs ablations, with deltas and significance>

## Statistical Summary
<mean ± std, p-values, confidence intervals>

## Key Findings
1. <finding with evidence>
2. ...

## Analysis Iteration Log
- Round 1: <what was analyzed, what gaps found>
- Round 2: <what was supplemented>
- ...

## Caveats
<any WARN items from verifier, any gaps user chose to skip>
```

Update `refine-logs/EXPERIMENT_TRACKER.md` with analysis status column.

```json
{
  "skill": "analyze-results",
  "project": "<project>",
  "verdict": "pass|warn|user_override",
  "iterations": 0,
  "output": "$OUTPUT_DIR/EXPERIMENT_RESULTS.md",
  "audit_report": ".aris/env-config/<project>/ANALYSIS_AUDIT.md",
  "completed_at": "<ISO-8601>"
}
```

---

## Constants

- **DEFAULT_MAX_ROUNDS** = 5
- **AUDIT_DIR** = `.aris/env-config/<project>`
- **DEFAULT_OUTPUT** = `refine-logs/EXPERIMENT_RESULTS.md`

## Critical Rules

1. **Never self-judge completeness.** The verifier (Type-B) decides whether
   the analysis is thorough. This skill executes the analysis and reads the
   verdict — it does not form its own opinion of adequacy.
2. **Fresh verifier per round.** Each verification dispatches a new sub-agent.
   Never continue a prior verification thread.
3. **User controls iteration.** On verifier FAIL, the user chooses what to
   supplement. The skill never autonomously decides to stop iterating.
4. **`— method` seeds, doesn't replace.** An existing analysis method becomes
   the starting point; the iterative process may extend beyond it.
5. **Analysis logic lives in sub-skills, not one-offs.** When adding
   analysis, write it as (or into) a sub-skill under
   `skills/analyze-results-tools/` so it persists and is re-dispatchable —
   don't run one-off commands that aren't captured.
6. **File-paths-only receipts.** The receipt carries paths; the dispatching
   parent reads the files themselves.

## External dependencies (reused, not modified)

- `.claude/skills/run-<project>-experiment/` — the generated experiment skill
  (ops + env.json). Its `collect-outputs.sh` receipts are the result manifest.
- `skills/analyze-results-tools/*` — the four analysis sub-skills this hub
  dispatches (analysis-wandb, analysis-convergence,
  analysis-training-dynamics, analysis-comparison).
- `shared-references/acceptance-gate.md` — DRIVE/ACQUIT; the Type-A / Type-B
  split that Phase 3 implements.
- `shared-references/reviewer-independence.md` — why the verifier reads files
  itself.
- `shared-references/paseo-subagent-dispatch.md` — Rule 1, Rule 3, Rule 4.
- `refine-logs/EXPERIMENT_PLAN.md` — the experiment roadmap (read by verifier
  to check coverage).
- `refine-logs/EXPERIMENT_TRACKER.md` — run-by-run status (updated at end).
