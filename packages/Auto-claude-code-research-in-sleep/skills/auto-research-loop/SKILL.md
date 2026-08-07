---
name: auto-research-loop
description: 'Closed-loop research driver. Takes a research direction + metric target and drives a multi-round experiment-and-evidence loop: reproduce baseline → review baseline → identify problems → run experiments to prove/disprove problems → propose solution ideas → run experiments for top idea → review → identify new problems → loop until metric target met or max iterations reached. Uses research-wiki as the canonical record and a fresh codex sub-agent as the cross-model reviewer every round. Use when user says "auto research loop", "research iteration loop", "keep iterating until the metric is met", or wants to drive a long-running research investigation toward a quantitative target. Inserts into the W1–W6 pipeline as an optional `research-iteration` stage when AUTO_RESEARCH_ITERATIONS > 0.'
argument-hint: "[iteration N of M] [— resume <run_id>]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__wait_for_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat
---

# Auto Research Loop: closed research-iteration driver

> **Paseo substrate.** This workflow runs as ONE long-lived paseo claude agent looping iterations 1→N internally. The parent agent **schedules only** — it dispatches sub-agents, reads their receipt files, runs canonical bookkeeping helpers with values taken verbatim from those receipts, and evaluates the deterministic stop arithmetic. It performs **no analysis, no drafting, and no judgment of its own**. Every iteration dispatches a fresh codex sub-agent as the cross-model reviewer (per `shared-references/paseo-reviewer-dispatch.md`). Sub-skill dispatch (`/run-experiment`, `/research-review`, `/idea-creator`, `/result-to-claim`, `/experiment-env-configuration`) is also via paseo child agents. The fence (`shared-references/external-cadence.md`) forbids wrapping this skill in `/loop` / `CronCreate` / `create_heartbeat`. The single-agent loop owns internal cadence; the heartbeat (Type-A only) may nudge stalled sub-phases but never recreates this skill.

> **Division of labour (non-negotiable).** See "Critical Rule 11".
>
> | The parent MAY | The parent MUST NOT |
> |---|---|
> | `create_agent` / `wait_for_agent` / `archive_agent` | Read experiment logs to form an opinion |
> | Read a receipt JSON and extract its fields | Draft a gap, claim, hypothesis, or experiment plan |
> | Run `research-wiki.js` / `run-state.js` / `iteration-log.js` with receipt values verbatim | Summarize, interpret, or narrate results |
> | Evaluate the Type-A stop arithmetic (numeric comparisons) | Decide whether a result is "good enough" |
> | Append the log line assembled from receipt fields | Compose the log's analytical content |

> **The 10 phases per iteration, in order:**
> 1. baseline reproduction (`/experiment-bridge`), then check if the experiment environment is configured (`.claude/skills/run-<project>-experiment/env.json` with `status == "complete"`); warn the user to run `/experiment-env-configuration` manually if not
> 2. auto-review baseline (`/research-review` of the baseline)
> 3. identify baseline problems (reviewer-issued, **recorded as gaps** in `research-wiki/gap_map.md`)
> 4. run experiments to prove/disprove the gaps (`/run-experiment` or `/experiment-queue` for multi-seed)
> 5. propose solution ideas — multi-branch (`/idea-creator`), each targeting a gap id
> 6. record ideas (`research-wiki.js upsert_idea --target-gaps`)
> 7. run experiments for the top surviving idea (`/run-experiment`)
> 8. auto-review that idea (`/result-to-claim` on each new claim, `--addresses` the gap it closes)
> 9. identify new gaps (reviewer-issued)
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

> 💡 Override via argument, e.g., `/auto-research-loop "iteration 2 of 3" — auto research iterations: 5`.

## Inputs (read at startup)

1. **`CLAUDE.md` `## Metric Target` block** — contains `primary: <number> <unit>`. Fails loudly if absent. Also reads `## Project Constraints`, `## Non-Goals`, `## Compute Budget` to constrain the loop.
2. **`idea-stage/IDEA_REPORT.md`** — top idea(s) to start with (the baseline reference).
3. **`refine-logs/EXPERIMENT_RESULTS.md`** — existing experiment results.
4. **`refine-logs/EXPERIMENT_TRACKER.md`** — current experiment status.
5. **`research-wiki/index.md`** and `research-wiki/graph/edges.jsonl` — canonical state of ideas/claims/experiments/edges.
6. **`.aris/setup-state.json`** — the project's `research-setup` answers (e.g. `gpu_type`, `paseo_configured`). Note: `gpu_type` is transcribed from the generated experiment skill's `info.sh` output by `/research-setup` Phase 7.5; the read contract here is unchanged — this skill reads `gpu_type` from `setup-state.json`.
7. **`.aris/runs/<run_id>.json`** — the orchestrator's per-phase run-state (read `phase=research-iteration` row).

If `CLAUDE.md` is missing the `## Metric Target` block, abort with: `ERROR: auto-research-loop requires `## Metric Target` in CLAUDE.md. Add a `primary: <number> <unit>` line under that header.`

## Iteration phases (the 10-step loop)

This is ONE iteration. The skill calls Step 1 at startup and after every round. The fence (`paseo-subagent-dispatch.md` §"fence") means ONE long-lived W-agent owns the loop; only the codex reviewer sub-agent is fresh per round.

### Step 1 — Load iteration context

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1

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

### Step 2 — Round type selection

This is a table lookup on `ITERATION`, not a judgment. The parent selects the row and dispatches; it does not decide what the round should contain.

| iteration | Round type | What Step 3 + Step 4 dispatch |
|---|---|---|
| 1 (1-indexed) | baseline reproduction + environment freeze | Step 3 dispatches `/experiment-bridge refine-logs/EXPERIMENT_PLAN.md`, then checks whether `.claude/skills/run-<project>-experiment/env.json` exists with `status == "complete"`. If yes: the experiment environment is already configured — use it. If no: log a warning that the experiment environment is not configured and note that the user should run `/experiment-env-configuration` manually. Step 4 records the experiments to research-wiki. |
| 2 | baseline review + kill-argument attack | Step 3 dispatches `/kill-argument — gap-output: research-wiki/gap_map.md` on the baseline results to find problems and record them as gaps, then `/research-review` on the generated plan. Step 4 records the claims. |
| 3+ | hypothesis → experiment → review loop | Step 3 dispatches `/kill-argument — gap-output: research-wiki/gap_map.md` on the previous round's results, then `/research-review` for convergence → `/experiment-bridge` runs the plan. Step 4 records + re-judges. |

The first iteration is the existing `experiment-bridge` (W1.5 equivalent) plus the environment freeze. From iteration 2 onward, the loop reuses the same pipeline: `/kill-argument` identifies problems, records them **directly** as gaps in `gap_map.md`, and produces a diagnostic experiment plan — all in one skill invocation. `/research-review` converges the plan, then `/experiment-bridge` runs the experiments.

### Step 3 — Diagnose and dispatch

Two parts for iteration ≥ 2. Part (a) dispatches `/kill-argument` which finds problems, records them as gaps, and produces a diagnostic experiment plan — all inside one sub-agent. Part (b) — iteration 1 only — freezes the environment. **Every part is a dispatched sub-agent.** The parent's entire role in this step is: render the prompt, create the agent, wait, read the receipt.

**Step 3a — Kill-argument with gap output** (iteration ≥ 2)

For iteration 1, skip 3a and dispatch `/experiment-bridge` directly with the project's existing `refine-logs/EXPERIMENT_PLAN.md` (today's behavior), then run Step 3b. For iteration ≥ 2:

Dispatch `/kill-argument` as a paseo sub-agent (Rule 1, Rule 4) with these additional arguments:

```
/kill-argument refine-logs/ — gap-output: research-wiki/gap_map.md — plan-output: refine-logs/EXPERIMENT_PLAN-diag-iter-<N>.md — render html: false
```

The skill targets the experiment results (not a paper) and is invoked with:

- `— gap-output: research-wiki/gap_map.md` — instructs kill-argument to append its `still_unresolved` findings as gap entries to `gap_map.md`, using the established format (`## G<n> — <label>`, Status/Sub-direction/Why it matters/What would close it). Kill-argument already has the structured data for each field:
  - Gap title = `decomposed_points[i].label`
  - Why it matters = `decomposed_points[i].attack_claim` + `evidence`
  - What would close it = `decomposed_points[i].recommended_fix`
  - Status = `open (iteration <N>, kill-argument)`
- `— plan-output: refine-logs/EXPERIMENT_PLAN-diag-iter-<N>.md` — instructs kill-argument to also produce the diagnostic experiment plan for the identified gaps. Each milestone maps to one gap: `id`, `gap_id` (the `G<n>`), `modification`, `metric_to_observe`, `success_threshold`. The format matches the `EXPERIMENT_PLAN.md` schema that `/experiment-bridge` already accepts.
- `— render html: false` — skip the HTML render step (no paper directory context here).

**Why kill-argument does this directly:** Kill-argument already performs the adversarial analysis, already knows what's `still_unresolved`, and already has the structured per-point data (label, evidence, severity, recommended fix). Having a separate sub-agent re-read that output and "creatively interpret" it into gaps is both wasteful and a potential distortion layer. The skill that finds the problems is the right skill to state them as gaps — no middleman.

The parent passes input paths only — it does not read experiment logs or form opinions about what the problems are. After the sub-agent finishes:

Receipt: `.aris/runs/<run_id>.research-iteration.iter-<N>.kill-arg-gaps.done.json` with:
```json
{
  "phase": "kill-arg-gaps",
  "iteration": <N>,
  "kill_arg_path": "research-iteration/KILL_ARGUMENT.json",
  "gap_ids": ["G7", "G8"],
  "gap_titles": ["<label for G7>", "<label for G8>"],
  "plan_path": "<abs path to EXPERIMENT_PLAN-diag-iter-N.md>",
  "milestone_count": <int>,
  "overall_verdict": "PASS|WARN|FAIL",
  "completed_at": "<ISO-8601>"
}
```

The parent reads this receipt (file-paths-only), then:

1. If `overall_verdict == "PASS"` (defense survives — no `still_unresolved`): no gaps to address, skip to Step 5 (stop evaluation). This is a natural convergence signal.
2. Otherwise: dispatch `/research-review` on `plan_path` for convergence checking, then `/experiment-bridge "<plan_path>"` to run the diagnostic experiments.

**Step 3b — Check the experiment environment** (iteration 1 only)

Immediately after baseline reproduction succeeds, check whether the experiment
environment has already been configured by `/experiment-env-configuration`:

```bash
PROJECT_NAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
ENV_JSON=".claude/skills/run-${PROJECT_NAME}-experiment/env.json"

if [ -f "$ENV_JSON" ]; then
  STATUS=$(grep -oE '"status": *"[^"]+"' "$ENV_JSON" | head -1 | grep -oE '"[^"]+"$' | tr -d '"')
  if [ "$STATUS" = "complete" ]; then
    echo "Experiment environment already configured: $ENV_JSON"
  else
    echo "WARNING: Experiment environment exists but status=$STATUS (not complete)."
    echo "Run /experiment-env-configuration manually to complete the setup."
  fi
else
  echo "WARNING: Experiment environment is not configured."
  echo "  Missing: $ENV_JSON"
  echo "  Run /experiment-env-configuration manually to configure the experiment environment."
  echo "  The skill requires user interaction and cannot be auto-configured."
fi
```

If the environment is configured (`status == "complete"`), the frozen skill at
`.claude/skills/run-<project>-experiment/` is used by later stages. If not,
the loop continues with the built-in backend — the research loop never blocks
on environment configuration.

All sub-skill dispatches follow `shared-references/paseo-subagent-dispatch.md` Rule 1 (one agent = one skill) and Rule 4 (no in-process `Skill` fallbacks):

```bash
PROMPT=$(bash "$RENDER" --phase "<sub-skill>" --run-id "$RUN_ID" --root "$ROOT" \
         --skill skills/<sub-skill>/SKILL.md --extra "<iteration-specific context>")
```

Then `mcp__paseo__create_agent` with `notifyOnFinish: true`. The parent reacts to the child's `notifyOnFinish` by reading the receipt file `.aris/runs/<run_id>.research-iteration.iter-<N>.<sub>.done.json` — not by polling `get_agent_status` (per Rule 2). Archive each child once its receipt is read (用完即 archive).

When `HUMAN_CHECKPOINT=true`, before dispatching the next round, print the latest iteration's findings (from `LOG_FILE`) and wait for `go` / `skip` / `stop`.

### Step 4 — Evidence collection + result-to-claim re-judge

This step is **pure bookkeeping**. Every value below comes verbatim from a receipt file. The parent does not read experiment logs, does not decide whether a claim holds, and does not compose any of the text it writes.

For every new experiment row that `experiment-bridge` appended to `EXPERIMENT_TRACKER.md` — the ids and paths come from the `experiment-bridge` receipt's `experiments[]` array:

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
  "addresses_gaps": ["G7"],
  "what_results_support": ["exp:<id1>", "exp:<id2>"],
  "what_results_dont_support": [],
  "missing_evidence": ["..."],
  "suggested_claim_revision": "...",
  "next_experiments_needed": ["..."],
  "confidence": "high|medium|low",
  "codex_agent_id": "<paseo codex agent-id>"
}
```

The parent records each verdict — again, verbatim, no interpretation:

```bash
# New claim, wired to the gap it addresses (the addresses_gap edge is emitted by add_claim)
$ARIS_REPO/dist/tools/research-wiki.js add_claim research-wiki/ \
  --id "<claim_id>" --statement "<statement from receipt>" \
  --addresses "<comma-joined addresses_gaps from receipt>"

# Claim ↔ experiment links
$ARIS_REPO/dist/tools/research-wiki.js add_edge research-wiki/ \
  --from "<claim_id>" --to "<exp:id>" --type supports|invalidates \
  --evidence "<from receipt>"
```

**Gap closure.** When a verdict has `claim_supported: "yes"` and a non-empty
`addresses_gaps`, the gap it names is answered. Dispatch a one-shot sub-agent to
edit that gap's `**Status**:` line in `research-wiki/gap_map.md` to
`closed (claim:<id>, iteration <N>)`. Gap entries are never deleted — the closed
entry plus its `addresses_gap` edge is the audit trail showing which experiment
answered which open question. `claim_supported: "no"` sets the status to
`refuted`, which is equally informative and prevents a later round from
re-proposing the same dead direction.

### Step 4.5 — Rebuild query pack and propose ideas (iteration ≥ 2)

Before the cross-model review, rebuild the research wiki's query pack so it
reflects the current state of gaps, claims, experiments, and edges. Then
dispatch `/idea-creator` to propose solution ideas targeting the open gaps.

**4.5a. Rebuild query pack:**

```bash
$WIKI_SCRIPT rebuild_query_pack research-wiki/
```

This compresses the wiki state into `research-wiki/query_pack.md` (~8000 chars),
which `/idea-creator` reads as its landscape context. Without this step,
idea-creator has no visibility into what the loop has already tried, what gaps
remain open, or what claims have been established.

**4.5b. Dispatch `/idea-creator`** as a paseo sub-agent (Rule 1, Rule 4):

```
/idea-creator — direction: "address open gaps in research-wiki/gap_map.md" — query-pack: research-wiki/query_pack.md — target-gaps: <comma-joined open gap IDs from gap_map.md>
```

The sub-agent reads `query_pack.md` for landscape context and `gap_map.md` for
the specific open gaps to target. It produces `idea-stage/IDEA_REPORT.md` with
ideas ranked by their potential to close the highest-priority open gaps.

Receipt: `.aris/runs/<run_id>.research-iteration.iter-<N>.idea-creator.done.json`

**4.5c. Record ideas** in the wiki (verbatim from receipt):

```bash
# For each idea in the receipt's ideas[] array:
$WIKI_SCRIPT upsert_idea research-wiki/ \
  --id "idea:<slug>" \
  --title "<title from receipt>" \
  --target-gaps "<comma-joined gap IDs this idea addresses>"
```

**4.5d. Select the top idea** for the next experiment round. The parent reads
the receipt's `top_idea_id` field — it does not rank ideas itself.

If no open gaps remain (all closed or refuted), skip this step — the loop is
converging and Step 5's review will evaluate whether to stop.

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

Bookkeeping only. Every interpolated value below is a field read out of a receipt or review JSON — the parent transcribes, it does not compose. In particular `<verdict>`, `<score>`, `<metric progress>`, and `<next direction>` are read from `auto-research-loop-review.round-<N>.json`; the parent never writes its own assessment into the log.

```bash
# Per-iteration log — a transcription of receipt fields, not a narrative
echo "$(printf '\n## Iteration %s (%s)\n\n' "$ITERATION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" >> research-iteration/auto-research-loop-log.md
echo "Round type: <type>" >> research-iteration/auto-research-loop-log.md
echo "Reviewer verdict: <verdict> (score: <n>/10)" >> research-iteration/auto-research-loop-log.md
echo "Metric progress: <from review>" >> research-iteration/auto-research-loop-log.md
echo "Next direction: <from review>" >> research-iteration/auto-research-loop-log.md
echo "Gaps opened: <gap_ids from kill-arg-gaps receipt>" >> research-iteration/auto-research-loop-log.md
echo "Gaps closed: <gap ids whose status flipped in Step 4>" >> research-iteration/auto-research-loop-log.md

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
  "open_gaps": [<gap ids still status=open>],
  "experiment_skill": "<skill_dir from the iter-1 env-config receipt, or null>",
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
5. **Canonical writes only** — every claim, idea, experiment, edge goes through `research-wiki.js {add_claim, upsert_idea, add_experiment, add_edge}`. NO freehand markdown in `research-wiki/`. Same invariant as `idea-creator` Phase 7. **`gap_map.md` is the one documented exception** — there is no `add_gap` subcommand, so gaps are appended as markdown in the established format by `/kill-argument` (Step 4.5, `— gap-output`), exactly as `/idea-discovery` and `/wiki-enrich` do. Everything that *references* a gap still goes through the helper (`add_claim --addresses`, `upsert_idea --target-gaps`, `add_edge --type addresses_gap`).
6. **No in-process `Skill` tool calls** — dispatch sub-skills via `mcp__paseo__create_agent`. The strict-mode rule (Rule 4) forbids in-process execution.
7. **Compound gate decomposition** — the stop check must be SPLIT. Type-A part (metric, max-iter, pivot-count) is owner-self-judgeable. Type-B part (verdict=stop with metric-progress=met target) MUST come from a codex sub-agent. Never conflate; never let a Type-A-only stop pass a Type-B acquittal.
8. **Patience enforcement** — if `consecutive_pivot_verdicts >= PATIENCE` (2), force `verdict=stop` to prevent infinite direction-churn. This is a Type-A fire-control — no quality judgment.
9. **24h stale-state recovery** — on startup, if `auto-research-loop-state.json` exists AND `timestamp` is within 24h, resume from `iteration+1`. Otherwise, fresh start.
10. **Helper resolution** — every helper (`research-wiki.js`, `iteration-log.js`, `run-state.js`, `save_trace.sh`) resolved via the canonical chain from `shared-references/integration-contract.md` §2: `.aris/dist/tools/<helper>` → `dist/tools/<helper>` → `$ARIS_REPO/dist/tools/<helper>`. Variant A (hard-fail) for the wiki itself; Variant B (warn-and-skip) for callers of optional helpers.
11. **The parent schedules; sub-agents work.** The parent agent's permitted actions are exhaustively: dispatch (`create_agent`), wait (`wait_for_agent` / `notifyOnFinish`), read a receipt JSON, run a canonical helper with receipt values **transcribed verbatim**, evaluate the Type-A numeric arithmetic, and archive a finished child. Anything requiring a judgment or a sentence of original prose — deciding what the problems are, writing an experiment plan, summarizing results, deciding a claim holds, composing the log's analytical content — is a sub-agent's job and MUST be dispatched. Concretely: Step 3a's gap identification and plan authoring is `/kill-argument` (one skill, one agent); Step 4's claim verdicts are `/result-to-claim` codex sub-agents; Step 5's assessment is the fresh codex reviewer. If the parent finds itself about to read an experiment log or write an original sentence, it is violating this rule — dispatch instead. The reason is not tidiness: a parent that forms its own opinion becomes a second, unaudited reviewer whose reasoning never appears in any receipt or trace, which defeats the cross-model acquittal design in Rules 2–4 and 7.
12. **Gaps for open questions, claims for evidenced assertions.** A kill-argument's `still_unresolved` entries are unanswered by construction, so they are recorded as **gaps** in `research-wiki/gap_map.md` — never as claims. Claims arrive later, from `/result-to-claim`, with `--addresses G<n>` pointing back at the gap the experiment closed. Recording an unresolved problem as a claim asserts something no experiment has shown and pollutes the claim graph with unfalsified statements.
13. **Environment configured once, replayed forever.** Iteration 1 checks whether `.claude/skills/run-<project>-experiment/env.json` exists with `status == "complete"` after the baseline reproduces. If the environment is already configured, the frozen preparation/run/feedback skill is used by all subsequent stages. If not configured, a warning is logged noting that the user should run `/experiment-env-configuration` manually — the skill requires user interaction and cannot be auto-configured. Later stages invoke the generated skill when available; they do not re-derive the sync path, conda hook, or metric key. That skill gates its own output on a cross-model `/experiment-audit` verdict (its Phase 5.5), so a frozen environment that exists has been reviewed by a different model family — the loop inherits that guarantee without doing anything. If the environment is not configured, the loop continues with the built-in backend — the research loop never blocks on environment configuration.

## External dependencies (reused, not modified)

- `src/tools/research-wiki.ts` — all 12 subcommands (`init`, `slug`, `ingest_paper`, `sync`, `add_claim`, `upsert_idea`, `add_experiment`, `add_edge`, `rebuild_query_pack`, `rebuild_index`, `stats`, `log`). Writers default to skip-on-exist; `--update-on-exist` forces overwrite. Field-level injection quarantine (threat-scan) is on by default.
- `src/tools/run-state.ts` — `accept` (requires non-empty `verdict_id` and `reviewer`; warns on `claude*` reviewer; only writes `EXECUTOR_STATUSES` via `setStatus`), `setStatus`, `resumePoint`, `startRun`.
- `src/tools/iteration-log.ts` — `note` (per-iteration log to `.aris/runs/<run_id>.iterations.jsonl`; `pivotFor` returns `none` / `structural` / `human` at `stale_count` 0 / 2 / 4).
- `src/tools/provenance.ts` — `stamp` after every codex round (cross-family integrity check).
- `src/lib/cli.ts` / `src/lib/run.ts` — `createCli` / `runCli` / `run` (the `run` helper swallows non-zero exit; check `exitCode` in the caller).
- `skills/result-to-claim/SKILL.md` — dispatched as a sub-agent for every claim judgement. 5-step contract: collect evidence → deterministic pre-check → codex judgment → integrity attach → route.
- `skills/kill-argument/SKILL.md` — dispatched in Step 3a (iteration ≥ 2) with `— gap-output` and `— plan-output` to find baseline problems, record them as gaps, and produce the diagnostic experiment plan. One skill, one agent — no separate gap-drafting intermediary.
- `skills/experiment-env-configuration/SKILL.md` — iteration 1 checks for its output (`.claude/skills/run-<project>-experiment/env.json` with `status == "complete"`) rather than dispatching it automatically. The skill requires user interaction; if the environment is not configured, a warning is logged and the user is told to run `/experiment-env-configuration` manually.
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
