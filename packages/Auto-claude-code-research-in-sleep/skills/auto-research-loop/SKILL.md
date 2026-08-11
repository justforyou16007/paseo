---
name: auto-research-loop
description: 'Metric-target-driven iterative research loop. Based on research-pipeline architecture, runs repeated cycles of idea-discovery → experiment-bridge → auto-review-loop until the primary metric reaches the target. Each iteration discovers improvement ideas based on identified gaps, implements and runs them, reviews results, and checks progress. Requires a confirmed baseline and metric target. Use when user says "auto research loop", "research iteration loop", "迭代研究循环", "keep iterating until the metric is met", or wants autonomous iterative improvement toward a quantitative target.'
argument-hint: "[— baseline: <experiment-plan-path>] [— resume <run_id>] [— max-iterations: N]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__wait_for_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat
---

# Auto Research Loop — Dashboard + Manifest Architecture

> **Paseo dispatch contract (Rules 1-5).** This skill is a thin scheduler. It dispatches sub-agents via `mcp__paseo__create_agent`, reads their `receipt.json` files, applies `dashboard_patch` fields to `dashboard.json`, evaluates deterministic stop arithmetic on dashboard fields only, and archives finished children. It performs **no analysis, no drafting, and no judgment of its own**. Every sub-skill invocation is a separate paseo agent — no in-process `Skill` tool calls.
>
> **Rule 5 — Manifest Protocol.** All context for workers goes through `input-manifest.json`, not the orchestrator prompt. The dispatch prompt is minimal: skill name + manifest path. Workers read their manifest, do their work, write `receipt.json`. The orchestrator never reads worker output files (no `cat`, `awk`, `grep` on outputs). It reads only `dashboard.json` and `receipt.json` files.
>
> See: `shared-references/paseo-subagent-dispatch.md`, `shared-references/worker-manifest.md`

## Purpose

This skill differs from `research-pipeline` in three ways:

1. **Iterative.** Research-pipeline is a single pass (W1-W6). This skill loops Phases 1-5 until a metric target is met or budget is exhausted.
2. **Metric-driven.** The loop is governed by a quantitative target read from `CLAUDE.md ## Metric Target`. Every iteration's output is evaluated against this target.
3. **Requires baseline.** Iteration 1 reproduces a confirmed baseline. Subsequent iterations discover and test improvements targeting identified gaps.

## Dispatch Pattern

Every phase follows the same cycle. This is shown once here; each phase section below specifies only what differs (inputs, context, dispatch skill).

For the full manifest and receipt JSON schemas, see `shared-references/worker-manifest.md`.

```
1. WORKER_DIR="$WORKERS_DIR/${ITERATION}-<phase-name>"
   mkdir -p "$WORKER_DIR"

2. Write $WORKER_DIR/input-manifest.json with:
   - phase, run_id, iteration, root (standard header)
   - inputs: file paths the worker needs (phase-specific, see tables below)
   - config: scalar context values (phase-specific)
   - output: receipt_path + output file paths

3. Dispatch via mcp__paseo__create_agent:
   title: "research-loop-iter-${ITERATION}-<phase-name>"
   provider: "claude/claude-sonnet-4-6"
   initialPrompt: "/<skill-name> — manifest: $WORKER_DIR/input-manifest.json"
   notifyOnFinish: true

4. Wait for completion notification.

5. Read $WORKER_DIR/receipt.json:
   - If status=failed → log and decide (retry or stop)
   - Merge dashboard_patch into $DASHBOARD via jq

**Error tracking:** If `receipt.has_errors == true`, update dashboard:
`dashboard.system_errors.total += receipt.error_count` and
`dashboard.system_errors.last = "<iter>-<phase>"`. The orchestrator does NOT
read `progress_error.md` (Rule 5). Humans inspect it at
`.aris/runs/<run_id>/workers/<iter>-<phase>/progress_error.md` for debugging.

6. Archive the worker: mcp__paseo__archive_agent

7. Update run-state: node "$RUN_STATE" set "$ROOT" "$RUN_ID" <phase> done
```

## Phase Diagram

```
Phase 0     Validate preconditions + Initialize dashboard.json
--- Iteration loop (1 -> MAX_ITERATIONS) ---
Phase 1     Idea Discovery
Phase 2     Experiment Bridge
Phase 2.5   Analyze Results
Phase 3     Auto Review
Phase 4     Metric Evaluation (pure arithmetic — NO dispatch)
Phase 5     Gap Analysis (skipped if stop gate fires)
--- End loop ---
Phase 6     Summary (on stop)
Phase 7     Paper Writing (optional, if metric met)
```

## Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `MAX_ITERATIONS` | 5 | Override via `-- max-iterations: N`. |
| `TARGET_METRIC` | from CLAUDE.md | Read from `## Metric Target`, line `primary: <number> <unit>`. |
| `TARGET_TOLERANCE` | 0.01 | `current >= target * (1 - 0.01)` counts as met. |
| `PATIENCE` | 2 | Max consecutive pivot verdicts before force stop. |
| `REVIEWER_MODEL` | gpt-5.5 | Cross-model. Self-acquittal tripwire on `claude*`. |
| `DASHBOARD_PATH` | `.aris/runs/<run_id>/dashboard.json` | Single source of truth. |
| `WORKERS_DIR` | `.aris/runs/<run_id>/workers/` | All worker manifests and receipts. |

Dashboard schema: see `shared-references/worker-manifest.md` section "dashboard.json Schema". All gate arithmetic uses dashboard fields only. The orchestrator NEVER reads experiment logs, result files, or review prose.

---

## Phase 0: Preconditions + Initialize Dashboard

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1
ROOT=$(pwd)

# Resolve ARIS_REPO
if [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi
WIKI_SCRIPT="$ARIS_REPO/dist/tools/research-wiki.js"
RUN_STATE="$ARIS_REPO/dist/tools/run-state.js"

# 0a. Read metric target
TARGET_METRIC=$(awk '/^## Metric Target/{flag=1; next} flag && /^primary:/{print $2; exit}' CLAUDE.md)
if [ -z "$TARGET_METRIC" ]; then
    echo "ERROR: auto-research-loop requires '## Metric Target' in CLAUDE.md."
    echo "Add a 'primary: <number> <unit>' line under that header."
    exit 1
fi
TARGET_UNIT=$(awk '/^## Metric Target/{flag=1; next} flag && /^primary:/{print $3; exit}' CLAUDE.md)

# 0b. Check experiment environment — dispatch env-manager if not configured
PROJECT_NAME=$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-//; s/-$//')
ENV_JSON=".claude/skills/run-${PROJECT_NAME}-experiment/env.json"
ENV_CONFIGURED=false
if [ -f "$ENV_JSON" ]; then
    STATUS=$(jq -r '.status' "$ENV_JSON")
    [ "$STATUS" = "complete" ] && ENV_CONFIGURED=true
fi
if [ "$ENV_CONFIGURED" = "false" ]; then
    # Dispatch env-manager for baseline setup (HARD STOP if not configured)
    mcp__paseo__create_agent
      title: "env-manager: setup $PROJECT_NAME"
      provider: claude
      initialPrompt: "/experiment-env-manager — project: $PROJECT_NAME — mode: setup"
      notifyOnFinish: true

    # Wait for completion, then verify env.json status directly
    # (env-manager writes status=complete to env.json on success)
    if [ -f "$ENV_JSON" ]; then
        STATUS=$(jq -r '.status' "$ENV_JSON")
        if [ "$STATUS" != "complete" ]; then
            echo "ERROR: env-manager setup did not reach complete status (got: $STATUS). Cannot proceed."
            exit 1
        fi
        ENV_CONFIGURED=true
    else
        echo "ERROR: env-manager did not produce experiment skill. Cannot proceed."
        exit 1
    fi
fi

# 0c. Locate baseline plan
BASELINE_PLAN="${ARG_BASELINE:-refine-logs/EXPERIMENT_PLAN.md}"
if [ ! -f "$BASELINE_PLAN" ]; then
    echo "ERROR: Baseline plan not found at $BASELINE_PLAN"
    exit 1
fi

# 0d. Create run directory + initialize dashboard
RUN_ID=$(date +%Y%m%d-%H%M%S)-research-loop
DASHBOARD=".aris/runs/$RUN_ID/dashboard.json"
WORKERS_DIR=".aris/runs/$RUN_ID/workers"
mkdir -p "$WORKERS_DIR"

# Initialize dashboard.json per schema in shared-references/worker-manifest.md
# Fields: run_id, status="running", iteration=0, max_iterations, metric{target,unit,tolerance,current,baseline,history},
#         best_idea, last_review{verdict,score,metric_progress,reviewer_id}, gaps{open,closed},
#         consecutive_pivots=0, stop_reason=null, phases_completed=[], started_at, updated_at

# 0e. Initialize run-state
node "$RUN_STATE" start "$ROOT" "$RUN_ID" \
    --phases "preconditions,idea-discovery,experiment-bridge,analyze-results,auto-review,metric-eval,gap-analysis,summary"
node "$RUN_STATE" set "$ROOT" "$RUN_ID" preconditions done \
    --artifact "$ROOT/$DASHBOARD"
```

---

## Phase 1: Idea Discovery

Dispatch `/idea-discovery` with context about the research direction, open gaps, and prior iteration history.

| Input | Path |
|-------|------|
| claude_md | `$ROOT/CLAUDE.md` |
| research_brief | `$ROOT/RESEARCH_BRIEF.md` |
| baseline_plan | `$ROOT/$BASELINE_PLAN` |
| query_pack | `$ROOT/research-wiki/query_pack.md` |
| gap_map | `$ROOT/research-wiki/gap_map.md` |
| wiki_index | `$ROOT/research-wiki/index.md` |
| prior_iterations | `dashboard.metric.history` (inline from dashboard) |

Context: `target_metric`, `target_unit`, `open_gaps` (from dashboard), `iteration_context` (`baseline_improvement` if iter 1, else `gap_targeted`)

Output: `idea_report` at `$ROOT/idea-stage/IDEA_REPORT.md`

Dispatch: `/<idea-discovery> -- manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `best_idea`, `idea_ids`, `ideas[]`

**Post-receipt wiki writes:** For each `idea_id` in `dashboard_patch.idea_ids`, call `node "$WIKI_SCRIPT" upsert_idea research-wiki/ --id "$idea_id" --title "$TITLE"`.

Follow the standard dispatch pattern (Dispatch Pattern section above).

---

## Phase 2: Experiment Bridge

Dispatch `/experiment-bridge` to implement and run experiments from the idea report.

| Input | Path |
|-------|------|
| experiment_plan | `$ROOT/$BASELINE_PLAN` (iter 1) or `$ROOT/refine-logs/EXPERIMENT_PLAN-iter-${ITERATION}.md` (iter 2+) |
| idea_report | `$ROOT/idea-stage/IDEA_REPORT.md` |
| experiment_skill | `$ROOT/.claude/skills/run-${PROJECT_NAME}-experiment/env.json` |

Context: `is_baseline` (true if iter 1), `target_metric`, `target_unit`

Output: `tracker` at `refine-logs/EXPERIMENT_TRACKER.md`, `results` at `refine-logs/EXPERIMENT_RESULTS.md`

Dispatch: `/experiment-bridge -- manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `primary_metric` (set as `metric.baseline` on iter 1 only), `experiment_ids`, `experiments[]`

**Post-receipt wiki writes:** For each `exp_id` in `dashboard_patch.experiment_ids`, call `node "$WIKI_SCRIPT" add_experiment research-wiki/ --id "$exp_id" --title "$TITLE" --status completed`.

---

## Phase 2.5: Analyze Results

Dispatch `/analyze-results` to extract the authoritative metric value from experiment outputs.

| Input | Path |
|-------|------|
| tracker | `$ROOT/refine-logs/EXPERIMENT_TRACKER.md` |
| results | `$ROOT/refine-logs/EXPERIMENT_RESULTS.md` |
| prior_metrics | `dashboard.metric.history` (inline from dashboard) |

Context: `target_metric`, `target_unit`

Output: `analysis` at `$ROOT/refine-logs/ANALYSIS-iter-${ITERATION}.md`

Dispatch: `/analyze-results -- manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `primary_metric`, `metric_delta`, `statistical_significance`

**Post-receipt dashboard merge:** The analyze-results receipt is the AUTHORITATIVE source for `metric.current`. Apply:
```
.metric.current = $patch.primary_metric
.metric.history += [{"iteration": .iteration, "value": $patch.primary_metric, "timestamp": now}]
```

---

## Phase 3: Auto Review

Dispatch `/auto-review-loop` for cross-model review of the iteration's results.

| Input | Path |
|-------|------|
| analysis | `$ROOT/refine-logs/ANALYSIS-iter-${ITERATION}.md` |
| tracker | `$ROOT/refine-logs/EXPERIMENT_TRACKER.md` |
| results | `$ROOT/refine-logs/EXPERIMENT_RESULTS.md` |
| idea_report | `$ROOT/idea-stage/IDEA_REPORT.md` |

Context: `target_metric`, `target_unit`, `reviewer_model` (`gpt-5.5`), `reviewer_bias_guard` (true), `max_review_rounds` (4)

Output: `review` at `$ROOT/research-iteration/review-iter-${ITERATION}.json`

Dispatch: `/auto-review-loop -- manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `verdict`, `score`, `metric_progress`, `reviewer_id` (merged into `last_review.*`)

---

## Phase 4: Metric Evaluation

**Pure arithmetic on dashboard fields. NO file reads. NO external tool calls. NO dispatch.**

The orchestrator reads `dashboard.json` and evaluates the compound stop gate.

### Type-A: Deterministic (dashboard fields only)

```bash
# Read ALL values from dashboard — never from files
CURRENT=$(jq -r '.metric.current' "$DASHBOARD")
TARGET=$(jq -r '.metric.target' "$DASHBOARD")
TOLERANCE=$(jq -r '.metric.tolerance' "$DASHBOARD")
ITERATION=$(jq -r '.iteration' "$DASHBOARD")
MAX_ITER=$(jq -r '.max_iterations' "$DASHBOARD")
CONSEC_PIVOTS=$(jq -r '.consecutive_pivots' "$DASHBOARD")
VERDICT=$(jq -r '.last_review.verdict' "$DASHBOARD")

THRESHOLD=$(echo "$TARGET * (1 - $TOLERANCE)" | bc -l)

METRIC_MET=false
[ "$(echo "$CURRENT >= $THRESHOLD" | bc -l)" = "1" ] && METRIC_MET=true

BUDGET_EXHAUSTED=false
[ "$ITERATION" -ge "$MAX_ITER" ] && BUDGET_EXHAUSTED=true

# Update consecutive pivots
if [ "$VERDICT" = "pivot" ]; then
    CONSEC_PIVOTS=$((CONSEC_PIVOTS + 1))
else
    CONSEC_PIVOTS=0
fi
PATIENCE_EXCEEDED=false
[ "$CONSEC_PIVOTS" -ge 2 ] && PATIENCE_EXCEEDED=true

TYPE_A_FIRES=false
[ "$METRIC_MET" = "true" ] || [ "$BUDGET_EXHAUSTED" = "true" ] || [ "$PATIENCE_EXCEEDED" = "true" ] && TYPE_A_FIRES=true
```

### Type-B: Codex verdict (dashboard fields only)

```bash
TYPE_B_FIRES=false
REVIEW_VERDICT=$(jq -r '.last_review.verdict' "$DASHBOARD")
REVIEW_SCORE=$(jq -r '.last_review.score' "$DASHBOARD")
REVIEW_PROGRESS=$(jq -r '.last_review.metric_progress' "$DASHBOARD")
REVIEWER_ID=$(jq -r '.last_review.reviewer_id' "$DASHBOARD")

if [ "$REVIEW_VERDICT" = "stop" ] && [ "$REVIEW_SCORE" -ge 9 ] && [ "$REVIEW_PROGRESS" = "met target" ]; then
    if echo "$REVIEWER_ID" | grep -qE '^claude'; then
        echo "TRIPWIRE: reviewer resolved to Claude. Type-B rejected."
    else
        TYPE_B_FIRES=true
    fi
fi
```

### Compound gate

| Type-A | Type-B | Result |
|--------|--------|--------|
| true | true | `stop_reason = "compound_gate"` |
| true | false | `stop_reason = "deterministic:research-iteration:max-iter-reached"` |
| false | true | Log "reviewer conservative" and continue |
| false | false | Continue to Phase 5 |

Update dashboard: `consecutive_pivots`, `stop_reason`, `status` ("stopped" if stop_reason set, else "running").

If `stop_reason` is non-empty -> skip Phase 5, proceed to Phase 6.
If `stop_reason` is empty -> proceed to Phase 5.

---

## Phase 5: Gap Analysis (if continuing)

When the compound gate does not fire, dispatch `/kill-argument` to identify unresolved problems and generate the next iteration's experiment plan.

| Input | Path |
|-------|------|
| results_dir | `$ROOT/refine-logs/` |
| gap_map | `$ROOT/research-wiki/gap_map.md` |
| analysis | `$ROOT/refine-logs/ANALYSIS-iter-${ITERATION}.md` |

Context: `gap_output` (`research-wiki/gap_map.md`), `plan_output` (`refine-logs/EXPERIMENT_PLAN-iter-${NEXT_ITERATION}.md`), `render_html` (false)

Dispatch: `/kill-argument -- manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `open_gaps`, `closed_gaps`, `plan_path`, `overall_verdict`

**Post-receipt actions:**
1. Merge gap updates into `dashboard.gaps`
2. Rebuild query pack: `node "$WIKI_SCRIPT" rebuild_query_pack research-wiki/`
3. Increment iteration: `dashboard.iteration = NEXT_ITERATION`
4. Loop back to Phase 1

---

## Phase 6: Summary (on stop)

When the loop exits, dispatch `/render-html` with a narrative-report manifest.

| Input | Path |
|-------|------|
| dashboard | `$ROOT/$DASHBOARD` |
| wiki | `$ROOT/research-wiki/` |
| gap_map | `$ROOT/research-wiki/gap_map.md` |

Context: `stop_reason`, `total_iterations`, `final_metric`, `target_metric`, `metric_history` (all from dashboard)

Output: `report` at `$ROOT/research-iteration/NARRATIVE_REPORT.md`

Schema requirement: `required_sections = ["metric_trajectory", "stop_reason", "iteration_log", "open_gaps", "closed_gaps", "artifacts"]`

Dispatch: `/render-html -- manifest: $WORKER_DIR/input-manifest.json`

**Post-receipt:** Mark dashboard `status = "completed"`. Run acceptance:
```bash
REVIEWER_ID=$(jq -r '.last_review.reviewer_id // "deterministic:research-iteration:max-iter-reached"' "$DASHBOARD")
node "$RUN_STATE" accept "$ROOT" "$RUN_ID" research-iteration \
    --verdict-id "$REVIEWER_ID" --reviewer "$REVIEWER_ID"
```

---

## Phase 7: Paper Writing (optional)

Gate: `metric.current >= metric.target * (1 - tolerance)` AND `iteration >= 2`.

If both conditions met and `AUTO_WRITE=true`, dispatch `/paper-writing`.

| Input | Path |
|-------|------|
| narrative_report | `$ROOT/research-iteration/NARRATIVE_REPORT.md` |
| wiki | `$ROOT/research-wiki/` |
| results | `$ROOT/refine-logs/EXPERIMENT_RESULTS.md` |
| dashboard | `$ROOT/$DASHBOARD` |

Context: `metric_trajectory`, `final_metric`, `target_metric` (from dashboard)

Output: `paper_dir` at `$ROOT/paper/`

---

## Resume Protocol

```bash
if [ -n "$ARG_RESUME" ]; then
    RUN_ID="$ARG_RESUME"
    DASHBOARD=".aris/runs/$RUN_ID/dashboard.json"
    WORKERS_DIR=".aris/runs/$RUN_ID/workers"
    ITERATION=$(jq -r '.iteration' "$DASHBOARD")
    STATUS=$(jq -r '.status' "$DASHBOARD")

    if [ "$STATUS" = "stopped" ] || [ "$STATUS" = "completed" ]; then
        echo "Run $RUN_ID already completed (status: $STATUS). Nothing to resume."
        exit 0
    fi

    # Determine last completed phase and jump to the next one
    LAST_PHASE=$(jq -r '.phases_completed[-1] // "preconditions"' "$DASHBOARD")
    echo "Resuming run $RUN_ID from iteration $ITERATION, after phase: $LAST_PHASE"
fi
```

**Stale-state recovery:** If dashboard `updated_at` is older than 24h, start a fresh run instead of resuming.

---

## Compound Stop Gate

> **Type-A (deterministic):** `dashboard.metric.current >= dashboard.metric.target * (1 - TOLERANCE)` OR `dashboard.iteration >= MAX_ITERATIONS` OR `dashboard.consecutive_pivots >= PATIENCE`. Pure arithmetic on dashboard fields.
>
> **Type-B (codex verdict):** Fresh codex reviewer confirms `verdict=stop`, `score >= 9`, `metric_progress=met target`. Cross-model, never self-acquittal.
>
> **STOP = Type-A AND Type-B.** Neither alone is sufficient. Type-A without Type-B uses `deterministic:research-iteration:max-iter-reached`. Type-B without Type-A means the reviewer is conservative — log and continue.

---

## Critical Rules

1. **Orchestrator reads ONLY dashboard.json + receipt.json.** Never reads experiment logs, result files, review prose, tracker markdown, or any worker output file. All information flows through the manifest->receipt->dashboard_patch pipeline. If the orchestrator is about to `cat`, `awk`, or `grep` a worker output — it is violating Rule 5.

2. **Minimal dispatch prompts.** Worker dispatch prompt is ONLY the skill name + manifest path. All context goes in `input-manifest.json`. No extra instructions, no file paths in the prompt, no inline context.

3. **dashboard_patch is the only write contract.** Workers emit `dashboard_patch` in their receipt. The orchestrator merges this into `dashboard.json`. Workers never write to `dashboard.json` directly.

4. **Gate arithmetic uses dashboard fields only (Phase 4).** Every comparison value is read from `dashboard.json`. Never from files, never from receipts at gate-evaluation time (receipts are already merged before Phase 4 runs).

5. **Fresh codex reviewer per iteration (REVIEWER_BIAS_GUARD).** Every iteration creates a fresh codex sub-agent. Iteration N's review does NOT see iteration N-1's review.

6. **No in-process Skill calls (Rule 4).** All sub-skill dispatch via `mcp__paseo__create_agent`. No fallbacks, no inline execution.

7. **Archive sub-agents after receipt read.** Every child agent is archived once its receipt has been processed. No lingering sub-agents.

8. **Canonical wiki writes only.** Ideas, experiments, edges go through `research-wiki.js`. Gaps come exclusively from `/kill-argument` dispatch.

9. **One long-lived agent, loops internally.** This skill runs as ONE paseo agent. Do NOT wrap in `/loop` / `create_heartbeat`.

10. **Self-acquittal tripwire.** Never accept on a Claude reviewer. Require `codex-gpt-5.5` or `deterministic:` prefix for budget-exhausted stops.

11. **Patience enforcement.** `consecutive_pivots >= PATIENCE` (2) forces stop via Type-A. Pure dashboard arithmetic.

12. **Codex verdict is never overridden.** Type-B without Type-A -> log and continue. Type-A without Type-B -> deterministic acceptance. Parent never reinterprets.

13. **Input-manifest is the COMPLETE context.** Workers should be able to do their job reading only their manifest. If a worker needs something not in its manifest, fix the manifest, not the dispatch prompt.

14. **Receipt schema is a contract.** Each worker MUST emit `dashboard_patch` with the fields its phase documents. Missing `dashboard_patch` = worker failure.

---

## External Dependencies

### Infrastructure tools
- `src/tools/research-wiki.ts` — `init`, `slug`, `ingest_paper`, `sync`, `add_claim`, `upsert_idea`, `add_experiment`, `add_edge`, `rebuild_query_pack`, `rebuild_index`, `stats`, `log`
- `src/tools/run-state.ts` — `start`, `set`, `accept`, `status`, `resumePoint`
- `src/tools/iteration-log.ts` — `note`
- `src/tools/provenance.ts` — `stamp`

### Dispatched sub-skills
- `skills/idea-discovery/SKILL.md` — Full idea discovery pipeline
- `skills/idea-creator/SKILL.md` — Gap-targeted idea generation
- `skills/experiment-bridge/SKILL.md` — Implements and runs experiments
- `skills/analyze-results/SKILL.md` — Structured analysis with metric extraction
- `skills/auto-review-loop/SKILL.md` — Multi-round review with fix cycle
- `skills/kill-argument/SKILL.md` — Adversarial attack, gap output, diagnostic plan
- `skills/paper-writing/SKILL.md` — End-to-end paper generation (optional)
- `skills/render-html/SKILL.md` — HTML rendering

### Shared references
- `shared-references/paseo-subagent-dispatch.md` — Rules 1-4 (dispatch protocol)
- `shared-references/worker-manifest.md` — Rule 5 (manifest protocol, receipt schema, dashboard schema)
- `shared-references/paseo-reviewer-dispatch.md` — Fresh-thread bias guard
- `shared-references/external-cadence.md` — The fence (no wrapping in `/loop`)
- `shared-references/acceptance-gate.md` — Type-A vs Type-B gate classification
