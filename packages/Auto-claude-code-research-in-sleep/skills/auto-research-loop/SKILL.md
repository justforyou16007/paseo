---
name: auto-research-loop
description: 'Closed-loop research driver. Takes a research direction + metric target and drives a multi-round experiment-and-evidence loop: reproduce baseline → review baseline → identify problems → run experiments to prove/disprove problems → propose solution ideas → run experiments for top idea → review → identify new problems → loop until metric target met or max iterations reached. Uses research-wiki as the canonical record and a fresh codex sub-agent as the cross-model reviewer every round. Use when user says "auto research loop", "research iteration loop", "keep iterating until the metric is met", or wants to drive a long-running research investigation toward a quantitative target. Inserts into the W1–W6 pipeline as an optional `research-iteration` stage when AUTO_RESEARCH_ITERATIONS > 0.'
argument-hint: "[iteration N of M] [— resume <run_id>]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__wait_for_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat
---

# Auto Research Loop: closed research-iteration driver

> **Paseo substrate.** This workflow runs as ONE long-lived paseo claude agent looping iterations 1→N internally; every iteration dispatches a fresh codex sub-agent as the cross-model reviewer (per `shared-references/paseo-reviewer-dispatch.md`). Sub-skill dispatch (`/run-experiment`, `/research-review`, `/idea-creator`, `/result-to-claim`) is also via paseo child agents. The fence (`shared-references/external-cadence.md`) forbids wrapping this skill in `/loop` / `CronCreate` / `create_heartbeat`. The single-agent loop owns internal cadence; the heartbeat (Type-A only) may nudge stalled sub-phases but never recreates this skill.

> **The 10 phases per iteration, in order:**
> 1. baseline reproduction (`/run-experiment` for the original method)
> 2. auto-review baseline (`/research-review` of the baseline)
> 3. identify baseline problems (reviewer-issued, recorded as claims)
> 4. run experiments to prove/disprove problems (`/run-experiment` or `/experiment-queue` for multi-seed)
> 5. propose solution ideas — multi-branch (`/idea-creator`)
> 6. record ideas (`research-wiki.js upsert_idea`)
> 7. run experiments for the top surviving idea (`/run-experiment`)
> 8. auto-review that idea (`/result-to-claim` on each new claim)
> 9. identify new problems (reviewer-issued)
> 10. loop back to step 4
>
> Stop when the **compound gate** fires: (Type-A: `current_metric >= target_metric` OR `iteration >= MAX_ITERATIONS`) AND (Type-B: fresh codex verdict=`stop` with `score >= 9` AND `metric_progress=met target`).

## Constants

- **MAX_ITERATIONS = 5** — Max full loop bodies. `1` = today's flow (baseline → experiments → summary). `0` = the stage is skipped entirely (see `research-pipeline` integration).
- **TARGET_METRIC** — Read from `CLAUDE.md` `## Metric Target` block. The block must contain a numeric line of the form `primary: <number> <unit>` (e.g. `primary: 0.85 F1`). The skill fails loudly with a clear error if absent.
- **TARGET_TOLERANCE = 0.01** — Relative tolerance. `current_metric >= target_metric * (1 - TOLERANCE)` counts as "met".
- **REVIEWER_MODEL = `gpt-5.5`** — OpenAI family (cross-model vs Claude executor). The `claude-opus-4-6` / `claude-sonnet-4-6` review options are FORBIDDEN — they would make the executor family its own reviewer (self-acquittal).
- **REVIEWER_BACKEND = `codex`** — Default backend. The strict-mode rule (`paseo-subagent-dispatch.md` Rule 4) forbids in-process codex fallbacks; paseo MCP is required.
- **REVIEWER_BIAS_GUARD = true** — Every round creates a fresh codex sub-agent. Round N's review does NOT see round N-1's review. Rationale: a continuation reviewer drifts toward confirming the fix it suggested last round; freshness is the only way to get a genuinely independent re-assessment for every iteration. Same choice as `auto-paper-improvement-loop`; opposite of `auto-review-loop`.
- **PATIENCE = 2** — Max consecutive rounds with `verdict=pivot` before forcing `verdict=stop` (prevents infinite-direction-churn).
- **OUTPUT_DIR = `research-iteration/`** — All artifacts and state files for this skill.
- **STATE_FILE = `research-iteration/auto-research-loop-state.json`** — Our private state file (round, last score, current metric, top idea). `run-state.json` is the orchestrator's per-phase status; this is the loop's internal loop state.
- **LOG_FILE = `research-iteration/auto-research-loop-log.md`** — Cumulative per-iteration narrative (added each round).
- **REPORT_FILE = `research-iteration/auto-research-loop-report.md`** — Final report (last iteration's summary + trajectory + artifacts).
- **HUMAN_CHECKPOINT = false** — Set to `true` to pause at the end of each iteration for user review.
- **DEBUG = false** — When `true`, pause on any helper failure per `shared-references/debug-mode.md`.

> 💡 Override via argument, e.g., `/auto-research-loop "iteration 2 of 3" — auto research iterations: 5, debug: true`.

## Inputs (read at startup)

1. **`CLAUDE.md` `## Metric Target` block** — contains `primary: <number> <unit>`. Fails loudly if absent. Also reads `## Project Constraints`, `## Non-Goals`, `## Compute Budget` to constrain the loop.
2. **`idea-stage/IDEA_REPORT.md`** — top idea(s) to start with (the baseline reference).
3. **`refine-logs/EXPERIMENT_RESULTS.md`** — existing experiment results.
4. **`refine-logs/EXPERIMENT_TRACKER.md`** — current experiment status.
5. **`research-wiki/index.md`** and `research-wiki/graph/edges.jsonl` — canonical state of ideas/claims/experiments/edges.
6. **`.aris/setup-state.json`** — the project's `research-setup` answers (e.g. `gpu_type`, `paseo_configured`).
7. **`.aris/runs/<run_id>.json`** — the orchestrator's per-phase run-state (read `phase=research-iteration` row).

If `CLAUDE.md` is missing the `## Metric Target` block, abort with: `ERROR: auto-research-loop requires `## Metric Target` in CLAUDE.md. Add a `primary: <number> <unit>` line under that header.`

## Iteration phases (the 10-step loop)

This is ONE iteration. The skill calls Step 1 at startup and after every round. The fence (`paseo-subagent-dispatch.md` §"fence") means ONE long-lived W-agent owns the loop; only the codex reviewer sub-agent is fresh per round.

### Step 1 — Load iteration context

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1

# Parse debug mode
DEBUG_MODE=false
case "$ARGUMENTS" in
  *debug:\ true*|*debug:true*|*--debug*) DEBUG_MODE=true ;;
esac

# Resolve ARIS_REPO
if [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi

# Read metric target
TARGET_METRIC=$(awk '/^## Metric Target/{flag=1; next} flag && /^primary:/{print $2; exit}' CLAUDE.md)
[ -n "$TARGET_METRIC" ] || { echo "ERROR: ## Metric Target missing from CLAUDE.md" >&2; exit 1; }

# Read current iteration from state file
STATE="research-iteration/auto-research-loop-state.json"
ITERATION=0
[ -f "$STATE" ] && ITERATION=$(grep -oE '"iteration": *[0-9]+' "$STATE" | tail -1 | grep -oE '[0-9]+')
ITERATION=$((ITERATION + 1))
```

When `DEBUG_MODE=true`, every helper failure triggers the debug halt protocol per `shared-references/debug-mode.md`.

### Step 2 — Round type selection

| iteration | Round type | What Step 3 + Step 4 dispatch |
|---|---|---|
| 1 (1-indexed) | baseline reproduction | Step 3 dispatch `/experiment-bridge refine-logs/EXPERIMENT_PLAN.md`. Step 4 records the experiments to research-wiki. |
| 2 | baseline review + kill-argument attack | Step 3 dispatch `/research-review` + `/kill-argument` on the baseline results. Step 4 derives a mini `EXPERIMENT_PLAN-diag-iter-2.md` from `kill-arg-iter-2.json` `still_unresolved`. |
| 3+ | hypothesis → experiment → review loop | Step 3 dispatch `/kill-argument` on the previous round's results → derive `EXPERIMENT_PLAN-diag-iter-N.md` → dispatch `/research-review` for convergence → `/experiment-bridge` runs the plan. Step 4 records + re-judges. |

The first iteration is the existing `experiment-bridge` (W1.5 equivalent). From iteration 2 onward, the loop reuses the same plan-driven pipeline: `kill-argument` finds problems, the orchestrator translates them into mini plans, `research-review` converges the plans, and `experiment-bridge` runs the experiments.

### Step 3 — Diagnose and dispatch

This step has two parts. Part (a) is "find the problems"; part (b) is "translate them into an EXPERIMENT_PLAN and run it". Both reuse existing skills — no new schema, no new tool.

**Step 3a — Kill-argument attack on the previous round's results** (iteration ≥ 2)

Dispatch `/kill-argument` (Paseo codex sub-agent per `paseo-subagent-dispatch.md`). Inputs: the previous round's `refine-logs/EXPERIMENT_TRACKER.md` + `refine-logs/EXPERIMENT_RESULTS.md` + the latest `research-iteration/auto-research-loop-log.md`. Output: `research-iteration/kill-arg-iter-N.json`:
```json
{
  "kill_arg": "<200-word strongest rejection>",
  "counter_argument": "<200-word defense>",
  "still_unresolved": ["issue 1", "issue 2", "issue 3"]
}
```

`still_unresolved` is the load-bearing field — the problems this round will design experiments to test.

**Step 3b — Translate problems into a mini plan and run it** (iteration ≥ 2)

For iteration 1, skip 3a/3b and dispatch `/experiment-bridge` directly with the project's existing `refine-logs/EXPERIMENT_PLAN.md` (today's behavior). For iteration ≥ 2:

1. **Orchestrator LLM pass** — read `kill-arg-iter-N.json`'s `still_unresolved`. For each unresolved issue, draft a `claim:diag-iter-N-<idx>` with: failure mode, evidence (cite `EXPERIMENT_TRACKER.md` row ids), root-cause hypothesis, minimal experiment, success threshold.
2. **Write `refine-logs/EXPERIMENT_PLAN-diag-iter-N.md`** — a plan containing ONLY the diagnostic milestones (no `sanity/baseline/main/ablation` headers — those are for a full run, not for verification experiments). Each milestone has: `id`, `claim_id`, `modification` (text), `metric_to_observe`, `success_threshold`. The format is the same `EXPERIMENT_PLAN.md` schema that `/experiment-bridge` already accepts; we're just making a smaller file.
3. **Dispatch `/research-review`** on the mini plan. The research-review skill's Step 4 convergence logic ("A concrete experiment plan is established") gives us a cross-model verdict on the plan quality. This is the gate before we burn GPU hours.
4. **Dispatch `/experiment-bridge "refine-logs/EXPERIMENT_PLAN-diag-iter-N.md"`** to run the diagnostic experiments. `experiment-bridge` will dispatch `/run-experiment` or `/experiment-queue` per its own auto-routing rule. It will write appended rows to `refine-logs/EXPERIMENT_TRACKER.md` and `refine-logs/EXPERIMENT_RESULTS.md`.

All sub-skill dispatches follow `shared-references/paseo-subagent-dispatch.md` Rule 1 (one agent = one skill) and Rule 4 (no in-process `Skill` fallbacks):

```bash
PROMPT=$(bash "$RENDER" --phase "<sub-skill>" --run-id "$RUN_ID" --root "$ROOT" \
         --skill skills/<sub-skill>/SKILL.md --extra "<iteration-specific context>")
```

Then `mcp__paseo__create_agent` with `notifyOnFinish: true`. The parent reacts to the child's `notifyOnFinish` by reading the receipt file `.aris/runs/<run_id>.research-iteration.iter-<N>.<sub>.done.json` — not by polling `get_agent_status` (per Rule 2).

When `HUMAN_CHECKPOINT=true`, before dispatching the next round, print the latest iteration's findings (from `LOG_FILE`) and wait for `go` / `skip` / `stop`.

### Step 4 — Evidence collection + result-to-claim re-judge

For every new experiment row that `experiment-bridge` appended to `EXPERIMENT_TRACKER.md`:

For every new experiment the sub-skill produced:

```bash
$ARIS_REPO/dist/tools/research-wiki.js add_experiment research-wiki/ \
  --id "exp:<run_id>.iter-<N>:<slug>" \
  --title "<experiment title>" \
  --idea-id "<top_idea_id>" \
  --status completed \
  --started-at "<ISO>" --completed-at "<ISO>" \
  --config-path "<abs path to .json/.yaml>"
```

For every claim touched by the iteration, dispatch `/result-to-claim` as a fresh codex sub-agent (Type-B; never self-judge). The sub-agent writes a verdict JSON per claim:

```json
{
  "claim_id": "claim:<id>",
  "claim_supported": "yes|partial|no",
  "what_results_support": ["exp:<id1>", "exp:<id2>"],
  "what_results_dont_support": [],
  "missing_evidence": ["..."],
  "suggested_claim_revision": "...",
  "next_experiments_needed": ["..."],
  "confidence": "high|medium|low",
  "codex_agent_id": "<paseo codex agent-id>"
}
```

Record each verdict via `research-wiki.js add_claim` (for new claims) or `add_edge --relation supports|invalidates` (for claim↔experiment links).

### Step 5 — Cross-model review (the codex reviewer sub-agent)

Every round dispatches a **fresh** codex sub-agent (per `paseo-reviewer-dispatch.md` and `REVIEWER_BIAS_GUARD=true`). The reviewer reads file paths only — no executor summary.

```bash
REVIEW_PROMPT=$(cat <<'EOF'
You are a senior cross-model reviewer (GPT-5.5) for an iterative research loop.

Objective: judge whether this iteration of the auto-research-loop should
continue, pivot, or stop. The user's metric target is the primary stop
criterion; the research direction is fixed (see CLAUDE.md).

Files to read (read them yourself; do not trust any summary):
  - $ROOT/CLAUDE.md  (research direction + Metric Target + Constraints)
  - $ROOT/idea-stage/IDEA_REPORT.md
  - $ROOT/refine-logs/EXPERIMENT_RESULTS.md
  - $ROOT/refine-logs/EXPERIMENT_TRACKER.md
  - $ROOT/research-iteration/auto-research-loop-state.json
  - $ROOT/research-iteration/auto-research-loop-log.md

Output (write to $ROOT/research-iteration/auto-research-loop-review.round-<N>.json):
  {
    "verdict": "improve|pivot|stop",
    "score": <int 1-10>,
    "summary": "<1-3 lines>",
    "issues": ["..."],
    "metric_progress": "<closer to target | met target | no change | regression>",
    "next_round_direction": "<concrete change to make next round, or null if stop>",
    "trace_path": "<filled by save_trace.sh>"
  }
Then return a one-line status. Do not call run_state.py. Do not modify
the research-wiki directly. Do not include the executor's summary in
your reply — read the files yourself.
EOF
)
```

After the reviewer returns, run `save_trace.sh` (resolved via the integration-contract §2 chain; Policy C forensic; write the trace inline if the helper is unresolved).

### Step 6 — Update state

```bash
# Per-iteration log
echo "$(printf '\n## Iteration %s (%s)\n\n' "$ITERATION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" >> research-iteration/auto-research-loop-log.md
echo "Round type: <type>" >> research-iteration/auto-research-loop-log.md
echo "Reviewer verdict: <verdict> (score: <n>/10)" >> research-iteration/auto-research-loop-log.md
echo "Metric progress: <from review>" >> research-iteration/auto-research-loop-log.md
echo "Next direction: <from review>" >> research-iteration/auto-research-loop-log.md

# Stall detection (Type-A fire-control only — never a quality verdict)
N_NEW=$(<research-wiki/research-wiki-stats.json jq '.new_findings_this_round' 2>/dev/null || echo 0)
$ARIS_REPO/dist/tools/iteration-log.js note "$ROOT" "$RUN_ID" research-iteration "$N_NEW" \
  --direction "<from review>"

# Update state file
CURRENT_METRIC=$(<refine-logs/EXPERIMENT_TRACKER.md awk '/primary:/{print $2; exit}' | tail -1)
cat > research-iteration/auto-research-loop-state.json <<EOF
{
  "iteration": $ITERATION,
  "last_score": <score>,
  "last_verdict": "<verdict>",
  "last_direction": "<from review>",
  "top_idea": "<top_idea_id>",
  "current_metric": $CURRENT_METRIC,
  "target_metric": $TARGET_METRIC,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# Per-phase run-state (for the orchestrator's per-phase status)
$ARIS_REPO/dist/tools/run-state.js set "$ROOT" "$RUN_ID" research-iteration done \
  --artifact "$ROOT/research-iteration/auto-research-loop-state.json"
```

### Step 7 — Stop check (compound gate, decomposed)

```
StopTypeA =
  (current_metric >= target_metric * (1 - TARGET_TOLERANCE))     ← goal met
  OR (iteration >= MAX_ITERATIONS)                             ← budget exhausted
  OR (consecutive_pivot_verdicts >= PATIENCE)                   ← direction churn

StopTypeB = (last_verdict == "stop")
            AND (last_score >= 9)
            AND (metric_progress == "met target")
            AND (codex_reviewer_id is not a claude-* model)     ← self-acquittal tripwire

STOP = StopTypeA AND StopTypeB

# If only Type-A fires (e.g. budget exhausted before metric met):
#   accept --reviewer "deterministic:research-iteration:max-iter-reached"
# If only Type-B fires (e.g. reviewer says "stop" but metric not met):
#   CONTINUE — the reviewer's "stop" without metric evidence is a Type-B failure
#   (reviewer is being conservative without basis). Log and loop.

if STOP:
    $ARIS_REPO/dist/tools/run-state.js accept "$ROOT" "$RUN_ID" research-iteration \
      --verdict-id "<codex agent-id or deterministic:max-iter-reached>" \
      --reviewer "<codex-gpt-5.5> | <deterministic:research-iteration:max-iter-reached>"
    # Write final report
    $ARIS_REPO/dist/tools/run-state.js status "$ROOT" "$RUN_ID"
    cp research-iteration/auto-research-loop-state.json research-iteration/auto-research-loop-report.md
    echo "## Final Report" >> research-iteration/auto-research-loop-report.md
    cat research-iteration/auto-research-loop-log.md >> research-iteration/auto-research-loop-report.md
    # Render HTML (non-blocking)
    # Render dispatched as a sub-agent via /render-html on the report file
else:
    # Loop back to Step 1 with the next iteration
    ITERATION=$((ITERATION + 1))
    goto Step 1
```

### Step 8 — Acceptance (run-state gate)

The `research-iteration` phase in `run-state.js` is `accepted` only when the compound gate fires. The acceptance-authority table (updated in `skills/research-pipeline/SKILL.md`) is:

| phase | what sets `accepted` | reviewer |
|---|---|---|
| `research-iteration` | compound gate fired: (Type-A: metric or max-iter) AND (Type-B: codex verdict=stop with score≥9 and `metric_progress=met target`); budget-only stop uses `deterministic:research-iteration:max-iter-reached` | `codex-gpt-5.5` + final codex agent-id OR `deterministic:research-iteration:max-iter-reached` |

## Integration with `research-pipeline`

When `MAX_ITERATIONS > 0` (configurable via `AUTO_RESEARCH_ITERATIONS` in the project's `CLAUDE.md` or set in `research-setup` Phase 6), the `research-pipeline` orchestrator:

1. Adds `research-iteration` to the `run-state.js start --phases` list, between `idea-discovery` and `auto-review-loop`.
2. After W1 (`idea-discovery`) is `accepted`, dispatches `/auto-research-loop "iteration 1 of N"` as a W-agent.
3. On `accepted`, continues to W2 (`auto-review-loop`) — the same downstream flow as today.

When `MAX_ITERATIONS = 0` (today's default), the stage is `skipped` and the pipeline short-circuits to the existing W2-onward flow.

## Critical Rules

1. **Fence compliance** — ONE long-lived W-agent, loops internally. Do NOT wrap in `/loop` / `CronCreate` / `create_heartbeat`. The single agent owns internal cadence.
2. **Reviewer freshness** — `REVIEWER_BIAS_GUARD=true`. Every round creates a fresh codex sub-agent. Round N's review does NOT see round N-1's review (opposite of `auto-review-loop`'s continuation).
3. **Type-B only on judgment** — the codex reviewer NEVER judges "good enough". It emits `improve` / `pivot` / `stop` + a `metric_progress` field. The parent reads the actual numeric metric (Type-A) to decide stop.
4. **Self-acquittal tripwire** — `run-state.js accept` with `reviewer` starting with `claude*` emits a stderr warning. Never accept on a Claude reviewer; require `codex-gpt-5.5` (or `deterministic:` for the budget-exhausted case). The strict-mode rule (`paseo-subagent-dispatch.md` Rule 4) forbids in-process codex fallbacks; paseo MCP is required.
5. **Canonical writes only** — every claim, idea, experiment, edge goes through `research-wiki.js {add_claim, upsert_idea, add_experiment, add_edge}`. NO freehand markdown in `research-wiki/`. Same invariant as `idea-creator` Phase 7.
6. **No in-process `Skill` tool calls** — dispatch sub-skills via `mcp__paseo__create_agent`. The strict-mode rule (Rule 4) forbids in-process execution.
7. **Compound gate decomposition** — the stop check must be SPLIT. Type-A part (metric, max-iter, pivot-count) is owner-self-judgeable. Type-B part (verdict=stop with metric-progress=met target) MUST come from a codex sub-agent. Never conflate; never let a Type-A-only stop pass a Type-B acquittal.
8. **Patience enforcement** — if `consecutive_pivot_verdicts >= PATIENCE` (2), force `verdict=stop` to prevent infinite direction-churn. This is a Type-A fire-control — no quality judgment.
9. **24h stale-state recovery** — on startup, if `auto-research-loop-state.json` exists AND `timestamp` is within 24h, resume from `iteration+1`. Otherwise, fresh start.
10. **Helper resolution** — every helper (`research-wiki.js`, `iteration-log.js`, `run-state.js`, `save_trace.sh`) resolved via the canonical chain from `shared-references/integration-contract.md` §2: `.aris/dist/tools/<helper>` → `dist/tools/<helper>` → `$ARIS_REPO/dist/tools/<helper>`. Variant A (hard-fail) for the wiki itself; Variant B (warn-and-skip) for callers of optional helpers.

## External dependencies (reused, not modified)

- `src/tools/research-wiki.ts` — all 12 subcommands (`init`, `slug`, `ingest_paper`, `sync`, `add_claim`, `upsert_idea`, `add_experiment`, `add_edge`, `rebuild_query_pack`, `rebuild_index`, `stats`, `log`). Writers default to skip-on-exist; `--update-on-exist` forces overwrite. Field-level injection quarantine (threat-scan) is on by default.
- `src/tools/run-state.ts` — `accept` (requires non-empty `verdict_id` and `reviewer`; warns on `claude*` reviewer; only writes `EXECUTOR_STATUSES` via `setStatus`), `setStatus`, `resumePoint`, `startRun`.
- `src/tools/iteration-log.ts` — `note` (per-iteration log to `.aris/runs/<run_id>.iterations.jsonl`; `pivotFor` returns `none` / `structural` / `human` at `stale_count` 0 / 2 / 4).
- `src/tools/provenance.ts` — `stamp` after every codex round (cross-family integrity check).
- `src/lib/cli.ts` / `src/lib/run.ts` — `createCli` / `runCli` / `run` (the `run` helper swallows non-zero exit; check `exitCode` in the caller).
- `skills/result-to-claim/SKILL.md` — dispatched as a sub-agent for every claim judgement. 5-step contract: collect evidence → deterministic pre-check → codex judgment → integrity attach → route.
- `skills/run-experiment/SKILL.md` — dispatched for baseline + idea experiment runs.
- `skills/experiment-queue/SKILL.md` — dispatched for multi-seed / multi-config batches.
- `skills/research-review/SKILL.md` — dispatched for baseline review + cross-model judgment on each iteration.
- `skills/idea-creator/SKILL.md` — dispatched for multi-branch idea generation in iteration 2+ (Phases 0–7 of that skill, ending in `upsert_idea`).
- `skills/shared-references/paseo-subagent-dispatch.md` — Rule 1 (one agent = one skill), Rule 2 (parent-child push), Rule 3 (file-paths-only), Rule 4 (Paseo MCP only).
- `skills/shared-references/paseo-reviewer-dispatch.md` — codex sub-agent spawn shape, fresh-thread bias guard, prompt contract.
- `skills/shared-references/external-cadence.md` — the fence.
- `skills/shared-references/integration-contract.md` — helper resolution chain.
- `skills/shared-references/review-tracing.md` — `save_trace.sh` (Policy C forensic).
- `skills/shared-references/acceptance-gate.md` — Type-A vs Type-B gate classification.
- `skills/shared-references/debug-mode.md` — `DEBUG=true` halt protocol.
