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

Every phase follows the same cycle. This is shown once here; each phase section
below specifies only what differs (inputs, context, dispatch skill).
Phases 1-5 use the iteration-scoped directory shown below. The non-repeating
`summary` and `paper-writing` phases explicitly override `WORKER_DIR` with their
stable outer-lifecycle directories so resume always finds the same receipt.

For the full manifest and receipt JSON schemas, see `shared-references/worker-manifest.md`.

```
1. WORKER_DIR="$WORKERS_DIR/${ITERATION}-<phase-name>"
   mkdir -p "$WORKER_DIR/outputs"

2. Update dashboard: current_phase = "<phase-name>", updated_at = now.

3. Write $WORKER_DIR/input-manifest.json with:
   - worker: <skill-name>, iteration, run_id (standard header)
   - inputs: file paths the worker needs (phase-specific, see tables below)
   - context: scalar context values (phase-specific)
   - output_dir: "$WORKER_DIR/outputs"

4. Dispatch via mcp__paseo__create_agent:
   title: "research-loop-iter-${ITERATION}-<phase-name>"
   provider: "claude/claude-sonnet-4-6"
   initialPrompt: "/<skill-name> — manifest: $WORKER_DIR/input-manifest.json"
   notifyOnFinish: true

5. Wait for completion notification.

6. Read $WORKER_DIR/receipt.json:
   - If status=failed → log and decide (retry or stop)
   - Check idempotency: if "$WORKER_DIR/receipt.json" is already in
     dashboard.applied_receipts, skip the merge (crash-safe resume guard).
   - Merge dashboard_patch into $DASHBOARD (dot-notation-aware, per
     worker-manifest.md merge algorithm).
   - Append "$WORKER_DIR/receipt.json" to dashboard.applied_receipts.
   - Update dashboard: current_phase = "<phase-name>", updated_at = now.

Error tracking: If receipt.has_errors == true, update dashboard:
dashboard.system_errors.total += receipt.error_count and
dashboard.system_errors.last = "<iter>-<phase>". The orchestrator does NOT
read progress_error.md (Rule 5).

7. Archive the worker: mcp__paseo__archive_agent
```

## State Machine Design

### Why run-state tracks the outer lifecycle only

The iteration loop reuses phases (idea-discovery runs in every iteration). If
run-state tracked per-iteration phases as static entries, a crash between
"gap-analysis accepted" and "next iteration's idea-discovery reset" would cause
resume to skip to summary. Instead:

- **run-state** tracks 4 non-repeating lifecycle phases: `init, loop, summary, paper-writing`.
- **dashboard.json** tracks iteration progress: `iteration`, `current_phase`,
  `stop_reason`. The orchestrator reads these on resume to determine where
  within the loop to continue.
- The `loop` phase is `running` while iterations execute and `done` when the
  stop gate fires. It is `accepted` only after summary completes.

### Phase lifecycle and terminal states

| run-state phase | When `done` | When `accepted` | When `skipped` |
|---|---|---|---|
| `init` | Preconditions validated, dashboard created | Deterministic: dashboard exists | Never |
| `loop` | Stop gate fired (metric met / budget exhausted / patience exceeded) | After summary phase completes successfully | Never |
| `summary` | NARRATIVE_REPORT.md written | Deterministic or codex reviewer | Never |
| `paper-writing` | Paper compiled and audits pass | `deterministic:verify_paper_audits.sh` | `AUTO_WRITE=false` |

### Dashboard iteration tracking

The dashboard tracks intra-iteration state for crash-safe resume:

| Field | Purpose |
|---|---|
| `iteration` | Current iteration number (1-based) |
| `current_phase` | Last completed or in-progress phase within the iteration |
| `status` | `running` / `finishing` / `completed` |
| `stop_reason` | `null` while looping; set when stop gate fires |
| `config` | Immutable run inputs needed after restart: baseline path, auto-write/render flags, patience |

**Status values:**
- `running` — iteration loop is active
- `finishing` — stop gate fired, summary/paper-writing in progress
- `completed` — all terminal phases reached

On resume, `status=finishing` means: skip the loop, continue from summary.
Only `status=completed` means nothing to do.

## Phase Diagram

```
init        Validate preconditions + Initialize dashboard + run-state
loop        --- Iteration loop (1 -> MAX_ITERATIONS) ---
              Phase 1     Idea Discovery
              Phase 2     Experiment Bridge
              Phase 2.5   Analyze Results
              Phase 3     Auto Review
              Phase 4     Metric Evaluation (pure arithmetic — NO dispatch)
              Phase 5     Gap Analysis (skipped if stop gate fires)
            --- End loop (stop gate fires) ---
summary     Phase 6     Summary report
paper-writing  Phase 7  Paper Writing (optional)
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

## Phase 0: Preconditions + Initialize

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1
ROOT=$(pwd)

# Resolve ARIS_REPO
if [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi
WIKI_SCRIPT="$ARIS_REPO/dist/tools/research-wiki.js"
RUN_STATE="$ARIS_REPO/dist/tools/run-state.js"

# Preconditions are a callable step. Fresh start calls it once; resume calls it
# only when run-state reports the unfinished `init` phase.
run_preconditions() {
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
    mcp__paseo__create_agent
      title: "env-manager: setup $PROJECT_NAME"
      provider: claude
      initialPrompt: "/experiment-env-manager — project: $PROJECT_NAME — mode: setup"
      notifyOnFinish: true
    # Verify env.json after completion
    if [ -f "$ENV_JSON" ] && [ "$(jq -r '.status' "$ENV_JSON")" = "complete" ]; then
        ENV_CONFIGURED=true
    else
        echo "ERROR: env-manager did not produce experiment skill. Cannot proceed."
        exit 1
    fi
fi

# 0c. Locate baseline plan
BASELINE_PLAN="${BASELINE_PLAN:-${ARG_BASELINE:-refine-logs/EXPERIMENT_PLAN.md}}"
if [ ! -f "$BASELINE_PLAN" ]; then
    echo "ERROR: Baseline plan not found at $BASELINE_PLAN"
    exit 1
fi
}
```

### Fresh start vs Resume

```bash
if [ -n "$ARG_RESUME" ]; then
    # ---- RESUME PATH ----
    RUN_ID="$ARG_RESUME"
    DASHBOARD=".aris/runs/$RUN_ID/dashboard.json"
    WORKERS_DIR=".aris/runs/$RUN_ID/workers"

    if [ ! -f "$DASHBOARD" ]; then
        echo "ERROR: No dashboard at $DASHBOARD. Cannot resume."
        exit 1
    fi

    STATE_FILE=".aris/runs/$RUN_ID.json"
    if [ ! -f "$STATE_FILE" ]; then
        INIT_ONLY=$(jq -r '(.current_phase == "init") and ((.applied_receipts // []) | length == 0)' "$DASHBOARD")
        if [ "$INIT_ONLY" != "true" ]; then
            echo "ERROR: run-state is missing after work started; acceptance provenance cannot be reconstructed."
            exit 1
        fi
        node "$RUN_STATE" start "$ROOT" "$RUN_ID" \
            --phases "init,loop,summary,paper-writing"
    fi

    # Use run-state for outer lifecycle
    RESUME_OUTER=$(node "$RUN_STATE" resume "$ROOT" "$RUN_ID")
    if [ "$RESUME_OUTER" = "COMPLETE" ]; then
        jq '.status = "completed" | .updated_at = (now | todateiso8601)' \
            "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
        echo "Run $RUN_ID: all phases accepted/skipped. Nothing to resume."
        exit 0
    fi

    STATUS=$(jq -r '.status' "$DASHBOARD")
    ITERATION=$(jq -r '.iteration' "$DASHBOARD")
    CURRENT_PHASE=$(jq -r '.current_phase' "$DASHBOARD")
    BASELINE_PLAN=$(jq -r '.config.baseline_plan // "refine-logs/EXPERIMENT_PLAN.md"' "$DASHBOARD")
    AUTO_WRITE=$(jq -r '.config.auto_write // false' "$DASHBOARD")
    RENDER_HTML=$(jq -r '.config.render_html // true' "$DASHBOARD")
    PATIENCE=$(jq -r '.config.patience // 2' "$DASHBOARD")

    if [ "$STATUS" = "completed" ]; then
        echo "ERROR: dashboard is completed but run-state still requires $RESUME_OUTER. Refusing to skip an acceptance obligation."
        exit 1
    fi

    if [ "$RESUME_OUTER" = "init" ]; then
        run_preconditions
        node "$RUN_STATE" set "$ROOT" "$RUN_ID" init done --artifact "$ROOT/$DASHBOARD"
        node "$RUN_STATE" accept "$ROOT" "$RUN_ID" init \
            --verdict-id "deterministic:preconditions" --reviewer "deterministic:preconditions"
        node "$RUN_STATE" set "$ROOT" "$RUN_ID" loop running
        jq '.status = "running" | .current_phase = "idea-discovery" | .updated_at = (now | todateiso8601)' \
            "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
        RESUME_OUTER="loop"
        STATUS="running"
        CURRENT_PHASE="idea-discovery"
    fi

    echo "Resuming run $RUN_ID: outer=$RESUME_OUTER, iteration=$ITERATION, phase=$CURRENT_PHASE, status=$STATUS"

    # Determine where to jump:
    # - outer=init → run 0a-0c now, then mark init done+accepted and set loop running
    # - outer=loop, status=running → resume iteration loop at current_phase
    # - outer=loop, status=finishing → skip loop, go to summary
    # - outer=summary → resume summary
    # - outer=paper-writing → resume paper-writing

else
    # ---- FRESH START PATH ----
    RUN_ID=$(date +%Y%m%d-%H%M%S)-research-loop
    DASHBOARD=".aris/runs/$RUN_ID/dashboard.json"
    WORKERS_DIR=".aris/runs/$RUN_ID/workers"
    mkdir -p "$WORKERS_DIR"

    BASELINE_PLAN="${ARG_BASELINE:-refine-logs/EXPERIMENT_PLAN.md}"
    AUTO_WRITE=${AUTO_WRITE:-false}
    RENDER_HTML=${RENDER_HTML:-true}
    PATIENCE=${PATIENCE:-2}
    run_preconditions

    # Persist the dashboard first. `init` remains pending until both stores exist.
    cat > "$DASHBOARD" <<DASH
{
  "run_id": "$RUN_ID",
  "project": "$PROJECT_NAME",
  "status": "running",
  "iteration": 1,
  "max_iterations": ${ARG_MAX_ITERATIONS:-5},
  "current_phase": "init",
  "config": {
    "baseline_plan": "$BASELINE_PLAN",
    "auto_write": $AUTO_WRITE,
    "render_html": $RENDER_HTML,
    "patience": $PATIENCE
  },
  "metric": {
    "name": "$TARGET_UNIT",
    "target": $TARGET_METRIC,
    "direction": "higher_better",
    "tolerance": 0.01,
    "current": null,
    "baseline": null,
    "history": []
  },
  "best_idea": null,
  "gaps": { "open": [], "closed": [], "total": 0 },
  "last_review": { "verdict": null, "score": null, "metric_progress": null, "reviewer_id": null },
  "consecutive_pivots": 0,
  "stop_reason": null,
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "system_errors": { "total": 0, "last": null },
  "applied_receipts": []
}
DASH

    # Initialize run-state with outer lifecycle phases only.
    node "$RUN_STATE" start "$ROOT" "$RUN_ID" \
        --phases "init,loop,summary,paper-writing"

    # Mark init done + accepted (deterministic: preconditions validated)
    node "$RUN_STATE" set "$ROOT" "$RUN_ID" init done \
        --artifact "$ROOT/$DASHBOARD"
    node "$RUN_STATE" accept "$ROOT" "$RUN_ID" init \
        --verdict-id "deterministic:preconditions" --reviewer "deterministic:preconditions"

    # Mark loop as running (the iteration loop is now active)
    node "$RUN_STATE" set "$ROOT" "$RUN_ID" loop running
fi
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

Output: `IDEA_REPORT.md` in `$WORKER_DIR/outputs/`

Dispatch: `/idea-discovery — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `best_idea`, `idea_ids`

**Post-receipt wiki writes:** For each `idea_id` in `dashboard_patch.idea_ids`, call `node "$WIKI_SCRIPT" upsert_idea research-wiki/ --id "$idea_id" --title "$TITLE"`.

Follow the standard dispatch pattern (Dispatch Pattern section above).

---

## Phase 2: Experiment Bridge

Dispatch `/experiment-bridge` to implement and run experiments from the idea report.

| Input | Path |
|-------|------|
| experiment_plan | `$ROOT/$BASELINE_PLAN` (iter 1) or prior gap-analysis output: `$WORKERS_DIR/${PREV_ITERATION}-gap-analysis/outputs/EXPERIMENT_PLAN.md` (iter 2+) |
| idea_report | `$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/IDEA_REPORT.md` |
| experiment_skill | `$ROOT/.claude/skills/run-${PROJECT_NAME}-experiment/env.json` |

Context: `is_baseline` (true if iter 1), `target_metric`, `target_unit`

Output: `EXPERIMENT_RESULTS.md`, `EXPERIMENT_TRACKER.md` in `$WORKER_DIR/outputs/`

Dispatch: `/experiment-bridge — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `primary_metric` (set as `metric.baseline` on iter 1 only), `experiment_ids`

**Post-receipt wiki writes:** For each `exp_id` in `dashboard_patch.experiment_ids`, call `node "$WIKI_SCRIPT" add_experiment research-wiki/ --id "$exp_id" --title "$TITLE" --status completed`.

---

## Phase 2.5: Analyze Results

Dispatch `/analyze-results` to extract the authoritative metric value from experiment outputs.

| Input | Path |
|-------|------|
| tracker | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_TRACKER.md` |
| results | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_RESULTS.md` |
| prior_metrics | `dashboard.metric.history` (inline from dashboard) |

Context: `target_metric`, `target_unit`

Output: `EXPERIMENT_RESULTS.md` in `$WORKER_DIR/outputs/`

Dispatch: `/analyze-results — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `primary_metric`, `metric_delta`, `statistical_significance`

**Post-receipt dashboard merge:** The analyze-results receipt is the AUTHORITATIVE source for `metric.current`. Apply (with idempotency guard per worker-manifest.md merge algorithm):
```
.metric.current = $patch.primary_metric
# Only append if no entry for this iteration exists yet:
if not any(h.iter == ITERATION for h in .metric.history):
    .metric.history += [{"iter": ITERATION, "value": $patch.primary_metric, "timestamp": now}]
```

---

## Phase 3: Auto Review

Dispatch `/auto-review-loop` for cross-model review of the iteration's results.

| Input | Path |
|-------|------|
| analysis | `$WORKERS_DIR/${ITERATION}-analyze-results/outputs/EXPERIMENT_RESULTS.md` |
| tracker | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_TRACKER.md` |
| results | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_RESULTS.md` |
| idea_report | `$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/IDEA_REPORT.md` |

Context: `target_metric`, `target_unit`, `reviewer_model` (`gpt-5.5`), `reviewer_bias_guard` (true), `max_review_rounds` (4)

Output: `AUTO_REVIEW.md` in `$WORKER_DIR/outputs/`

Dispatch: `/auto-review-loop — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `last_review.verdict`, `last_review.score`, `last_review.metric_progress`, `last_review.reviewer_id`

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
PATIENCE=$(jq -r '.config.patience // 2' "$DASHBOARD")
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
[ "$CONSEC_PIVOTS" -ge "$PATIENCE" ] && PATIENCE_EXCEEDED=true

TYPE_A_FIRES=false
if [ "$METRIC_MET" = "true" ] || [ "$BUDGET_EXHAUSTED" = "true" ] || [ "$PATIENCE_EXCEEDED" = "true" ]; then
    TYPE_A_FIRES=true
fi
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

Update dashboard: `consecutive_pivots`, `stop_reason`.

If `stop_reason` is non-empty:
  1. Set dashboard `status = "finishing"` (not `completed` — summary still pending).
  2. Mark the `loop` run-state phase as done:
     ```bash
     node "$RUN_STATE" set "$ROOT" "$RUN_ID" loop done \
         --artifact "$ROOT/$DASHBOARD"
     ```
  3. Proceed to Phase 6 (Summary).

If `stop_reason` is empty → proceed to Phase 5.

---

## Phase 5: Gap Analysis (if continuing)

When the compound gate does not fire, dispatch `/kill-argument` to identify unresolved problems and generate the next iteration's experiment plan.

| Input | Path |
|-------|------|
| analysis | `$WORKERS_DIR/${ITERATION}-analyze-results/outputs/EXPERIMENT_RESULTS.md` |
| tracker | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_TRACKER.md` |
| results | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_RESULTS.md` |
| gap_map | `$ROOT/research-wiki/gap_map.md` |

Context: `gap_output` (`research-wiki/gap_map.md`), `plan_output` (relative: `EXPERIMENT_PLAN.md`), `render_html` (false)

Output: `EXPERIMENT_PLAN.md`, updated `gap_map.md` in `$WORKER_DIR/outputs/`

Dispatch: `/kill-argument — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `gaps.open`, `gaps.closed`, `gaps.total`, `plan_path`, `overall_verdict`

**Post-receipt actions:**
1. Dashboard merge (already done in step 6 of dispatch pattern)
2. Copy updated gap_map back to wiki: `cp "$WORKER_DIR/outputs/gap_map.md" "$ROOT/research-wiki/gap_map.md"`
3. Rebuild query pack: `node "$WIKI_SCRIPT" rebuild_query_pack research-wiki/`
4. Increment iteration: update dashboard `.iteration = ${NEXT_ITERATION}`, `.current_phase = "idea-discovery"`
5. Loop back to Phase 1

---

## Phase 6: Summary (on stop)

When the loop exits (`dashboard.status = "finishing"`), generate the narrative
report. This is a **summary sub-agent** (not `/render-html` — that skill renders
existing markdown but cannot generate new content).

```bash
WORKER_DIR="$WORKERS_DIR/summary"
mkdir -p "$WORKER_DIR/outputs"
```

The orchestrator dispatches a claude sub-agent with a prompt to write
`NARRATIVE_REPORT.md` from the dashboard and wiki state. The sub-agent reads
the inputs, generates the report to `$WORKER_DIR/outputs/`, and writes its receipt.

| Input | Path |
|-------|------|
| dashboard | `$ROOT/$DASHBOARD` |
| wiki_index | `$ROOT/research-wiki/index.md` |
| gap_map | `$ROOT/research-wiki/gap_map.md` |
| last_analysis | `$WORKERS_DIR/${ITERATION}-analyze-results/outputs/EXPERIMENT_RESULTS.md` |
| last_review | `$WORKERS_DIR/${ITERATION}-auto-review/outputs/AUTO_REVIEW.md` |

Context: `stop_reason`, `total_iterations`, `final_metric`, `target_metric`, `metric_history` (all from dashboard)

Output: `NARRATIVE_REPORT.md` in `$WORKER_DIR/outputs/`

Dispatch: summary sub-agent via `mcp__paseo__create_agent` with prompt:
```
Generate NARRATIVE_REPORT.md from the provided inputs. Required sections:
metric_trajectory, stop_reason, iteration_log, open_gaps, closed_gaps, artifacts.
Write to the output_dir specified in the manifest. Write receipt.json when done.
```

**Post-receipt (optional):** If `RENDER_HTML=true`, dispatch `/render-html` to render
the generated `NARRATIVE_REPORT.md` to HTML (non-blocking, failure is logged
but does not block acceptance).

**Run-state transitions:** Accept the `loop` phase (the iteration loop is now
fully audited by the summary), then mark `summary` done + accepted:
```bash
REVIEWER_ID=$(jq -r '.last_review.reviewer_id // "deterministic:research-loop:completed"' "$DASHBOARD")
node "$RUN_STATE" accept "$ROOT" "$RUN_ID" loop \
    --verdict-id "$REVIEWER_ID" --reviewer "$REVIEWER_ID"

node "$RUN_STATE" set "$ROOT" "$RUN_ID" summary done \
    --artifact "$WORKER_DIR/outputs/NARRATIVE_REPORT.md"
node "$RUN_STATE" accept "$ROOT" "$RUN_ID" summary \
    --verdict-id "deterministic:summary" --reviewer "deterministic:summary"
```

---

## Phase 7: Paper Writing (optional)

Gate: `metric.current >= metric.target * (1 - tolerance)` AND `iteration >= 2`.

**AUTO_WRITE=false (default):**
```bash
node "$RUN_STATE" set "$ROOT" "$RUN_ID" paper-writing skipped
# Update dashboard status to completed
jq '.status = "completed"' "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
```
Resume now reports COMPLETE (all 4 outer phases are terminal).

**AUTO_WRITE=true AND gate passes:**
Dispatch `/paper-writing` as a worker.

```bash
WORKER_DIR="$WORKERS_DIR/paper-writing"
mkdir -p "$WORKER_DIR/outputs"
```

| Input | Path |
|-------|------|
| narrative_report | `$WORKERS_DIR/summary/outputs/NARRATIVE_REPORT.md` |
| wiki | `$ROOT/research-wiki/` |
| results | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_RESULTS.md` |
| dashboard | `$ROOT/$DASHBOARD` |

Context: `metric_trajectory`, `final_metric`, `target_metric` (from dashboard)

Output: `paper_dir` at `$WORKERS_DIR/paper-writing/outputs/paper/`

Post-receipt:
```bash
node "$RUN_STATE" set "$ROOT" "$RUN_ID" paper-writing done \
    --artifact "$WORKERS_DIR/paper-writing/outputs/paper/"
# Accept only after the deterministic audit passes.
verify_paper_audits.sh "$WORKERS_DIR/paper-writing/outputs/paper/" --assurance submission
node "$RUN_STATE" accept "$ROOT" "$RUN_ID" paper-writing \
    --verdict-id "deterministic:verify_paper_audits.sh" \
    --reviewer "deterministic:verify_paper_audits.sh"
jq '.status = "completed"' "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
```

**AUTO_WRITE=true BUT gate fails:**
```bash
node "$RUN_STATE" set "$ROOT" "$RUN_ID" paper-writing skipped
jq '.status = "completed"' "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
```

---

## Resume Protocol

Resume uses two sources: **run-state** for the outer lifecycle and **dashboard**
for intra-iteration progress.

```bash
# Outer lifecycle: which non-repeating phase to resume at
RESUME_OUTER=$(node "$RUN_STATE" resume "$ROOT" "$RUN_ID")
# Intra-iteration: which phase within the iteration was in progress
ITERATION=$(jq -r '.iteration' "$DASHBOARD")
CURRENT_PHASE=$(jq -r '.current_phase' "$DASHBOARD")
STATUS=$(jq -r '.status' "$DASHBOARD")
```

| `RESUME_OUTER` | `STATUS` | Action |
|---|---|---|
| `COMPLETE` | any | Nothing to do |
| `init` | any | Restart from preconditions |
| `loop` | `running` | Resume iteration at `CURRENT_PHASE` within iteration `ITERATION` |
| `loop` | `finishing` | Skip loop, proceed to summary (stop gate already fired) |
| `summary` | `finishing` | Resume summary |
| `paper-writing` | `finishing` | Resume paper-writing |

Within the iteration loop, `current_phase` tells the orchestrator which phase
was last started. The orchestrator checks for existing `$WORKERS_DIR/${ITERATION}-<phase>/receipt.json`:
- Receipt exists → phase completed, merge dashboard_patch if not already merged, advance
- No receipt → re-dispatch the phase

Never infer corruption from dashboard age. An old run remains resumable; use
run-state, receipts, and live-agent checks to decide whether to re-attach or
re-dispatch. Start a fresh run only when explicitly requested or when persisted
state fails validation.

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
