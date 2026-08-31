---
name: auto-research-loop
description: 'Metric-target-driven iterative research loop. Each iteration runs the research-pipeline main flow - full idea-discovery (reads the research wiki for prior outcomes and open problems), experiment-bridge, auto-review-loop (whose /result-to-claim termination absorbs results into the wiki) - followed by a deterministic metric stop gate. Iteration 1 reproduces the baseline described in RESEARCH_BRIEF; every later iteration is an improvement attempt. Use when the user asks for an auto research loop or autonomous quantitative improvement toward a configured Metric Target.'
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

Iterative, metric-target-driven research. The loop is
[`/research-pipeline`](../research-pipeline/SKILL.md)'s main flow (its Stage
1-3) repeated until a deterministic stop gate fires:

1. **One iteration = Stage 1 -> Stage 2 -> Stage 3.** Stage 1 idea-discovery
   (the full pipeline: literature survey -> idea-creator -> novelty check ->
   review -> refine; reads RESEARCH_BRIEF and the research wiki), Stage 2
   experiment-bridge, Stage 3 auto-review-loop. Stage manifests reuse the
   research-pipeline Stage 1/2/3 definitions; this skill adds only the
   iteration counter, metric context, and the stop gate.
2. **The wiki is the cross-iteration memory - and the loop never writes it.**
   Ideas are born by idea-creator (Phase 7, inside Stage 1); experiments,
   verdicts, edges, idea outcomes, claims material, and the query pack are
   written by `/result-to-claim` (auto-review-loop's termination step 6,
   inside Stage 3). Next iteration's idea-discovery reads that state back via
   idea-creator's Phase 0 query-pack load (failed ideas banlist + open
   problems as search seeds).
3. **No baseline special case.** Iteration 1 is a normal iteration: the
   baseline method (described in RESEARCH_BRIEF's "Baseline Reproduction"
   section, written by `/research-setup`) is materialized by idea-discovery as
   the first - merely more detailed - idea and run by experiment-bridge. After
   iteration 1 the orchestrator anchors `metric.baseline` from the measured
   value (pure dashboard arithmetic). Iterations 2+ are improvement attempts.
4. **Metric-driven.** The loop is governed by a quantitative target parsed
   from the active `## Metric Target` block in `CLAUDE.md` (validated by
   `metric-gate.js config`).

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

Every stage follows the same cycle. This is shown once here; each stage section
below specifies only what differs (inputs, context, dispatch skill).
Stages 1-3 use the iteration-scoped directory shown below. The non-repeating
`summary` and `paper-writing` phases explicitly override `WORKER_DIR` with their
stable outer-lifecycle directories so resume always finds the same receipt.

For the full manifest and receipt JSON schemas, see `shared-references/worker-manifest.md`.

```
1. WORKER_DIR="$WORKERS_DIR/${ITERATION}-<phase-name>"
   mkdir -p "$WORKER_DIR/outputs"

2. Update dashboard: current_phase = "<phase-name>", updated_at = now.

3. Write $WORKER_DIR/input-manifest.json with:
   - worker: <skill-name>, iteration, run_id (standard header)
   - inputs: file paths the worker needs (stage-specific, see tables below)
   - context: scalar context values (stage-specific)
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

6. Read $WORKER_DIR/receipt.json, then ALWAYS merge it - both statuses, no branch
   around the merge call:
          node "$DASH_MERGE" apply --root "$ROOT" --run-id "$RUN_ID" \
               --receipt "$WORKER_DIR/receipt.json"
   The merger is idempotent (skip-once semantics via dashboard.applied_receipts;
   the patch merge and the applied_receipts record land in ONE atomic write) and
   handles both receipt statuses itself:
   - status=done -> the dashboard patch is applied
   - status=failed -> the merger records the failure into the dashboard
     (status="failed" + a `failure` object with worker/phase/error). This is
     the ONLY place a worker failure becomes durable - the orchestrator never
     writes failure state itself.
   After the merge returns, check what it recorded:
   - If dashboard.status = "failed" -> stop the iteration HERE. Do not update
     current_phase, do not advance to the next stage. Do not retry the worker;
     experiment failures use the experiment repair contract inside `/experiment-bridge`.
     A resume of this run reports the recorded failure and exits.
   - Otherwise -> update dashboard: current_phase = "<phase-name>", updated_at = now.

Error tracking: dashboard-merge.js applies receipt.has_errors /
receipt.error_count to dashboard.system_errors automatically. The orchestrator
does NOT read progress_error.md (Rule 5).

7. Archive the worker: mcp__paseo__archive_agent
```

## State Machine Design

### Why run-state tracks the outer lifecycle only

The iteration loop reuses stages (experiment-bridge runs in every iteration). If
run-state tracked per-iteration stages as static entries, a crash between
"auto-review-loop accepted" and "next iteration's idea-discovery reset" would cause
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
| `current_phase` | Last completed or in-progress phase within the iteration (`idea-discovery` -> `experiment-bridge` -> `auto-review-loop`) |
| `status` | `running` / `finishing` / `completed` / `invalid` / `failed` |
| `stop_reason` | `null` while looping; one of `metric_met`, `budget_exhausted`, `patience_exhausted`, `invalid_metric` when the stop gate fires |
| `config` | Immutable run inputs needed after restart: auto-write/render flags, patience |

**Status values:**
- `running` - iteration loop is active
- `finishing` - stop gate fired, summary/paper-writing in progress
- `completed` - all terminal phases reached (success)
- `invalid` - metric configuration is broken (invalid_metric); run cannot continue
- `failed` - a worker wrote a `status:"failed"` receipt; `dashboard-merge.js`
  recorded it (`dashboard.failure` holds worker/phase/error) and the run
  stopped at that phase. `invalid` means the *metric config* is broken;
  `failed` means the *work* broke. They are different diseases with the same
  prognosis: report on resume, do not dispatch.

On resume, `status=finishing` means: skip the loop, continue from summary.
`status=invalid` or `status=failed` reports the persisted error and exits
without dispatching. Only `status=completed` means nothing to do.

## Phase Diagram

```
init        Validate preconditions + Initialize dashboard + run-state
loop        --- Iteration loop (1 -> MAX_ITERATIONS) ---
              Stage 1     Idea Discovery (full pipeline; reads RESEARCH_BRIEF
                          + research wiki; writes IDEA_REPORT.md and
                          EXPERIMENT_PLAN.md via idea-discovery)
              Stage 2     Experiment Bridge (+ internal Analyze Results)
              Stage 3     Auto Review/Fix (+ final Analyze Results; its
                          termination dispatches /result-to-claim, which
                          absorbs the round into the research wiki)
              [iter 1]    Anchor metric.baseline from the measured value
              Gate        Metric Evaluation (metric-gate.js - pure arithmetic,
                          NO dispatch)
            --- End loop (stop gate fires) ---
summary     Summary report (skipped on invalid_metric)
paper-writing  Paper Writing (optional; skipped on invalid_metric)
```

## Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `MAX_ITERATIONS` | 5 | Override via `- max-iterations: N`. |
| `TARGET_METRIC` | from CLAUDE.md | Parsed + validated by `metric-gate.js config` from the active `## Metric Target` block. |
| `TARGET_TOLERANCE` | from CLAUDE.md | Default 0.01. `current >= target - abs(target) * tolerance` (higher_better) or `current <= target + abs(target) * tolerance` (lower_better). |
| `PATIENCE` | 2 | Max consecutive iterations without metric improvement (derived from `metric.history`, anchored on `metric.baseline`) before force stop. |
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
RUN_STATE=".aris/dist/tools/run-state.js"
[ -f "$RUN_STATE" ] || RUN_STATE="dist/tools/run-state.js"
[ -f "$RUN_STATE" ] || {
  echo "ERROR: run-state.js is required by /auto-research-loop. Run /aris-update or build the ARIS runtime." >&2
  exit 1
}
METRIC_GATE=".aris/dist/tools/metric-gate.js"
[ -f "$METRIC_GATE" ] || METRIC_GATE="dist/tools/metric-gate.js"
[ -f "$METRIC_GATE" ] || {
  echo "ERROR: metric-gate.js is required by /auto-research-loop. Run /aris-update or build the ARIS runtime." >&2
  exit 1
}
DASH_MERGE=".aris/dist/tools/dashboard-merge.js"
[ -f "$DASH_MERGE" ] || DASH_MERGE="dist/tools/dashboard-merge.js"
[ -f "$DASH_MERGE" ] || {
  echo "ERROR: dashboard-merge.js is required by /auto-research-loop. Run /aris-update or build the ARIS runtime." >&2
  exit 1
}
# Paseo substrate config emitter (shared shell helper, integration-contract.md §2)
RENDER=".aris/tools/render_w_agent_prompt.sh"
[ -f "$RENDER" ] || RENDER="tools/render_w_agent_prompt.sh"
[ -f "$RENDER" ] || {
  echo "ERROR: render_w_agent_prompt.sh is required by /auto-research-loop. Run /aris-update or build the ARIS runtime." >&2
  exit 1
}
# Paper audit verifier (shell helper, integration-contract.md §2)
AUDIT_VERIFIER=".aris/tools/verify_paper_audits.sh"
[ -f "$AUDIT_VERIFIER" ] || AUDIT_VERIFIER="tools/verify_paper_audits.sh"
[ -f "$AUDIT_VERIFIER" ] || {
  echo "ERROR: verify_paper_audits.sh is required by /auto-research-loop. Run /aris-update or build the ARIS runtime." >&2
  exit 1
}

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

    # The receipt confirms the child result when present; env.json is the
    # configuration authority.
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
}
```

`TARGET_BASELINE` may be empty: iteration 1 reproduces the baseline (from
RESEARCH_BRIEF's "Baseline Reproduction" section) and the orchestrator anchors
`metric.baseline` afterward (see the Baseline Anchoring step). A prior-work
reported value in CLAUDE.md is used as the initial expected anchor and is
refreshed with the measured value after iteration 1.

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

    if [ "$STATUS" = "failed" ]; then
        FAILED_PHASE=$(jq -r '.failure.phase // "unknown"' "$DASHBOARD")
        FAILED_WORKER=$(jq -r '.failure.worker // "unknown"' "$DASHBOARD")
        echo "ERROR: run $RUN_ID stopped at phase $FAILED_PHASE (worker $FAILED_WORKER) with a failed receipt. Inspect dashboard.failure and the worker directory; restart explicitly if you want to retry."
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
    # - outer=init -> run preconditions now, then mark init done+accepted and set loop running
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
  "problems": { "open": [], "closed": [], "total": 0 },
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

    # Mark loop as running, then open the loop at Stage 1 (idea-discovery).
    # Iteration 1 is a normal iteration: idea-discovery reads RESEARCH_BRIEF
    # (whose Baseline Reproduction section describes the baseline to run
    # first) and the research wiki.
    node "$RUN_STATE" set "$ROOT" "$RUN_ID" loop running
    jq '.current_phase = "idea-discovery" | .updated_at = (now | todateiso8601)' \
        "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
fi
```

`problems.open` / `problems.closed` hold `problem:<slug>` node ids from the
research wiki. The loop initializes them empty and never writes them itself.
They are published once per run, by the summary worker, from a single scan of
the wiki (`research-wiki.js stats --json`) — see the Summary section. No
in-loop worker patches them: each problem writer knows only the problems it
just filed, and these fields are whole-list replacements, so a partial writer
would erase the other writers' problems.

---

## Stage 1: Idea Discovery (full pipeline)

Dispatch `/idea-discovery` under `$WORKERS_DIR/${ITERATION}-idea-discovery`.
The manifest mirrors
[`/research-pipeline` Stage 1](../research-pipeline/SKILL.md) plus the loop's
iteration context - the worker runs its normal full pipeline (which itself
reads the research wiki and RESEARCH_BRIEF, and births idea pages via
idea-creator Phase 7).

| Input | Path |
|-------|------|
| research_brief | `$ROOT/RESEARCH_BRIEF.md` |
| claude_md | `$ROOT/CLAUDE.md` |
| dashboard | `$ROOT/$DASHBOARD` |

Context: `direction` (research direction from the brief), `iteration`,
`source_iteration = ITERATION - 1`, the metric six-tuple
(`metric_name/target/direction/tolerance/current/baseline` + `metric_history`
from the dashboard), and - from iteration 2 on - the previous iteration's
evidence paths as supplementary context for Phase 0 (`analysis`, `tracker`,
`results`, `review` from `$WORKERS_DIR/${SOURCE_ITERATION}-auto-review-loop/outputs/...`).
At iteration 1 there are no evidence paths: the brief's Baseline Reproduction
section IS the context, and the manifest carries the note
`"iteration 1: select the baseline reproduction idea from the brief"`.

Output: `IDEA_REPORT.md` and `EXPERIMENT_PLAN.md` in `$WORKER_DIR/outputs/`.

Dispatch: `/idea-discovery — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `best_idea`, `idea_ids`, `plan_path`.

After merge, set `current_phase = "experiment-bridge"` and proceed to Stage 2.

---

## Stage 2: Experiment Bridge

Dispatch `/experiment-bridge` to implement and run experiments. The manifest
mirrors `/research-pipeline` Stage 2.

| Input | Path |
|-------|------|
| idea_report | `$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/IDEA_REPORT.md` |
| experiment_plan | `$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/EXPERIMENT_PLAN.md` |
| experiment_skill | `$ROOT/.claude/skills/run-${PROJECT_NAME}-experiment/env.json` |
| dashboard | `$ROOT/$DASHBOARD` |

Context: `chosen_idea` (`dashboard.best_idea.title`), `iteration`,
`target_metric`, `target_unit`.

Output: raw `EXPERIMENT_RESULTS.md`, `EXPERIMENT_TRACKER.md`, and authoritative
structured analysis at `analysis/EXPERIMENT_RESULTS.md` in
`$WORKER_DIR/outputs/`.

Dispatch: `/experiment-bridge — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `metric.current`, `metric.delta`,
`statistical_significance`, `experiment_ids`. The metric values come from
experiment-bridge's internal analyze-results receipt. `metric.baseline` is
never patched by workers - it is anchored by the orchestrator (see Baseline
Anchoring) or set at init.

The orchestrator performs **no wiki writes** here. Experiment nodes, verdicts,
and edges are born by `/result-to-claim` at Stage 3's termination.

After merge, set `current_phase = "auto-review-loop"` and proceed to Stage 3.

---

## Stage 3: Auto Review (quality verdict for THIS iteration)

Dispatch `/auto-review-loop` for cross-model review of the iteration's results.
The manifest mirrors `/research-pipeline` Stage 3.

> **Boundary.** This review ends the current iteration's review/fix rounds.
> Its verdict ({ready, almost, not ready} + score) is recorded on the
> dashboard and reported in the summary. It is a quality verdict - it NEVER
> terminates the research loop and is not an input to the stop gate.
> Do not ask this worker for stop/continue/pivot decisions or
> `metric_progress`; those fields are not part of its contract.

| Input | Path |
|-------|------|
| analysis | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/analysis/EXPERIMENT_RESULTS.md` |
| tracker | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_TRACKER.md` |
| results | `$WORKERS_DIR/${ITERATION}-experiment-bridge/outputs/EXPERIMENT_RESULTS.md` |
| experiment_plan | `$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/EXPERIMENT_PLAN.md` |
| experiment_skill | `$ROOT/.claude/skills/run-${PROJECT_NAME}-experiment/env.json` |
| idea_report | `$WORKERS_DIR/${ITERATION}-idea-discovery/outputs/IDEA_REPORT.md` |
| dashboard | `$ROOT/$DASHBOARD` |

Context: `chosen_idea` (`dashboard.best_idea.title`), `chosen_idea_id`
(`dashboard.best_idea.id` - passed so the `/result-to-claim` dispatch in the
termination step can link the experiment to the idea page), `iteration`,
`target_metric`, `target_unit`, `metric_history`, `reviewer_model` (from the
run config), `reviewer_bias_guard` (true), and `max_review_rounds` (4).

Output: `AUTO_REVIEW.md`, final result/tracker snapshots, and
`final-analysis/EXPERIMENT_RESULTS.md` in `$WORKER_DIR/outputs/`.

Dispatch: `/auto-review-loop — manifest: $WORKER_DIR/input-manifest.json`

**Dashboard patch fields:** `last_review.verdict`, `last_review.score`,
`last_review.reviewer_id`, `metric.current`, `metric.delta`, and
`statistical_significance`. The final three are copied from auto-review-loop's
mandatory termination analysis after all fixes and reruns. When merged, they
replace this iteration's initial experiment-bridge history value in place;
they never append a second history row.

**Wiki absorption is Stage 3's own termination behavior.** auto-review-loop's
termination step 6 dispatches `/result-to-claim`, which writes the experiment
node (verdict owner), `tested_by`/`supports`/`invalidates` edges, the idea
outcome, and the rebuilt query pack. On a `partial`/`no` verdict it also
creates the failure analysis as a child open problem. The orchestrator adds
nothing to this and never writes the wiki itself.

After merge, set `current_phase = "metric-gate"` and run the Baseline
Anchoring step (iteration 1 only), then the Gate.

---

## Baseline Anchoring (iteration 1 only, after Stage 3)

Pure dashboard arithmetic - Type-A, no judgment:

```bash
if [ "$ITERATION" = "1" ]; then
    BASELINE=$(jq -r '.metric.baseline' "$DASHBOARD")
    CURRENT=$(jq -r '.metric.current // empty' "$DASHBOARD")
    if { [ "$BASELINE" = "null" ] || [ -z "$BASELINE" ]; } \
       && [ -n "$CURRENT" ] && [ "$CURRENT" != "null" ]; then
        jq --argjson b "$CURRENT" \
            '.metric.baseline = $b | .updated_at = (now | todateiso8601)' \
            "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
        # Also refresh CLAUDE.md ## Metric Target baseline: with the measured
        # value (the durable cross-run record; setup left it empty or filled
        # it with the prior-work reported value).
    fi
fi
```

An existing non-null baseline (prior-work reported value) is kept - the
reproduction result is already in `metric.history[1]` and a large deviation
surfaces in the summary and the wiki experiment node, not by silently
overwriting the configured anchor.

---

## Gate: Metric Evaluation (deterministic stop gate)

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
  as progress only if it improves on the best value seen before it, seeded
  from `metric.baseline`). There is no `consecutive_pivots` counter to
  double-count across a crash + resume.
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
     broken - no meaningful iteration, summary, or paper-writing can proceed.
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
     mark the loop as done and proceed to Summary:
     ```bash
     node "$RUN_STATE" set "$ROOT" "$RUN_ID" loop done \
         --artifact "$ROOT/$DASHBOARD"
     ```

If `stop_reason` is empty -> advance to the next iteration: increment
`ITERATION` and set `current_phase = "idea-discovery"` in one atomic dashboard
write (do this exactly once; a resume that already sees
`current_phase = "idea-discovery"` derives `SOURCE_ITERATION = ITERATION - 1`
and never increments again), then loop to Stage 1.

---

## Summary (on stop)

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

This worker also closes the run's books on the research wiki. It is the only
worker that runs after the stop gate, so it is the only one that can see the
run's final verdict and the whole problem tree at once. The orchestrator still
writes nothing to the wiki itself.

| Input | Path |
|-------|------|
| dashboard | `$ROOT/$DASHBOARD` |
| wiki_index | `$ROOT/research-wiki/index.md` |
| wiki_root | `$ROOT/research-wiki/` |
| last_analysis | `$WORKERS_DIR/${ITERATION}-auto-review-loop/outputs/final-analysis/EXPERIMENT_RESULTS.md` |
| last_review | `$WORKERS_DIR/${ITERATION}-auto-review-loop/outputs/AUTO_REVIEW.md` |

Context: `stop_reason`, `total_iterations`, `final_metric`, `target_metric`, `metric_history` (all from dashboard)

Output: `NARRATIVE_REPORT.md` in `$WORKER_DIR/outputs/`

Dispatch: summary sub-agent via `mcp__paseo__create_agent` with prompt:
```
Generate NARRATIVE_REPORT.md from the provided inputs. Required sections:
metric_trajectory, stop_reason, iteration_log, open_problems, artifacts.
Write it to the output_dir specified in the manifest.

Then close the run's books on the research wiki, in this order:
1. If manifest.context.stop_reason == "metric_met", close the run's root
   problem — the target it names has now been reached:
     node "$WIKI_SCRIPT" add_problem <wiki_root> --slug root --status solved \
       --evidence "<final metric value + the analysis path that measured it>" \
       --update-on-exist || exit 1
   For any other stop_reason the target was NOT reached, so root stays open.
2. node "$WIKI_SCRIPT" rebuild_query_pack <wiki_root> || exit 1
3. Read the final tally back from the wiki, after the close:
     node "$WIKI_SCRIPT" stats <wiki_root> --json
   Copy its .problems.open, .problems.closed and .problems.total verbatim
   into the receipt. Do not assemble these lists by hand.

Write receipt.json last, NOT into output_dir. It goes in the worker directory:
the directory that contains input-manifest.json, one level above output_dir.
That is the only path the orchestrator polls, and dashboard-merge.js rejects
any receipt without a sibling input-manifest.json. The receipt must set
worker="summary", run_id/iteration from the manifest,
primary_output="NARRATIVE_REPORT.md",
dashboard_patch.summary_path to the run-relative report path, and
dashboard_patch."problems.open" / "problems.closed" / "problems.total" from
step 3.
```

Resolve `$WIKI_SCRIPT` per
[`shared-references/wiki-helper-resolution.md`](../shared-references/wiki-helper-resolution.md).
Closing root here rather than in the stop gate keeps the gate pure arithmetic
on the dashboard, and keeps every wiki write inside a worker. A run that stops
without `metric_met` leaves root open on purpose: the next run's query pack
should still carry the unmet target as the seed problem.

**Post-receipt:** If `RENDER_HTML=true`, dispatch `/render-html` to render
the generated `NARRATIVE_REPORT.md` to HTML. A render failure fails the summary
phase. Set `RENDER_HTML=false` before the run to omit this artifact.

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

## Paper Writing (optional)

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
# Intra-iteration: which stage within the iteration was in progress
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
| any | `failed` | Report `dashboard.failure` and exit without dispatching |

The `failed` row short-circuits every row above it: the resume code checks
`status` before consulting `RESUME_OUTER`, because a worker in any phase -
including summary and paper-writing - can write a failed receipt.

Within the iteration loop, `current_phase` tells the orchestrator which stage
was last started (`idea-discovery` -> `experiment-bridge` -> `auto-review-loop` ->
`metric-gate`). The orchestrator checks for existing
`$WORKERS_DIR/${ITERATION}-<phase>/receipt.json`:
- Receipt exists -> read its `status`, then merge with
  `dashboard-merge.js apply` (it skips receipts already in
  `dashboard.applied_receipts`, so a crash between merge and bookkeeping
  cannot double-apply):
  - `status=done` -> stage completed; advance
  - `status=failed` -> the merge records `dashboard.status="failed"`; report
    the failure and stop. The receipt's EXISTENCE is never evidence of
    completion - only its `status` is.
- No receipt -> re-dispatch the stage
- `current_phase == "metric-gate"` -> no worker directory exists for this phase, and
  none is needed: the Stage 3 receipt is already merged (it is what moved
  `current_phase` past `auto-review-loop`). On resume, run the Baseline
  Anchoring step if `iteration == 1` and `metric.baseline` is still the
  un-anchored prior-work expectation, then run the Gate directly. Never
  re-dispatch Stage 3 from here.

The stage-to-directory mapping is exact. After a continuing gate evaluation,
the dashboard increments once and enters `${ITERATION}-idea-discovery`; the
following `${ITERATION}-experiment-bridge` and
`${ITERATION}-auto-review-loop` use that same new iteration number. All
post-increment stages derive their evidence source as `ITERATION-1`. Resume
uses the persisted iteration and current phase and never increments a second
time.

Never infer corruption from dashboard age. A prior run remains resumable; use
run-state, receipts, and live-agent checks to decide whether to re-attach or
re-dispatch. Start a fresh run only when explicitly requested or when persisted
state fails validation.

---

## Stop Gate (deterministic)

> **STOP is decided by dashboard arithmetic only** (`metric-gate.js evaluate`):
> the metric target/direction/tolerance, the iteration budget, and patience
> derived from `metric.history` anchored on `metric.baseline`. Stop reasons are
> mutually exclusive
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

4. **Gate arithmetic uses dashboard fields only.** Every comparison value is read from `dashboard.json` by `metric-gate.js evaluate`. Never from files, never from receipts at gate-evaluation time (receipts are already merged before the gate runs).

5. **The orchestrator never writes the research wiki.** All wiki knowledge writes happen inside the dispatched pipeline skills: idea pages by idea-creator (Stage 1), experiments/edges/outcomes/query-pack by `/result-to-claim` (Stage 3's termination). The loop only reads the wiki - indirectly, through those skills.

6. **No in-process Skill calls (Rule 4).** All sub-skill dispatch via `mcp__paseo__create_agent`. No fallbacks, no inline execution.

7. **Archive sub-agents after receipt read.** Every child agent is archived once its receipt has been processed. No lingering sub-agents.

8. **No baseline special case.** Iteration 1 is a normal iteration; the baseline comes from RESEARCH_BRIEF through Stage 1, and `metric.baseline` is anchored by pure dashboard arithmetic after Stage 3. Never dispatch a baseline-only worker.

9. **One long-lived agent, loops internally.** This skill runs as ONE paseo agent. Do NOT wrap in `/loop` / `create_heartbeat`.

10. **Providers come from the run's paseo-config.json.** `render_w_agent_prompt.sh --emit-config` emits it once at startup; every `create_agent` reads `executor_provider`/`executor_mode`/`executor_thinking` from it. A missing or invalid provider configuration fails dispatch.

11. **Patience enforcement.** `metric-gate.js evaluate` derives the no-progress streak from `metric.history` (direction-aware, seeded from `metric.baseline`) and stops with `patience_exhausted` when it reaches `config.patience`. No counter is accumulated, so resume is idempotent.

12. **Review verdicts are not stop signals.** `/auto-review-loop`'s verdict/score end the current iteration's review rounds - nothing more. The loop stops only via the deterministic gate, and the `loop` phase is accepted with `deterministic:<stop_reason>` provenance.

13. **Input-manifest is the COMPLETE context.** Workers should be able to do their job reading only their manifest. If a worker needs something not in its manifest, fix the manifest, not the dispatch prompt.

14. **Receipt schema is a contract.** Each worker MUST emit `dashboard_patch` with the fields its stage documents. Missing `dashboard_patch` = worker failure. `dashboard-merge.js` rejects malformed receipts instead of guessing.

---

## External Dependencies

### Infrastructure tools
- `src/tools/run-state.ts` - `start`, `set`, `accept`, `status`, `resumePoint`
- `src/tools/metric-gate.ts` - `config` (parse + validate `## Metric Target`), `evaluate` (deterministic stop gate)
- `src/tools/dashboard-merge.ts` - `apply` (atomic, idempotent receipt -> dashboard merge)
- `tools/render_w_agent_prompt.sh` - `--emit-config` (paseo substrate config)
- `src/tools/iteration-log.ts` - `note`
- `src/tools/provenance.ts` - `stamp`

### Dispatched sub-skills
- `skills/idea-discovery/SKILL.md` - Full idea pipeline (Stage 1; births idea pages via idea-creator)
- `skills/experiment-bridge/SKILL.md` - Implements and runs experiments (Stage 2)
- `skills/analyze-results/SKILL.md` - Structured analysis with metric extraction (inside Stage 2/3)
- `skills/auto-review-loop/SKILL.md` - Multi-round review with fix cycle (Stage 3; its termination dispatches `/result-to-claim`, which writes the wiki)
- `skills/paper-writing/SKILL.md` - End-to-end paper generation (optional)
- `skills/render-html/SKILL.md` - HTML rendering

### Shared references
- `shared-references/paseo-subagent-dispatch.md` - Rules 1-4 (dispatch protocol)
- `shared-references/worker-manifest.md` - Rule 5 (manifest protocol, receipt schema, dashboard schema)
- `shared-references/paseo-reviewer-dispatch.md` - Fresh-thread bias guard
- `shared-references/external-cadence.md` - The fence (no wrapping in `/loop`)
- `shared-references/acceptance-gate.md` - Type-A vs Type-B gate classification
