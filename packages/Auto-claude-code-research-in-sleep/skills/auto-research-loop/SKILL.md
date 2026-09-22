---
name: auto-research-loop
description: 'Metric-target-driven iterative research loop. Each iteration runs the research-pipeline main flow - full idea-discovery (reads the research wiki for prior outcomes and open problems), experiment-bridge, auto-review-loop (whose /result-to-claim termination absorbs results into the wiki) - followed by a deterministic metric stop gate. Iteration 1 reproduces the baseline described in RESEARCH_BRIEF; every later iteration is an improvement attempt. Use when the user asks for an auto research loop or autonomous quantitative improvement toward a configured Metric Target.'
argument-hint: "[- resume <run_id>] [- max-iterations: N]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

> **Dispatch watchdog (mandatory).** Every `mcp__paseo__create_agent` in this
> skill is covered by `shared-references/paseo-subagent-dispatch.md`
> §"The dispatch watchdog": arm a self-target watchdog before ending the turn
> to wait, disarm once no awaited child turn remains. The procedure lives
> there, not here.

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
  review/fix rounds* (verdict in {ready, almost, not ready, insufficient} with
  a score). It is a quality verdict about the iteration's work. It is recorded
  on the dashboard (`last_review`) and **never terminates the research loop**.
  `insufficient` is the one verdict that is not a grade: it says the review
  could not grade anything, so the candidate goes back to the bridge to be run
  properly. It still does not terminate the loop, and it does not advance the
  iteration.
- **This skill's stop condition** terminates the *research loop itself*. It
  is pure dashboard arithmetic (`metric-gate.js evaluate`): metric target,
  direction, tolerance, iteration budget, and patience. It consumes no
  reviewer verdict, no `metric_progress`, and no stop/continue/pivot signal -
  `/auto-review-loop` does not produce those fields.

## Entry Mode and Recursion

Decide the entry mode before reading any state. The Workflow entry uses a
charter and manifest frozen by whoever created this run. A direct legacy
invocation is allowed only when the caller explicitly asks for `standalone`, and
it is always a depth-0 run. It is never a recursive child, and it is never a
fallback for a charter that failed to load - a missing charter stops startup.

### Depth-0 root entry

Users invoke this skill directly for the root run; there is no separate outer
entry skill. When a Workflow invocation has depth 0, start from the immutable
root charter produced by setup. Read it through
`readRootCharter` in `src/tools/root-charter.ts`; that reader checks the charter
against `run.json`. The run it belongs to has `parent_run_id: null`, `depth: 0`
and `scope_path: "/"`. The charter carries no identity fields of its own; it
names `baseline_ref: "W_0"` and carries the frozen resource inventory, owner
limits, tester binding and expected output.

The caller supplies the charter reference, baseline reference, resource
inventory reference, input snapshot, write scope, Wiki request and head, and
budget. Forward those as manifest fields. Never assemble `workspace_root`,
`wiki_root` or a resource request by concatenating prompt values, current
checkout paths or old receipts. Use `workflow-cli.js start`/`resume` for
startup and recovery; expansion is a separate command (Stage 2) and neither
`start` nor `resume` performs it.

### A child is told what to do, not who dispatched it

A dispatch seals the child's manifest from exactly these fields, and any other
field is refused:

`project_root`, `run_id`, `worker`, `scope`, `input_snapshot`

No parent run id, no position in a wave, no iteration counter. A worker
therefore cannot make its behaviour depend on where it sits in someone else's
run, which is what keeps a child's result readable on its own terms. Reject a
recursive invocation before dispatching any work when any of charter identity,
execution, baseline, resource inventory, workspace, Wiki head, input snapshot,
budget, write scope or model policy is absent, conflicting, or supplied by the
prompt instead of the manifest. A missing helper or an unavailable required
resource stops the current phase. Do not warn and continue on a local default.

Three pieces of the recursive substrate are owned outside this skill itself: a
charter-only `workflow-cli` start adapter, child charter/result-package
persistence, and the Paseo workspace create/archive path. If one is missing at
runtime, stop with the exact missing artifact or helper. Never document it as
complete and never synthesize a local replacement. If the bridge command cannot
be resolved, the status report
must not say that the old runtime is already using it. A missing connection is
a hard stop and a report item, not a reason to call the old path.

## One sequence at depth 0, 1 and 2

Every run walks the same phases regardless of depth. A child is a standalone
run, so nothing outside it owns this sequence - the loop walks it, and
`dashboard-merge` is what decides which worker may write from which phase:

```text
idea-discovery
-> experiment-bridge
-> auto-review-loop
-> metric-gate
-> completed
branch: bridge-repair (from a bridge that failed, or a review that could not rule)
```

`analyze-results` is not a phase. It runs inside `experiment-bridge` and its
receipt is registered against that phase. `bridge-repair` has no successor of
its own: only the repair handler may leave it, and it always returns to
`experiment-bridge` or ends the run.

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
              [repair]    Bridge Repair (conditional; entered when Stage 2
                          returns a failed receipt, or when Stage 3 returns
                          `insufficient`. Retries the same Stage 2 with the
                          same frozen inputs - it never skips ahead)
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
  "current_phase": "init",
  "config": {
    "auto_write": $AUTO_WRITE,
    "render_html": $RENDER_HTML,
    "patience": $PATIENCE$(
      # Optional backstop. Unset means no round limit: what bounds the run is
      # its budget ledger and its metric target, not a round count.
      [ -n "${ARG_MAX_ITERATIONS:-}" ] && printf ',\n    "max_iterations": %s' "$ARG_MAX_ITERATIONS"
    )
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

In Workflow mode the bridge is reached through one command-line hand-off, not
through this dispatch prompt. Read "Expansion is owned by one bridge" below and
run that command before treating the bridge as started.

**Dashboard patch fields:** `metric.current`, `metric.delta`,
`statistical_significance`, `experiment_ids`. The metric values come from
experiment-bridge's internal analyze-results receipt. `metric.baseline` is
never patched by workers - it is anchored by the orchestrator (see Baseline
Anchoring) or set at init.

The orchestrator performs **no wiki writes** here. Experiment nodes, verdicts,
and edges are born by `/result-to-claim` at Stage 3's termination.

**A failed bridge receipt is not a merge.** `dashboard-merge.js` records it as
`status = "bridge_repair_pending"`, `current_phase = "bridge-repair"` and a
`bridge_failure` block carrying the receipt, its input manifest, both hashes
and the frozen input hash. Dispatch `/auto-review-loop` with
`context.purpose = "bridge_repair"` and `context.repair_reason = "execution"`.
Merging its repair receipt returns the run to `experiment-bridge` on
`repair_status = "fixed"`, and ends the run as `failed` on `exhausted`. The
retry must carry the same frozen inputs; a changed input is a new candidate,
not a repair.

After merge, set `current_phase = "auto-review-loop"` and proceed to Stage 3.

---

## Expansion is owned by one bridge

The loop reaches the bridge through one command-line hand-off. After
`idea-discovery` has produced its upstream artifact and receipt, resolve
`workflow-cli.js` through the shared integration contract and set `WORKFLOW_CLI`
to that one resolved path. Run the deterministic `bridge-input` preparation
command from [`shared-references/bridge-expansion.md`](../shared-references/bridge-expansion.md)
first. It reads the frozen inputs for the current run - including the
`IDEA_DISCOVERY_MANIFEST_PATH` handed to the idea worker - and writes
`BRIDGE_INPUT_JSON`; then run exactly:

```bash
node "$WORKFLOW_CLI" bridge-expand \
  --execution-root "$EXECUTION_ROOT" \
  --project "$PROJECT_ROOT" \
  --run "$OUTER_RUN_ID" \
  --input "$BRIDGE_INPUT_JSON" \
  --evidence "$BRIDGE_EVIDENCE_PATH"
```

## Bridge variable sources

Set every command variable before invoking the command; none may be inferred
from a directory listing or left to the agent's guess.

- `WORKFLOW_CLI` is the one `workflow-cli.js` resolved by
  `integration-contract.md`: installed projects use `.aris/dist/tools/workflow-cli.js`,
  and development runs use `dist/tools/workflow-cli.js`.
- `PROJECT_ROOT` is the absolute `project root` from the dispatch contract's
  initial prompt. It is not a `run.json` field; the current contract is
  `$PROJECT_ROOT/.aris/runs/$OUTER_RUN_ID/run.json`.
- `OUTER_RUN_ID` is `run.json.run_id` (`src/tools/run-contract.ts:32`).
- `EXECUTION_ROOT` uses the exact `workflow-runtime.json.execution_root` entry
  in [`shared-references/bridge-expansion.md`](../shared-references/bridge-expansion.md).
- `BRIDGE_INPUT_JSON` uses the exact `.../outputs/bridge-input.json` entry in
  [`shared-references/bridge-expansion.md`](../shared-references/bridge-expansion.md).
- `BRIDGE_EVIDENCE_PATH` uses the exact sibling `.../receipt.json` entry in
  [`shared-references/bridge-expansion.md`](../shared-references/bridge-expansion.md).

The command delegates the child plan, resource classification, budget
settlement and dynamic matrix to
`planExperimentBridge` in `src/tools/experiment-bridge.ts`. Do not reproduce
those decisions in this skill or in a worker. The bridge is BFS by default.
DFS needs a completed round, bottleneck evidence, positive remaining depth
budget and an independent acceptance condition. A depth budget of zero plans no
children; a child is checked against its own `charter_expected_output` rather
than the parent's full-workflow metric.

The command then passes the unchanged hashed plan to
`materializeBridgeChildren`, which only writes the planned child contracts. Its
JSON result is the input to the downstream phases and the outer owner. A
missing helper, bridge input, evidence file or non-zero command exit stops the
current phase and produces a report; there is no second expansion
implementation to try.

## When the decomposition is the thing being optimized

A run can be asked to optimize how a question is split up rather than to answer
one: its positions are whole sub-ARLs, and what improves between iterations is
which positions exist, what each is asked, and which of them are serial. Such a
run walks the same phases. Four things happen around the bridge hand-off that an
ordinary run does not do.

`WORKFLOW_TOOLS_CLI` is the one `workflow-tools-cli.js` resolved by
[`shared-references/integration-contract.md`](../shared-references/integration-contract.md),
the same way `WORKFLOW_CLI` is resolved above.

**1. Record the generation before dispatching it.** The graph is decided first
and carried out second; a dispatch never decides one.

```bash
node "$WORKFLOW_TOOLS_CLI" decomposition-record \
  --project "$PROJECT_ROOT" \
  --run "$OUTER_RUN_ID" \
  --generation "$GENERATION" \
  --input "$DECOMPOSITION_JSON"
```

`$DECOMPOSITION_JSON` is `{"positions": [...]}`, each position carrying
`position_id`, `problem`, `expected_output`, `constraints` and `depends_on`
(empty means it runs in parallel with everything else). Generation 1 is the
run's baseline: creating it is all the justification it needs. A later
generation exists only after the tester has spoken - freeze the change with
`decomposition-prepare` first, which takes the previous generation as its
baseline and one tester-feedback signal as its reason, and `decomposition-record`
is what releases the structure hold that wave took. Each generation is recorded
once; re-recording different positions is refused, and changing what a position
asks makes new children with new Wikis rather than reusing the old ones.

**2. Dispatch, possibly in stages.** Run the same `bridge-input` and
`bridge-expand` commands; both pick the recorded graph up from disk, fill each
position's task in from it, and check the dispatch against it. A position whose
upstream has not published yet cannot be planned, so a graph with a serial edge
reaches the bridge more than once - dispatch what step 4 reports as
`dispatchable`, and come back for the rest when the edge is crossable. A
dispatch may be a subset of the generation; it may not contain a position the
generation does not have.

**3. Start one agent per child run.** The bridge writes child contracts and
starts nothing. For each `run_id` in the `bridge-expand` result, spawn one agent
under [`shared-references/paseo-subagent-dispatch.md`](../shared-references/paseo-subagent-dispatch.md)
Rule 2, bound to this same skill, and hand it exactly two values: the project
root and its own run id. No parent run id, no position, no generation - a child
is told what to do, not who dispatched it, and everything it needs is already in
its own charter. The child's tester is the acceptance its parent froze for it;
a sub-ARL never reaches the task tester and never spends tester exposure.

**4. Collect the generation back.**

```bash
node "$WORKFLOW_CLI" bridge-collect \
  --project "$PROJECT_ROOT" \
  --run "$OUTER_RUN_ID" \
  [--require-complete]
```

Without the flag this reports where the round stands: which positions are
`dispatchable`, `waiting`, `running`, and which came back `accepted`, plus each
child's verdict against the acceptance its parent gave it. With
`--require-complete` it fails `ROUND_INCOMPLETE` until every position the
generation declared has a terminal child. Nothing is written either way - the
answer is read from the recorded graph, the child index and each child's
published result package, and the scoring is `collectOrchestrationRound` in
`src/tools/orchestration-round.ts`. Do not re-derive a child's verdict here.

**5. Assemble, then measure.** Only once the round is complete does this run
measure the assembled whole with its own validator and publish `metric.current`
through the ordinary `analyze-results` receipt. `dashboard-merge` refuses that
key while any child is still out, so there is no round whose number describes
half a structure. The metric gate then runs unchanged: what it compares is this
generation's assembly against the last one's, which is what makes the
decomposition the thing being optimized.

If more generations are intended, say so once in the upstream artifact's
`remaining_generations` (see `/idea-discovery`'s bridge contract). The bridge
splits this run's budget across the generations still to come, so the first one
cannot spend all of it.

## Result status routing

The bridge applies the priority below before interpreting execution outcome.
The table is the contract implemented by `resultStatusPolicy` in
`src/tools/result-package.ts` and used by `src/tools/experiment-bridge.ts`.

The priority is:

| status | failure code | validation | tester exposure | stop gate |
| --- | --- | --- | --- | --- |
| `not_executable` | `RESOURCE_SCOPE_ALIGNMENT_REQUIRED` | no | no | no |
| `infra_unavailable` | `INFRA_UNAVAILABLE` | no | no | no |
| `succeeded` | — | yes | yes | no |
| `failed` | — | yes | yes | yes |

1. Any requested resource outside the frozen inventory is `not_executable`.
2. A request inside the inventory whose runtime probe is unavailable is
   `infra_unavailable`.
3. An available request with a successful execution is `succeeded`.
4. An available request that ran and failed is `failed`.

Only `failed` is a stop-gate failure. The two unavailable states remain visible
to the outer owner, but they do not enter validation, tester exposure or the
no-progress stop count. "Cannot perform this run" is different evidence from
"performed the run and it failed"; counting a missing accelerator as a failed
research attempt would make an environment problem close a research direction.

Every sibling keeps its own result. One unavailable position does not cancel
other positions. Dynamic ablation is built from positions whose policy enters
validation: no candidate means no matrix, one candidate means `00/10`, and two
candidates mean `00/10/01/11`. Once frozen, a changed width or a missing
constructible cell rejects the whole wave. The implementations are
`buildDynamicAblationPlan`, `validateFrozenDynamicAblationPlan` and
`decideWave` in `src/tools/experiment-bridge.ts`, backed by
`buildAblationPlan` in `src/tools/workflow-compiler.ts`.

## Phase boundaries

### Idea, bridge and execution

`idea-discovery` proposes work against the supplied charter and pinned Wiki
head. `experiment-bridge` validates the supplied baseline, resource inventory
and scope before producing its plan. The execution worker writes only within
the supplied write scope and returns a hashed receipt plus the declared
artifact.

If the bridge or execution receipt is genuinely `failed` or unusable, the
scheduler may open a bounded `bridge-repair` review with the same frozen input,
dispatching `/auto-review-loop` with `context.purpose = "bridge_repair"` and
`context.repair_reason = "execution"`. Repair may fix the current
implementation or environment, then retry the same identity. It may not change
the method meaning, interface, connection, metric gate or tester definition. An
out-of-scope resource is not repaired by silently changing the request; an
unavailable resource is not turned into a measured negative result.

### Where each review verdict goes

`analyze-results` runs inside `experiment-bridge` and may inspect only the
experiment evidence belonging to the current run. It must not turn
`not_executable` or `infra_unavailable` into a validation sample. Stage 3's
`/auto-review-loop` then reviews that evidence through the canonical receipt; a
worker's self-approval or prose message is not enough.

The verdict decides where the run goes next, and the four verdicts do not share
a path:

- `ready` / `almost` - the result was judged and stands. Continue to the
  metric gate; `/result-to-claim` writes the iteration's claim into the Wiki.
- `not ready` - the idea was judged and did not hold up. The iteration
  advances and Stage 1 starts over, because the next attempt is a different
  idea.
- `insufficient` - the evidence does not settle the question. What fell short
  is the experiment, so open `bridge-repair` with
  `context.repair_reason = "insufficient_evidence"` and keep the same idea, the
  same candidate and the same iteration. The repair tunes the experiment (see
  `/dse-loop`), then the bridge reruns and the new evidence is reviewed again.
  Do not send this back to `idea-discovery`: nobody asked for a new idea. When
  the repair budget runs out the run completes with no result rather than
  failing.

---

## Stage 3: Auto Review (quality verdict for THIS iteration)

Dispatch `/auto-review-loop` for cross-model review of the iteration's results.
The manifest mirrors `/research-pipeline` Stage 3.

> **Boundary.** This review ends the current iteration's review/fix rounds.
> Its verdict ({ready, almost, not ready, insufficient} + score) is recorded on
> the dashboard and reported in the summary. It is a quality verdict - it NEVER
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

**`insufficient` means the review could not rule at all.** The other three
verdicts are judgements of the result: the review looked at the evidence and
graded it. `insufficient` says the experiment never settled the question -
parameters were off, the sample was too small, a control was not held. What
fell short is the experiment, not the idea, so nobody asked for a new one.
Merging that receipt puts the run back into `bridge-repair` with
`context.repair_reason = "insufficient_evidence"`, keeping the same idea, the
same candidate and the same iteration. The repair is a search over the knobs
`EXPERIMENT_PLAN.md` already names and `/experiment-bridge` already exposed as
runtime flags; dispatch `/dse-loop` to do the tuning. Changing a value is a
repair, changing which question the experiment asks is not.

An unjudgeable result never enters `metric.history`, and when the repair budget
runs out the run completes with no result rather than failing - "we could not
measure this" is different evidence from "we measured this and it lost".

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
| 3 | the run's budget ledger cannot fund another reservation | `budget_exhausted` | pure budget termination |
| 4 | trailing no-improvement iterations in `metric.history` >= `patience` | `patience_exhausted` | pure arithmetic termination |
| 5 | `config.max_iterations` is set and `iteration >= config.max_iterations` | `iteration_cap` | backstop only - omit the field and there is no round limit |

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

## Result package export (on stop)

The summary narrates the run; this picks the round that came out best and
writes it as the run's result package. It is a separate step because no single
iteration can make the pick: an iteration only ever knows whether it beat the
one before it, and the stop gate firing does not mean the last round was the
best round. The whole series lives in this run's own Wiki, so the choice is
made here, from the Wiki, once the loop has stopped.

This is also what a parent run reads. A recursive parent never opens a child's
dashboard or Wiki - it reads `result-package.json` and nothing else - so a
child that never exported has produced nothing its parent can use.

Run it after the summary worker has closed the run's books, before paper
writing:

It takes three commands, because the package has to be reviewed and a package
cannot be reviewed after it is published:

```bash
# 1. Build the package without writing it. Prints the digest to be reviewed.
node "$WIKI_SCRIPT" plan_result_package "$ROOT" \
    --run "$RUN_ID" \
    --tester-definition "<frozen tester definition path>" \
    --wiki-root "<wiki dir>"

# 2. The reviewer -- a worker that is not this run -- rules on that digest.
node "$WIKI_SCRIPT" submit_result_review "$ROOT" \
    --run "$RUN_ID" --review-id "<review id>" \
    --reviewer "<reviewer worker id>" \
    --package-sha256 "<package_sha256 from step 1>" \
    --verdict approved --evidence "<what it read>"

# 3. Publish. Refused unless the stored review approves this exact digest.
node "$WIKI_SCRIPT" export_result_package "$ROOT" \
    --run "$RUN_ID" --review-id "<review id>" \
    --tester-definition "<frozen tester definition path>" \
    --wiki-root "<wiki dir>"
```

Step 1 prints `{winner, ranked_iterations, package_sha256, candidate}` and step
3 prints `{winner, ranked_iterations, result_package}`. That JSON is all the
orchestrator reads - the Wiki traversal happens inside the helper, the same way
the stop gate's arithmetic happens inside `metric-gate.js` (Rule 1).

The digest is what makes this a review rather than a formality. Steps 1 and 3
build the package the same way from the same evidence, so they agree; change
anything between them -- a new Wiki page, a different summary, another tester
definition -- and the digest moves, the stored verdict no longer describes what
is being written, and the export fails with `RESULT_REVIEW_SUBJECT_MISMATCH`.
A missing review is `RESULT_REVIEW_NOT_FOUND`, a `rejected` one is
`RESULT_REVIEW_REJECTED`, and a run naming itself as its own reviewer is
`REVIEWER_NOT_INDEPENDENT`. A verdict is immutable once stored: the package may
already have been published on the strength of it. `--wiki-root` defaults to the run's own Wiki
(`.aris/runs/$RUN_ID/wiki`); a standalone run whose Wiki is `research-wiki/`
must pass it. The package lands at `.aris/runs/$RUN_ID/result-package.json`,
with its human-readable `result-summary.md` beside it (`--summary` overrides
the generated text), and is immutable: re-running with the same inputs is a
no-op, and re-running after the Wiki moved on fails with `IMMUTABLE_CONFLICT`
rather than overwriting. Identity fields (`parent_run_id`, `scope_path`,
`input_snapshot_sha256`) are copied from `run.json`, so the caller cannot get
them wrong.

### How the best iteration is chosen

Three criteria, in order:

1. **The tester's declared metrics.** This is the held-out judgment, so it
   decides first. All of `gate.primaries` count together: an iteration loses
   only to one that is at least as good on every declared metric and strictly
   better on at least one. Two iterations that each win a different metric
   neither beat the other, and the next criterion separates them.
2. **The metric gate's reading for that iteration**, in the dashboard's own
   `metric.direction`. This is the loop's internal stop-condition measurement,
   so it only breaks ties the tester left open.
3. **The later iteration**, so the answer is the same on every re-run.

Once any iteration has a tester reading, iterations without one are out of the
running entirely - they have no measurement on the evidence that decides
first. Pass `--tester-definition` whenever that is the case; without it the
export cannot know which direction each declared metric improves and stops
with `TESTER_DEFINITION_REQUIRED`.

### What the export cross-checks

Two facts are recorded in two places on purpose, and the export exists partly
to confirm they agree. Neither duplicate is a second source of truth; a
disagreement is a hard failure, never a silent preference for one side.

| Check | Failure |
|---|---|
| Each page's `gate_metric` equals the dashboard's `metric.history` value for the same iteration | `GATE_METRIC_MISMATCH` |
| The dashboard has a reading at all for an iteration whose page recorded one | `GATE_METRIC_MISSING` |
| Every judged page names the tester definition passed in `--tester-definition` | `TESTER_DEFINITION_MISMATCH` |
| Every judged page records exactly the metric names that definition declares | `TESTER_METRIC_SET_MISMATCH` |
| Some experiment page carries an `iteration` | `NO_EXPORTABLE_EXPERIMENT` |
| No two pages claim the same iteration | `DUPLICATE_ID` |

### What each iteration has to record for this to work

The export reads only what `/result-to-claim` wrote at that iteration's
termination, so `add_experiment` must carry:

- `--iteration <n>` - the outer iteration this experiment belongs to. A page
  without it is not a candidate.
- `--gate-metric <value>` - that iteration's metric-gate reading, the same
  number the dashboard received.
- `--tester-feedback <receipt> --tester-public-key <key>` - both or neither.
  Tester numbers enter the Wiki only through a signature-verified public
  receipt; there is no flag for typing them in. The receipt names the
  iteration it judged, so supplying `--iteration` as well is only allowed when
  the two agree.

Recorded tester values stay readable after they land: the export ranks by
them, and a Wiki query or the markdown projection returns the same numbers,
alongside the coarse conclusion, directions and advice. What never enters the
page is the test content behind those numbers. See
[Fixed tester boundary](#fixed-tester-boundary).

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

## Workspace and Wiki boundary

The caller supplies `workspace_root`, `write_scope`, `wiki_root`, the Wiki
request and its exact head. Keep a run's Wiki under that run's
`worktrees/<run_id>/` directory; do not use a shared Wiki or derive a second
location here. The current local workspace adapter records the concrete
worktree as `.aris/worktrees/<run_id>` and still creates it with Git. That is
an implementation boundary, not permission for a worker to concatenate paths or
to claim Paseo workspace archival is already wired up.

If the workspace, scope or Wiki helper is missing, stop. Do not substitute the
current checkout, an ancestor directory or an old receipt.

## Fixed tester boundary

The tester exists so the research loop cannot train against its own target.
After submission, the research side may receive only the terminal gate
conclusion and the fixed coarse public feedback that the current remote
contract exposes. It may not analyze the tester run.

Never send or read tester case content, answers, prompts, per-case output,
per-case scores, private observations, fine-grained categories or private URIs.
The sanitizer's forbidden key vocabulary includes `case_id`, `case_ids`,
`prompt`, `question`, `answer`, `score`, `scores`, `per_case`,
`private_uri`, `artifact_uri`, `result_uri`, `raw_result`, `exact_example` and
`category`.
The submission carries bindings and hashes such as artifact hashes, harness
hash, case manifest digest, input distribution and judge binding; it does not
carry the private cases themselves, which never leave the tester machine. The
response validator
in `src/tools/tester-agent.ts` accepts only terminal status, coarse
`error_analysis` and signed public receipts. `src/tools/tester-feedback.ts`
allows only the fixed coarse conclusion/direction/advice vocabulary and rejects
private keys.

The one numeric channel out of the tester is `tester_feedback.metrics`: the
aggregate value of each metric the tester definition declared in
`gate.primaries`, and nothing else. The names are frozen into
`definition_sha256` at task setup, and publishing checks both directions -
every declared metric must be reported, no undeclared one may be - so the
tester cannot widen its own disclosure later. There is still no defect list
field; do not describe one as available research input. What the tester says
about defects is the fixed coarse vocabulary - `conclusion`, `directions`,
`advice`, `confidence` - and nothing finer. A tester receipt is
never evidence for `analyze-results`, for Stage 3's review, or for a
research claim. Public tester metrics and that coarse verdict enter the Wiki
under their own source, and any research reader may read them back:
`idea-discovery`, a bridge repair and the result-package export all see the
same aggregates. Reading them is not tuning against the held-out set, because
the cases, prompts, answers and per-case scores that would let you tune never
reach the Wiki at all. When you cite one, write it as what the tester
reported, not as your own finding.

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
