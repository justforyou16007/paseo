---
name: auto-research-loop
description: 'Metric-target-driven iterative research loop. A standalone top-level flow that opens with constrained idea-discovery + gap-planner on the setup-time baseline evidence, then repeats experiment-bridge (including structured analysis), auto-review-loop (including final re-analysis), and deterministic metric evaluation until the stop gate fires. The baseline is reproduced during /research-setup and anchored in CLAUDE.md''s ## Metric Target before the loop starts - every loop iteration is an improvement attempt. Use when the user asks for an auto research loop or autonomous quantitative improvement toward a configured Metric Target.'
argument-hint: "[- resume <run_id>] [- max-iterations: N]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat
---

# Auto Research Loop - Dashboard + Manifest Architecture

> **Paseo dispatch contract (Rules 1-5).** This skill is a thin scheduler. It dispatches sub-agents via `mcp__paseo__create_agent`, merges their `receipt.json` files into `dashboard.json` (via `dashboard-merge.js`), evaluates the deterministic stop gate on dashboard fields only (via `metric-gate.js`), and archives finished children. It performs **no analysis, no drafting, and no judgment of its own**. Every sub-skill invocation is a separate paseo agent - no in-process `Skill` tool calls.
>
> **Rule 5 - Manifest Protocol.** All context for workers goes through `input-manifest.json`, not the orchestrator prompt. The dispatch prompt is minimal: skill name + manifest path. Workers read their manifest, do their work, write `receipt.json`. The orchestrator never reads worker output files (no `cat`, `awk`, `grep` on outputs). It reads only `dashboard.json` and `receipt.json` files.
>
> See: `shared-references/paseo-subagent-dispatch.md`, `shared-references/worker-manifest.md`

## Purpose

Iterative, metric-target-driven research - the sibling of `/research-pipeline`
(not nested in it; the pipeline is a single end-to-end pass and never
dispatches this skill):

1. **Iterative.** The loop runs whole iterations (experiment with internal
   analysis -> review/fix with final analysis -> next method -> post-idea gap
   audit and plan) until a deterministic stop gate fires.
2. **Metric-driven.** The loop is governed by a quantitative target parsed
   from the active `## Metric Target` block in `CLAUDE.md` (validated by
   `metric-gate.js config`).
3. **Separated decisions.** The baseline is NOT reproduced here - it is
   reproduced during `/research-setup` (Phase 7.6, right after environment
   setup) and anchored in CLAUDE.md's `## Metric Target` `baseline:` field.
   Every loop iteration is an improvement attempt: constrained idea-discovery
   selects a method from the latest experiment evidence and prior gap map
   without literature search or pilots. Gap-planner then runs once as the
   audit stage: it identifies, merges, closes, and ranks gaps, then combines
   the selected method and audited gaps into a self-contained
   `EXPERIMENT_PLAN.md`.

### Stop-gate responsibility boundary

Two different "stop" concepts are in play; they never mix:

- **`/auto-review-loop`'s stop condition** ends the *current iteration's
  review/fix rounds* (verdict in {ready, almost, not ready} with a score).
  It is a quality verdict about the iteration's work. It is recorded on the
  dashboard (`last_review`) and **never terminates the research loop**.
- **This skill's stop condition** terminates the *research loop itself*. It
  is pure dashboard arithmetic (`metric-gate.js evaluate`): metric target,
  direction, tolerance, iteration budget, and patience. It consumes no
  reviewer verdict, no `metric_progress`, and no stop/continue/pivot signal -
  `/auto-review-loop` does not produce those fields.

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
   provider: $CFG.executor_provider            # from <run_id>.paseo-config.json
   settings: { modeId: $CFG.executor_mode,
               thinkingOptionId: $CFG.executor_thinking }
   initialPrompt: "/<skill-name> — manifest: $WORKER_DIR/input-manifest.json"
   notifyOnFinish: true

5. Wait for the completion notification - end the turn and let the child's
   finish notification re-invoke this agent (never poll).

6. Read $WORKER_DIR/receipt.json:
   - If status=failed -> log and decide (retry or stop)
   - Merge atomically and idempotently:
     node "$DASH_MERGE" apply --root "$ROOT" --run-id "$RUN_ID" \
          --receipt "$WORKER_DIR/receipt.json"
     (skip-once semantics via dashboard.applied_receipts is built in; the
     patch merge and the applied_receipts record land in ONE atomic write)
   - Update dashboard: current_phase = "<phase-name>", updated_at = now.

Error tracking: dashboard-merge.js applies receipt.has_errors /
receipt.error_count to dashboard.system_errors automatically. The orchestrator
does NOT read progress_error.md (Rule 5).

7. Archive the worker: mcp__paseo__archive_agent
```

## State Machine Design

### Why run-state tracks the outer lifecycle only

The iteration loop reuses phases (experiment-bridge runs in every iteration). If
run-state tracked per-iteration phases as static entries, a crash between
"gap-planner accepted" and "next iteration's experiment-bridge reset" would cause
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
| `loop` | Normal stop gate fired (metric met / budget exhausted / patience exhausted); invalid metric sets this phase to `failed` instead | After summary phase completes successfully | Never |
| `summary` | NARRATIVE_REPORT.md written | Deterministic or codex reviewer | Never |
| `paper-writing` | Paper compiled and audits pass | `deterministic:verify_paper_audits.sh` | `AUTO_WRITE=false` |

### Dashboard iteration tracking

The dashboard tracks intra-iteration state for crash-safe resume:

| Field | Purpose |
|---|---|
| `iteration` | Current iteration number (1-based) |
| `current_phase` | Last completed or in-progress phase within the iteration |
| `status` | `running` / `finishing` / `completed` / `invalid` |
| `stop_reason` | `null` while looping; one of `metric_met`, `budget_exhausted`, `patience_exhausted`, `invalid_metric` when the stop gate fires |
| `config` | Immutable run inputs needed after restart: auto-write/render flags, patience |

**Status values:**
- `running` - iteration loop is active
- `finishing` - stop gate fired, summary/paper-writing in progress
- `completed` - all terminal phases reached (success)
- `invalid` - metric configuration is broken (invalid_metric); run cannot continue

On resume, `status=finishing` means: skip the loop, continue from summary.
`status=invalid` reports the persisted metric error and exits without
dispatching. Only `status=completed` means nothing to do.

## Phase Diagram

```
init        Validate preconditions + Initialize dashboard + run-state
loop        --- Iteration loop (1 -> MAX_ITERATIONS) ---
              Phase 4     Idea Discovery (short evidence-constrained branch;
                          loop start uses the setup-time baseline evidence,
                          later iterations use the previous iteration's review)
              Phase 4.5   Gap Planner (one post-idea audit + mechanical plan)
              Phase 1     Experiment Bridge + internal Analyze Results
              Phase 2     Auto Review/Fix + final Analyze Results
              Phase 3     Metric Evaluation (metric-gate.js - pure arithmetic, NO dispatch)
            --- End loop (stop gate fires) ---
summary     Phase 5     Summary report (skipped on invalid_metric)
paper-writing  Phase 6  Paper Writing (optional; skipped on invalid_metric)
```

## Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `MAX_ITERATIONS` | 5 | Override via `- max-iterations: N`. |
| `TARGET_METRIC` | from CLAUDE.md | Parsed + validated by `metric-gate.js config` from the active `## Metric Target` block. |
| `TARGET_TOLERANCE` | from CLAUDE.md | Default 0.01. `current >= target - abs(target) * tolerance` (higher_better) or `current <= target + abs(target) * tolerance` (lower_better). |
| `PATIENCE` | 2 | Max consecutive iterations without metric improvement (derived from `metric.history`) before force stop. |
| `DASHBOARD_PATH` | `.aris/runs/<run_id>/dashboard.json` | Single source of truth. |
| `WORKERS_DIR` | `.aris/runs/<run_id>/workers/` | All worker manifests and receipts. |

Dashboard schema: see `shared-references/worker-manifest.md` section "dashboard.json Schema". All gate arithmetic uses dashboard fields only. The orchestrator NEVER reads experiment logs, result files, or review prose.

---

## Phase 0: Preconditions + Initialize

```bash
_pr=$(git rev-parse --show-toplevel 2>/dev/null) || { _d=$(pwd); while [ "$_d" != "/" ]; do [ -f "$_d/.aris/installed-skills.txt" ] && { _pr=$_d; break; }; _d=$(dirname "$_d"); done; }
cd "${_pr:-$(pwd)}" || exit 1
ROOT=$(pwd)

# Resolve helpers (integration-contract.md §2 - project-local only)
WIKI_SCRIPT=".aris/dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || WIKI_SCRIPT="dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || WIKI_SCRIPT=""
RUN_STATE=".aris/dist/tools/run-state.js"
[ -f "$RUN_STATE" ] || RUN_STATE="dist/tools/run-state.js"
[ -f "$RUN_STATE" ] || RUN_STATE=""
METRIC_GATE=".aris/dist/tools/metric-gate.js"
[ -f "$METRIC_GATE" ] || METRIC_GATE="dist/tools/metric-gate.js"
[ -f "$METRIC_GATE" ] || METRIC_GATE=""
DASH_MERGE=".aris/dist/tools/dashboard-merge.js"
[ -f "$DASH_MERGE" ] || DASH_MERGE="dist/tools/dashboard-merge.js"
[ -f "$DASH_MERGE" ] || DASH_MERGE=""
# Paseo substrate config emitter (shared shell helper, integration-contract.md §2)
RENDER=".aris/tools/render_w_agent_prompt.sh"
[ -f "$RENDER" ] || RENDER="tools/render_w_agent_prompt.sh"
[ -f "$RENDER" ] || RENDER=""
# Paper audit verifier (shell helper, integration-contract.md §2, Policy A)
AUDIT_VERIFIER=".aris/tools/verify_paper_audits.sh"
[ -f "$AUDIT_VERIFIER" ] || AUDIT_VERIFIER="tools/verify_paper_audits.sh"
[ -f "$AUDIT_VERIFIER" ] || AUDIT_VERIFIER=""

# Preconditions are a callable step. Fresh start calls it once; resume calls it
# only when run-state reports the unfinished `init` phase.
run_preconditions() {
# 0a. Read + validate the metric target (active block only; a commented-out
#     template block is NOT a configuration and is rejected).
METRIC_CONFIG=$(node "$METRIC_GATE" config "$ROOT") || {
    echo "ERROR: /auto-research-loop requires an active '## Metric Target' block in CLAUDE.md."
    echo "Run /research-setup or uncomment the block from templates/CLAUDE_MD_TEMPLATE.md."
    exit 1
}
TARGET_METRIC=$(jq -r '.target' <<< "$METRIC_CONFIG")
TARGET_UNIT=$(jq -r '.name // "metric"' <<< "$METRIC_CONFIG")
TARGET_DIRECTION=$(jq -r '.direction' <<< "$METRIC_CONFIG")
TARGET_TOLERANCE=$(jq -r '.tolerance' <<< "$METRIC_CONFIG")
TARGET_BASELINE=$(jq -r '.baseline // empty' <<< "$METRIC_CONFIG")

# 0b. Check experiment environment - dispatch env-manager if not configured
PROJECT_NAME=$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-//; s/-$//')
ENV_JSON=".claude/skills/run-${PROJECT_NAME}-experiment/env.json"
ENV_CONFIGURED=false
if jq -e '.status == "complete"' "$ENV_JSON" >/dev/null 2>&1 \
   && [ -d ".claude/skills/run-${PROJECT_NAME}-experiment/scripts" ]; then
    ENV_CONFIGURED=true
fi
if [ "$ENV_CONFIGURED" = "false" ]; then
    EXECUTOR_PROVIDER=$(jq -er '.executor_provider' "$CFG") || exit 1
    EXECUTOR_MODE=$(jq -er '.executor_mode' "$CFG") || exit 1
    EXECUTOR_THINKING=$(jq -r '.executor_thinking // empty' "$CFG")
    NOTIFY_ON_FINISH=$(jq -er '.notify_on_finish' "$CFG") || exit 1
    ENV_RECEIPT=".aris/runs/${RUN_ID}.experiment-env-manager.${PROJECT_NAME}.done.json"

    # create_agent uses the values above. Include thinkingOptionId only when
    # EXECUTOR_THINKING is non-empty. Save the returned id as ENV_AGENT_ID.
    mcp__paseo__create_agent:
      title: "env-manager: setup $PROJECT_NAME"
      provider: "$EXECUTOR_PROVIDER"
      settings: { modeId: "$EXECUTOR_MODE", thinkingOptionId: "$EXECUTOR_THINKING" }
      initialPrompt: "/experiment-env-manager — project: $PROJECT_NAME — mode: setup — run-id: $RUN_ID — paseo-config: $CFG"
      notifyOnFinish: "$NOTIFY_ON_FINISH"

    # Waiting is mandatory: end the turn and resume on the env-manager's
    # finish notification. Never inspect env.json immediately after create.

    # The known receipt is checked when present; env.json remains the final
    # authority because an older env-manager may only signal completion.
    if [ -f "$ENV_RECEIPT" ]; then
        jq -e --arg p "$PROJECT_NAME" '
          .skill == "experiment-env-manager" and .project == $p and
          (.result == "complete" or .result == "user_override")
        ' "$ENV_RECEIPT" >/dev/null || ENV_CONFIGURED=false
    fi
    if jq -e '.status == "complete"' "$ENV_JSON" >/dev/null 2>&1 \
       && [ -d ".claude/skills/run-${PROJECT_NAME}-experiment/scripts" ]; then
        ENV_CONFIGURED=true
    fi

    # Archive after the notification and validation attempt, including failure.
    mcp__paseo__archive_agent: agentId="$ENV_AGENT_ID"
    if [ "$ENV_CONFIGURED" != "true" ]; then
        echo "ERROR: env-manager completed without a valid experiment environment."
        exit 1
    fi
fi

# 0c. Baseline must already be anchored (reproduced during /research-setup
#     Phase 7.6 and written into CLAUDE.md ## Metric Target baseline:)
if [ -z "$TARGET_BASELINE" ]; then
    echo "ERROR: '## Metric Target' has no baseline value. The baseline is no longer"
    echo "reproduced by this loop - run /research-setup (Phase 7.6 baseline reproduction)"
    echo "or fill the baseline: field in CLAUDE.md manually before starting the loop."
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
    CFG=".aris/runs/${RUN_ID}.paseo-config.json"

    if [ ! -f "$DASHBOARD" ]; then
        echo "ERROR: No dashboard at $DASHBOARD. Cannot resume."
        exit 1
    fi
    if [ ! -f "$CFG" ]; then
        echo "ERROR: No paseo config at $CFG. Cannot resume."
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
    AUTO_WRITE=$(jq -r '.config.auto_write // false' "$DASHBOARD")
    RENDER_HTML=$(jq -r '.config.render_html // true' "$DASHBOARD")
    PATIENCE=$(jq -r '.config.patience // 2' "$DASHBOARD")

    if [ "$STATUS" = "invalid" ]; then
        INVALID_REASON=$(jq -r '.stop_reason // "invalid_metric"' "$DASHBOARD")
        echo "ERROR: run $RUN_ID cannot resume because its metric state is invalid ($INVALID_REASON)."
        exit 1
    fi

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
    # - outer=init -> run 0a-0c now, then mark init done+accepted and set loop running
    # - outer=loop, status=running -> resume iteration loop at current_phase
    # - outer=loop, status=finishing -> skip loop, go to summary
    # - outer=summary -> resume summary
    # - outer=paper-writing -> resume paper-writing

else
    # ---- FRESH START PATH ----
    RUN_ID=$(date +%Y%m%d-%H%M%S)-research-loop
    DASHBOARD=".aris/runs/$RUN_ID/dashboard.json"
    WORKERS_DIR=".aris/runs/$RUN_ID/workers"
    mkdir -p "$WORKERS_DIR"

    AUTO_WRITE=${AUTO_WRITE:-false}
    RENDER_HTML=${RENDER_HTML:-true}
    PATIENCE=${PATIENCE:-2}

    # Emit the paseo run config ONCE (provider/mode/thinking for every
    # create_agent below come from $CFG - never hardcoded, per
    # paseo-subagent-dispatch.md "Provider resolution").
    CFG=$(bash "$RENDER" --emit-config --run-id "$RUN_ID" --root "$ROOT")

    run_preconditions

    # Persist the dashboard first. `init` remains pending until both stores exist.
    METRIC_JSON=$(jq -n \
        --arg name "$TARGET_UNIT" --argjson target "$TARGET_METRIC" \
        --arg direction "$TARGET_DIRECTION" --argjson tolerance "$TARGET_TOLERANCE" \
        --argjson baseline "${TARGET_BASELINE:-null}" \
        '{name: $name, target: $target, direction: $direction,
          tolerance: $tolerance, baseline: $baseline, current: null, history: []}')
    cat > "$DASHBOARD" <<DASH
{
  "run_id": "$RUN_ID",
  "project": "$PROJECT_NAME",
  "status": "running",
  "iteration": 1,
  "max_iterations": ${ARG_MAX_ITERATIONS:-5},
  "current_phase": "init",
  "config": {
    "auto_write": $AUTO_WRITE,
    "render_html": $RENDER_HTML,
    "patience": $PATIENCE
  },
  "metric": $METRIC_JSON,
  "best_idea": null,
  "gaps": { "open": [], "closed": [], "total": 0 },
  "last_review": { "verdict": null, "score": null, "reviewer_id": null },
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

    # Mark loop as running, then open the loop at idea-discovery: iteration 1
    # composes its own method + plan from the setup-time baseline evidence
    # (refine-logs reproduction artifacts + seed gap map); it does NOT run a
    # baseline reproduction.
    node "$RUN_STATE" set "$ROOT" "$RUN_ID" loop running
    jq '.current_phase = "idea-discovery" | .updated_at = (now | todateiso8601)' \
        "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
fi
```

---

## Phase 1: Experiment Bridge

Dispatch `/experiment-bridge` to implement and run experiments.

**Experiment plan source (every iteration):**
`$WORKERS_DIR/${ITERATION}-gap-planner/outputs/EXPERIMENT_PLAN.md` and
`$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/IDEA_REPORT.md`.
Both artifacts belong to the iteration being executed: idea-discovery chose
the method first, then one gap-planner run audited the gap state from the
preceding experiment evidence and composed this plan from the selected
method and canonical open gaps. `/experiment-bridge` consumes both artifacts
together: the gap-planner's plan (what gap, what to measure, what closes it)
and the idea report (the method to implement). At loop start (iteration 1)
the evidence is the setup-time baseline reproduction artifacts; from
iteration 2 on it is the previous iteration's review outputs.

| Input | Path |
|-------|------|
| experiment_plan | `$WORKERS_DIR/${ITERATION}-gap-planner/outputs/EXPERIMENT_PLAN.md` |
| idea_report | `$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/IDEA_REPORT.md` |
| experiment_skill | `$ROOT/.claude/skills/run-${PROJECT_NAME}-experiment/env.json` |

Context: `target_metric`, `target_unit`

Output: raw `EXPERIMENT_RESULTS.md`, `EXPERIMENT_TRACKER.md`, and authoritative
structured analysis at `analysis/EXPERIMENT_RESULTS.md` in
`$WORKER_DIR/outputs/`.

Dispatch: `/experiment-bridge — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `metric.current`, `metric.delta`,
`statistical_significance`, `experiment_ids`. The metric values come from
experiment-bridge's internal analyze-results receipt. `metric.baseline` is
never patched here - it was anchored at setup time and lives on the dashboard
from initialization.

**Post-receipt wiki writes:** `receipt.experiments` is the bounded wiki payload;
the orchestrator reads no experiment output. For each record, invoke the real
CLI fields exactly as follows (no `--id`, no `--status`, and no ambient title
variable):

```bash
jq -c '.experiments[]' "$WORKER_DIR/receipt.json" | while IFS= read -r EXP; do
  EXP_SLUG=$(jq -er '.slug' <<<"$EXP") || exit 1
  EXP_TITLE=$(jq -er '.title' <<<"$EXP") || exit 1
  EXP_IDEA=$(jq -r '.idea // ""' <<<"$EXP")
  EXP_VERDICT=$(jq -er '.verdict' <<<"$EXP") || exit 1
  EXP_CONFIDENCE=$(jq -er '.confidence' <<<"$EXP") || exit 1
  EXP_METRICS=$(jq -er '.metrics' <<<"$EXP") || exit 1
  EXP_REASONING=$(jq -r '.reasoning // ""' <<<"$EXP")
  EXP_PROVENANCE=$(jq -er '.provenance' <<<"$EXP") || exit 1
  EXP_TAGS=$(jq -r '.tags | join(",")' <<<"$EXP")
  node "$WIKI_SCRIPT" add_experiment research-wiki/ \
    --slug "$EXP_SLUG" --title "$EXP_TITLE" --idea "$EXP_IDEA" \
    --verdict "$EXP_VERDICT" --confidence "$EXP_CONFIDENCE" \
    --metrics "$EXP_METRICS" --reasoning "$EXP_REASONING" \
    --provenance "$EXP_PROVENANCE" --tags "$EXP_TAGS"
done
```

Follow the standard dispatch pattern (Dispatch Pattern section above).

---

## Phase 2: Auto Review (quality verdict for THIS iteration)

Dispatch `/auto-review-loop` for cross-model review of the iteration's results.

> **Boundary.** This review ends the current iteration's review/fix rounds.
> Its verdict ({ready, almost, not ready} + score) is recorded on the
> dashboard and reported in the summary. It is a quality verdict - it NEVER
> terminates the research loop and is not an input to Phase 3's stop decision.
> Its artifact may still inform the next method and gap audit in Phase 4. Do
> not ask this worker for stop/continue/pivot decisions or `metric_progress`;
> those fields are not part of its contract.

| Input | Path |
|-------|------|
| analysis | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/analysis/EXPERIMENT_RESULTS.md` |
| tracker | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_TRACKER.md` |
| results | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_RESULTS.md` |
| experiment_plan | `$WORKERS_DIR/${ITERATION}-gap-planner/outputs/EXPERIMENT_PLAN.md` |
| experiment_skill | `$ROOT/.claude/skills/run-${PROJECT_NAME}-experiment/env.json` |
| idea_report | `$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/IDEA_REPORT.md` |

Context: `target_metric`, `target_unit`, `metric_history`, `reviewer_model`
(from the run config), `reviewer_bias_guard` (true), and `max_review_rounds` (4)

Output: `AUTO_REVIEW.md`, final result/tracker snapshots, and
`final-analysis/EXPERIMENT_RESULTS.md` in `$WORKER_DIR/outputs/`

Dispatch: `/auto-review-loop — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `last_review.verdict`, `last_review.score`,
`last_review.reviewer_id`, `metric.current`, `metric.delta`, and
`statistical_significance`. The final three are copied from auto-review-loop's
mandatory termination analysis after all fixes and reruns. When merged, they
replace this iteration's initial experiment-bridge history value in place;
they never append a second history row.

---

## Phase 3: Metric Evaluation (deterministic stop gate)

**Pure arithmetic on dashboard fields. NO file reads. NO external tool calls. NO dispatch. NO reviewer verdicts.**

```bash
DECISION=$(node "$METRIC_GATE" evaluate "$ROOT" "$RUN_ID")
STOP_REASON=$(jq -r '.stop_reason // empty' <<< "$DECISION")
```

`metric-gate.js evaluate` reads `dashboard.json`, decides, and atomically
persists `stop_reason`. The decision is a pure function of the dashboard's
metric fields, so re-running it after a crash or during resume yields the
identical answer - nothing is accumulated across calls.

### Truth table (first match wins - the reasons are mutually exclusive)

| Priority | Condition | `stop_reason` | Kind |
|---|---|---|---|
| 1 | `metric.current` null / non-finite, or metric config (target/direction/tolerance/history) invalid | `invalid_metric` | error - stop and report; never continue on a broken metric |
| 2 | `current >= target - abs(target) * tolerance` (higher_better) or `current <= target + abs(target) * tolerance` (lower_better) | `metric_met` | arithmetic success |
| 3 | `iteration >= max_iterations` | `budget_exhausted` | pure budget termination |
| 4 | trailing no-improvement iterations in `metric.history` >= `patience` | `patience_exhausted` | pure arithmetic termination |

- **Quality vs budget.** `metric_met` is arithmetic. `budget_exhausted` and
  `patience_exhausted` are pure budget/arithmetic terminations - they say
  nothing about quality. The iteration's quality verdict lives separately in
  `last_review` and never affects this table.
- **Patience is derived, not accumulated.** The no-progress streak is computed
  from `metric.history` on every evaluation (direction-aware: an entry counts
  as progress only if it improves on the best value seen before it). There is
  no `consecutive_pivots` counter to double-count across a crash + resume.
- **Provenance.** Whichever row fires, the `loop` phase is accepted with
  `deterministic:<stop_reason>` - the actual termination basis. A reviewer
  verdict (which may well be `not ready`) is never attached to a deterministic
  stop as its acquitting provenance.

If `stop_reason` is non-empty:
  1. Set dashboard `status = "finishing"`.
  2. **Branch on stop_reason BEFORE setting run-state** (done vs failed are
     both non-reversible intents; setting done then failed is a semantic
     regression even if run-state.ts allows it):

     **If `stop_reason == "invalid_metric"`:** the metric configuration is
     broken — no meaningful iteration, summary, or paper-writing can proceed.
     This is an error, not a success: do NOT accept the loop, do NOT set
     status `completed`. Mark the loop `failed` directly (never `done` first),
     skip downstream phases, set dashboard status to `invalid`, and exit:
     ```bash
     node "$RUN_STATE" set "$ROOT" "$RUN_ID" loop failed
     node "$RUN_STATE" set "$ROOT" "$RUN_ID" summary skipped
     node "$RUN_STATE" set "$ROOT" "$RUN_ID" paper-writing skipped
     jq '.status = "invalid" | .updated_at = (now | todateiso8601)' \
         "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
     echo "ERROR: metric configuration is invalid (stop_reason=invalid_metric). Run cannot continue."
     exit 1
     ```

     **Otherwise** (`metric_met`, `budget_exhausted`, `patience_exhausted`):
     mark the loop as done and proceed to Phase 5 (Summary):
     ```bash
     node "$RUN_STATE" set "$ROOT" "$RUN_ID" loop done \
         --artifact "$ROOT/$DASHBOARD"
     ```

If `stop_reason` is empty -> proceed to Phase 4.

---

## Phase 4: Idea Discovery (short branch; loop start and iteration transitions)

There are two entry cases:

- **Loop start (iteration 1):** the dashboard was initialized with
  `current_phase = "idea-discovery"` and `ITERATION = 1` - no increment
  happens. `SOURCE_ITERATION = 0`; the evidence inputs come from the
  setup-time baseline reproduction artifacts (see the input table), and there
  is no prior review round.
- **Iteration transition:** on the transition from a completed metric
  evaluation, advance the dashboard from `SOURCE_ITERATION=ITERATION` to
  `ITERATION=SOURCE_ITERATION+1` and set `current_phase = "idea-discovery"`
  in one atomic dashboard write. Do this exactly once. A resume that already
  sees `current_phase = "idea-discovery"` derives
  `SOURCE_ITERATION=ITERATION-1` and never increments again.

The idea worker directory is `$WORKERS_DIR/${ITERATION}-idea-discovery`.

| Input | Path |
|-------|------|
| prior_gap_map | `$ROOT/research-wiki/gap_map.md` |
| analysis | loop start: `$ROOT/refine-logs/EXPERIMENT_RESULTS.md` (setup baseline reproduction); transition: `$WORKERS_DIR/${SOURCE_ITERATION}-auto-review-loop/outputs/final-analysis/EXPERIMENT_RESULTS.md` |
| tracker | loop start: `$ROOT/refine-logs/EXPERIMENT_TRACKER.md`; transition: `$WORKERS_DIR/${SOURCE_ITERATION}-auto-review-loop/outputs/final-inputs/EXPERIMENT_TRACKER.md` |
| results | loop start: `$ROOT/refine-logs/EXPERIMENT_RESULTS.md`; transition: `$WORKERS_DIR/${SOURCE_ITERATION}-auto-review-loop/outputs/final-inputs/EXPERIMENT_RESULTS.md` |
| review | loop start: not supplied (no review round ran yet); transition: `$WORKERS_DIR/${SOURCE_ITERATION}-auto-review-loop/outputs/AUTO_REVIEW.md` |

Context: `metric_gap_constrained: true`, `source_iteration`, current metric
fields/history, and prior `open_gap_ids` from dashboard.

The worker runs only idea-discovery's constrained branch. It uses the supplied
experiment evidence and prior gap map to propose implementation-ready methods,
but makes no final gap-state rulings. It performs no literature survey, web
search, open-ended pipeline, pilot, user checkpoint, method-refinement,
rendering, or independent experiment planning. Every retry stays in this short
branch. It writes and cross-model audits one `IDEA_REPORT.md` containing
candidates and exactly one selected id.

Dispatch: `/idea-discovery — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `best_idea`, `idea_ids`.

After merge, set `current_phase = "gap-planner"` and proceed to Phase 4.5.

---

## Phase 4.5: Gap Planner (once per iteration, after idea discovery)

Dispatch `/gap-planner` once under
`$WORKERS_DIR/${ITERATION}-gap-planner`. This skill is the gap audit; do not
create a separate gap-audit worker and do not dispatch gap-planner before idea
discovery. Derive `SOURCE_ITERATION=ITERATION-1` on transitions and resume; at
loop start (iteration 1) `SOURCE_ITERATION=0` and the evidence inputs are the
setup baseline reproduction artifacts.

| Input | Path |
|-------|------|
| idea_report | `$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/IDEA_REPORT.md` |
| analysis | loop start: `$ROOT/refine-logs/EXPERIMENT_RESULTS.md`; transition: `$WORKERS_DIR/${SOURCE_ITERATION}-auto-review-loop/outputs/final-analysis/EXPERIMENT_RESULTS.md` |
| tracker | loop start: `$ROOT/refine-logs/EXPERIMENT_TRACKER.md`; transition: `$WORKERS_DIR/${SOURCE_ITERATION}-auto-review-loop/outputs/final-inputs/EXPERIMENT_TRACKER.md` |
| results | loop start: `$ROOT/refine-logs/EXPERIMENT_RESULTS.md`; transition: `$WORKERS_DIR/${SOURCE_ITERATION}-auto-review-loop/outputs/final-inputs/EXPERIMENT_RESULTS.md` |
| review | loop start: not supplied; transition: `$WORKERS_DIR/${SOURCE_ITERATION}-auto-review-loop/outputs/AUTO_REVIEW.md` |
| prior_gap_map | `$ROOT/research-wiki/gap_map.md` |

Context: `source_iteration`, `metric_name`, `metric_target`,
`metric_direction`, `metric_tolerance`, `metric_current`, `metric_baseline`,
`metric_history`, and `selected_idea_id = dashboard.best_idea.id`.

Gap-planner itself is the audit stage. It identifies, merges, closes, refutes,
defers, and ranks gaps from the supplied experiment evidence, then
mechanically composes the already-selected method and canonical open gaps into
the self-contained `EXPERIMENT_PLAN.md`. It dispatches no separate gap auditor
and cannot select another idea.

Output: `GAP_AUDIT.json`, `gap_map.md`, `GAP_ANALYSIS.md`, and
`EXPERIMENT_PLAN.md` from this one invocation.

Dispatch: `/gap-planner — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `gaps.open`, `gaps.closed`, `gaps.total`,
`gap_audit_path`, and `plan_path` together.

**Post-receipt actions:**
1. Merge with dashboard-merge.
2. Copy the audited `gap_map.md` to
   `$ROOT/research-wiki/gap_map.md` and rebuild the query pack.
3. Set `current_phase = "experiment-bridge"` and loop to Phase 1 without
   changing iteration again.

---

## Phase 5: Summary (on stop)

When the loop exits (`dashboard.status = "finishing"`), generate the narrative
report. This is a **summary sub-agent** (not `/render-html` - that skill renders
existing markdown but cannot generate new content).

```bash
WORKER_DIR="$WORKERS_DIR/summary"
mkdir -p "$WORKER_DIR/outputs"
```

The orchestrator dispatches a claude sub-agent with a prompt to write
`NARRATIVE_REPORT.md` from the dashboard and wiki state. The sub-agent reads the
inputs, generates the report to `$WORKER_DIR/outputs/`, and writes its receipt.

| Input | Path |
|-------|------|
| dashboard | `$ROOT/$DASHBOARD` |
| wiki_index | `$ROOT/research-wiki/index.md` |
| gap_map | `$ROOT/research-wiki/gap_map.md` |
| last_analysis | `$WORKERS_DIR/${ITERATION}-auto-review-loop/outputs/final-analysis/EXPERIMENT_RESULTS.md` |
| last_review | `$WORKERS_DIR/${ITERATION}-auto-review-loop/outputs/AUTO_REVIEW.md` |

Context: `stop_reason`, `total_iterations`, `final_metric`, `target_metric`, `metric_history` (all from dashboard)

Output: `NARRATIVE_REPORT.md` in `$WORKER_DIR/outputs/`

Dispatch: summary sub-agent via `mcp__paseo__create_agent` with prompt:
```
Generate NARRATIVE_REPORT.md from the provided inputs. Required sections:
metric_trajectory, stop_reason, iteration_log, open_gaps, closed_gaps, artifacts.
Write to the output_dir specified in the manifest. Write receipt.json when done.
The receipt must set worker="summary", run_id/iteration from the manifest,
primary_output="NARRATIVE_REPORT.md", and dashboard_patch.summary_path to the
run-relative report path.
```

**Post-receipt (optional):** If `RENDER_HTML=true`, dispatch `/render-html` to render
the generated `NARRATIVE_REPORT.md` to HTML (non-blocking, failure is logged
but does not block acceptance).

**Run-state transitions:** Accept the `loop` phase with the deterministic
provenance recorded by the stop gate (the actual termination basis - never a
reviewer id), then mark `summary` done + accepted:
```bash
STOP_REASON=$(jq -r '.stop_reason // "unknown"' "$DASHBOARD")
node "$RUN_STATE" accept "$ROOT" "$RUN_ID" loop \
    --verdict-id "deterministic:${STOP_REASON}" --reviewer "deterministic:${STOP_REASON}"

node "$RUN_STATE" set "$ROOT" "$RUN_ID" summary done \
    --artifact "$WORKER_DIR/outputs/NARRATIVE_REPORT.md"
node "$RUN_STATE" accept "$ROOT" "$RUN_ID" summary \
    --verdict-id "deterministic:summary" --reviewer "deterministic:summary"
```

---

## Phase 6: Paper Writing (optional)

Gate: `metric.current >= metric.target - abs(metric.target) * tolerance` (higher_better; symmetric for lower_better) AND `iteration >= 2`.

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
| results | `$WORKERS_DIR/${ITERATION}-auto-review-loop/outputs/final-inputs/EXPERIMENT_RESULTS.md` |
| analysis | `$WORKERS_DIR/${ITERATION}-auto-review-loop/outputs/final-analysis/EXPERIMENT_RESULTS.md` |
| dashboard | `$ROOT/$DASHBOARD` |

Context: `metric_trajectory`, `final_metric`, `target_metric` (from dashboard)

Output: `paper_dir` at `$WORKERS_DIR/paper-writing/outputs/paper/`

Post-receipt:
```bash
node "$RUN_STATE" set "$ROOT" "$RUN_ID" paper-writing done \
    --artifact "$WORKERS_DIR/paper-writing/outputs/paper/"
# Accept only after the deterministic audit passes.
bash "$AUDIT_VERIFIER" "$WORKERS_DIR/paper-writing/outputs/paper/" --assurance submission
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
- Receipt exists -> phase completed; merge with
  `dashboard-merge.js apply` (it skips receipts already in
  `dashboard.applied_receipts`, so a crash between merge and bookkeeping
  cannot double-apply), then advance
- No receipt -> re-dispatch the phase

The phase-to-directory mapping is exact. After a continuing metric evaluation,
the dashboard increments once and enters `${ITERATION}-idea-discovery`; the
single `${ITERATION}-gap-planner` and the following
`${ITERATION}-experiment-bridge` use that same new iteration number. Both
post-increment phases derive their evidence source as `ITERATION-1`. Resume
uses the persisted iteration and current phase and never increments a second
time.

Never infer corruption from dashboard age. An old run remains resumable; use
run-state, receipts, and live-agent checks to decide whether to re-attach or
re-dispatch. Start a fresh run only when explicitly requested or when persisted
state fails validation.

---

## Stop Gate (deterministic)

> **STOP is decided by dashboard arithmetic only** (`metric-gate.js evaluate`):
> the metric target/direction/tolerance, the iteration budget, and patience
> derived from `metric.history`. Stop reasons are mutually exclusive
> (`invalid_metric` > `metric_met` > `budget_exhausted` > `patience_exhausted`).
>
> The iteration's review verdict (`last_review`, from `/auto-review-loop`) is a
> quality verdict about the current iteration's work. It is recorded and
> reported, but it neither stops nor extends the loop. There is no compound
> Type-A/Type-B gate: a reviewer's opinion is never a termination basis, and a
> deterministic stop is never acquitted with a reviewer id.

---

## Critical Rules

1. **Orchestrator reads ONLY dashboard.json + receipt.json.** Never reads experiment logs, result files, review prose, tracker markdown, or any worker output file. All information flows through the manifest->receipt->dashboard_patch pipeline. If the orchestrator is about to `cat`, `awk`, or `grep` a worker output - it is violating Rule 5.

2. **Minimal dispatch prompts.** Worker dispatch prompt is ONLY the skill name + manifest path. All context goes in `input-manifest.json`. No extra instructions, no file paths in the prompt, no inline context.

3. **dashboard_patch is the only write contract.** Workers emit `dashboard_patch` in their receipt. The orchestrator merges via `dashboard-merge.js apply` (atomic + idempotent). Workers never write to `dashboard.json` directly.

4. **Gate arithmetic uses dashboard fields only (Phase 3).** Every comparison value is read from `dashboard.json` by `metric-gate.js evaluate`. Never from files, never from receipts at gate-evaluation time (receipts are already merged before Phase 3 runs).

5. **Gap audit runs once.** Gap-planner itself is the one post-idea audit and plan stage. It does not create or call another gap audit.

6. **No in-process Skill calls (Rule 4).** All sub-skill dispatch via `mcp__paseo__create_agent`. No fallbacks, no inline execution.

7. **Archive sub-agents after receipt read.** Every child agent is archived once its receipt has been processed. No lingering sub-agents.

8. **Canonical wiki writes only.** Ideas, experiments, edges go through `research-wiki.js`. Gaps come exclusively from `/gap-planner` dispatch.

9. **One long-lived agent, loops internally.** This skill runs as ONE paseo agent. Do NOT wrap in `/loop` / `create_heartbeat`.

10. **Providers come from the run's paseo-config.json.** `render_w_agent_prompt.sh --emit-config` emits it once at startup; every `create_agent` reads `executor_provider`/`executor_mode`/`executor_thinking` from it. Never hardcode a provider, never fall back to a different one.

11. **Patience enforcement.** `metric-gate.js evaluate` derives the no-progress streak from `metric.history` (direction-aware) and stops with `patience_exhausted` when it reaches `config.patience`. No counter is accumulated, so resume is idempotent.

12. **Review verdicts are not stop signals.** `/auto-review-loop`'s verdict/score end the current iteration's review rounds - nothing more. The loop stops only via Phase 3's deterministic gate, and the `loop` phase is accepted with `deterministic:<stop_reason>` provenance.

13. **Input-manifest is the COMPLETE context.** Workers should be able to do their job reading only their manifest. If a worker needs something not in its manifest, fix the manifest, not the dispatch prompt.

14. **Receipt schema is a contract.** Each worker MUST emit `dashboard_patch` with the fields its phase documents. Missing `dashboard_patch` = worker failure. `dashboard-merge.js` rejects malformed receipts instead of guessing.

---

## External Dependencies

### Infrastructure tools
- `src/tools/research-wiki.ts` - `init`, `slug`, `ingest_paper`, `sync`, `add_claim`, `upsert_idea`, `add_experiment`, `add_edge`, `rebuild_query_pack`, `rebuild_index`, `stats`, `log`
- `src/tools/run-state.ts` - `start`, `set`, `accept`, `status`, `resumePoint`
- `src/tools/metric-gate.ts` - `config` (parse + validate `## Metric Target`), `evaluate` (deterministic stop gate)
- `src/tools/dashboard-merge.ts` - `apply` (atomic, idempotent receipt -> dashboard merge)
- `tools/render_w_agent_prompt.sh` - `--emit-config` (paseo substrate config)
- `src/tools/iteration-log.ts` - `note`
- `src/tools/provenance.ts` - `stamp`

### Dispatched sub-skills
- `skills/experiment-bridge/SKILL.md` - Implements and runs experiments
- `skills/analyze-results/SKILL.md` - Structured analysis with metric extraction
- `skills/auto-review-loop/SKILL.md` - Multi-round review with fix cycle (per-iteration quality verdict)
- `skills/gap-planner/SKILL.md` - One post-idea gap audit followed by mechanical plan composition
- `skills/paper-writing/SKILL.md` - End-to-end paper generation (optional)
- `skills/render-html/SKILL.md` - HTML rendering

### Shared references
- `shared-references/paseo-subagent-dispatch.md` - Rules 1-4 (dispatch protocol)
- `shared-references/worker-manifest.md` - Rule 5 (manifest protocol, receipt schema, dashboard schema)
- `shared-references/paseo-reviewer-dispatch.md` - Fresh-thread bias guard
- `shared-references/external-cadence.md` - The fence (no wrapping in `/loop`)
- `shared-references/acceptance-gate.md` - Type-A vs Type-B gate classification
