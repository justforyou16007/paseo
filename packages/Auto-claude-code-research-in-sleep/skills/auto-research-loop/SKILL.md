---
name: auto-research-loop
description: 'Metric-target-driven iterative research loop. Based on research-pipeline architecture, runs repeated cycles of idea-discovery → experiment-bridge → auto-review-loop until the primary metric reaches the target. Each iteration discovers improvement ideas based on identified gaps, implements and runs them, reviews results, and checks progress. Requires a confirmed baseline and metric target. Use when user says "auto research loop", "research iteration loop", "迭代研究循环", "keep iterating until the metric is met", or wants autonomous iterative improvement toward a quantitative target.'
argument-hint: "[— baseline: <experiment-plan-path>] [— resume <run_id>] [— max-iterations: N]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__wait_for_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat
---

# Auto Research Loop — Metric-Target Iterative Research Driver

> **Paseo dispatch contract (Rule 1/4).** This skill is a thin scheduler. It dispatches sub-agents via `mcp__paseo__create_agent`, reads their receipt files, runs canonical bookkeeping helpers with values taken verbatim from those receipts, evaluates the deterministic stop arithmetic, and archives finished children. It performs **no analysis, no drafting, and no judgment of its own**. Every sub-skill invocation is a separate paseo agent — no in-process `Skill` tool calls. The parent never reads experiment logs to form opinions; it transcribes receipt fields into canonical helpers.

> **Gate provenance — compound stop gate.**
> - **Type-A (deterministic):** `current_metric >= target * (1 - TOLERANCE)` OR `iteration >= MAX_ITERATIONS` OR `consecutive_pivots >= PATIENCE`. Owner-self-judgeable arithmetic.
> - **Type-B (codex verdict):** Fresh codex reviewer confirms `verdict=stop`, `score >= 9`, `metric_progress=met target`. Cross-model, never self-acquittal.
> - **STOP = Type-A AND Type-B.** Neither alone is sufficient. Type-A without Type-B uses `deterministic:research-iteration:max-iter-reached`. Type-B without Type-A means the reviewer is being conservative without metric basis — log and continue.

## Purpose

This skill differs from `research-pipeline` in three ways:

1. **Iterative.** Research-pipeline is a single pass (W1→W6). This skill loops Phases 1–5 until a metric target is met or budget is exhausted.
2. **Metric-driven.** The loop is governed by a quantitative target read from `CLAUDE.md ## Metric Target`. Every iteration's output is evaluated against this target.
3. **Requires baseline.** Iteration 1 reproduces a confirmed baseline. Subsequent iterations discover and test improvements targeting identified gaps. The baseline establishes the floor; all progress is measured against it.

The architecture reuses research-pipeline's infrastructure: `run-state.js` for phase tracking, `render_w_agent_prompt.sh` for prompt construction, `paseo-config.json` for sub-agent configuration, and the same sub-skill dispatch patterns.

## Phase Diagram

```
Phase 0     Validate preconditions (metric target, env config, baseline plan)
─── Iteration loop (1 → MAX_ITERATIONS) ───
Phase 1     Idea Discovery
            iter 1: improvement directions for baseline
            iter N: ideas targeting open gaps from gap_map.md
Phase 2     Experiment Bridge
            iter 1: baseline reproduction
            iter N: run improvement experiments
Phase 3     Auto Review Loop (review + fix, up to 4 internal rounds)
Phase 4     Metric Evaluation + Compound Stop Gate
Phase 5     Gap Analysis (kill-argument → rebuild query pack) → loop
─── End loop ───
Phase 6     Summary (NARRATIVE_REPORT.md + metric trajectory)
Phase 7     Paper Writing (optional, dispatches /paper-writing)
```
## Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `MAX_ITERATIONS` | 5 | Max full loop iterations. Override via `— max-iterations: N` argument. |
| `TARGET_METRIC` | from CLAUDE.md | Read from `## Metric Target` block, line `primary: <number> <unit>`. |
| `TARGET_TOLERANCE` | 0.01 | Relative tolerance. `current >= target * (1 - 0.01)` counts as met. |
| `REVIEWER_BIAS_GUARD` | true | Fresh codex sub-agent every iteration. No continuation context. |
| `REVIEWER_MODEL` | gpt-5.5 | Cross-model (not Claude). Self-acquittal tripwire on `claude*`. |
| `PATIENCE` | 2 | Max consecutive `pivot` verdicts before forcing stop. |
| `OUTPUT_DIR` | `research-iteration/` | All iteration artifacts and state files. |
| `STATE_FILE` | `research-iteration/auto-research-loop-state.json` | Loop-internal state (iteration, metric, gaps). |
| `LOG_FILE` | `research-iteration/auto-research-loop-log.md` | Cumulative per-iteration transcript. |
| `REPORT_FILE` | `research-iteration/NARRATIVE_REPORT.md` | Final summary with metric trajectory. |
| `RUN_STATE_PHASES` | `preconditions,idea-discovery,experiment-bridge,auto-review,metric-eval,gap-analysis,summary` | Phases registered with run-state.js. |

## Inputs (read at startup)

1. **`CLAUDE.md ## Metric Target`** — Must contain `primary: <number> <unit>` (e.g., `primary: 0.85 F1`). Skill aborts if absent. Also reads `## Project Constraints` and `## Compute Budget`.
2. **Baseline plan** — Via `— baseline:` argument OR `refine-logs/EXPERIMENT_PLAN.md`. This is what iteration 1 reproduces.
3. **Experiment env config** — `.claude/skills/run-<project>-experiment/env.json` with `status=complete`. Warning if absent (user must run `/experiment-env-configuration` manually).
4. **Research wiki** — `research-wiki/index.md`, `research-wiki/graph/edges.jsonl`, `research-wiki/gap_map.md`. Created if absent.
5. **`.aris/setup-state.json`** — Project setup answers (gpu_type, paseo_configured).
6. **Run state** — `.aris/runs/<run_id>.json` if resuming.

---

## Phase 0: Validate Preconditions

Read the metric target, verify environment, locate baseline, and initialize run state.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1
ROOT=$(pwd)

# Resolve ARIS_REPO
if [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi
WIKI_SCRIPT="$ARIS_REPO/dist/tools/research-wiki.js"
RUN_STATE="$ARIS_REPO/dist/tools/run-state.js"
RENDER="$ARIS_REPO/dist/tools/render_w_agent_prompt.sh"

# 0a. Read metric target
TARGET_METRIC=$(awk '/^## Metric Target/{flag=1; next} flag && /^primary:/{print $2; exit}' CLAUDE.md)
if [ -z "$TARGET_METRIC" ]; then
    echo "ERROR: auto-research-loop requires '## Metric Target' in CLAUDE.md."
    echo "Add a 'primary: <number> <unit>' line under that header."
    exit 1
fi
TARGET_UNIT=$(awk '/^## Metric Target/{flag=1; next} flag && /^primary:/{print $3; exit}' CLAUDE.md)

# 0b. Check experiment environment
PROJECT_NAME=$(basename "$ROOT")
ENV_JSON=".claude/skills/run-${PROJECT_NAME}-experiment/env.json"
ENV_CONFIGURED=false
if [ -f "$ENV_JSON" ]; then
    STATUS=$(grep -oE '"status": *"[^"]+"' "$ENV_JSON" | head -1 | grep -oE '"[^"]+"$' | tr -d '"')
    [ "$STATUS" = "complete" ] && ENV_CONFIGURED=true
fi
if [ "$ENV_CONFIGURED" = "false" ]; then
    echo "WARNING: Experiment environment not configured (missing or incomplete $ENV_JSON)."
    echo "Run /experiment-env-configuration manually. Loop continues with built-in backend."
fi

# 0c. Locate baseline plan
BASELINE_PLAN="${ARG_BASELINE:-refine-logs/EXPERIMENT_PLAN.md}"
if [ ! -f "$BASELINE_PLAN" ]; then
    echo "ERROR: Baseline plan not found at $BASELINE_PLAN"
    echo "Provide via '— baseline: <path>' or ensure refine-logs/EXPERIMENT_PLAN.md exists."
    exit 1
fi

# 0d. Initialize run state
RUN_ID=$(date +%Y%m%d-%H%M%S)-research-loop
mkdir -p research-iteration .aris/runs
node "$RUN_STATE" start "$ROOT" "$RUN_ID" \
    --phases "preconditions,idea-discovery,experiment-bridge,auto-review,metric-eval,gap-analysis,summary"

# 0e. Emit paseo-config.json (sub-agent configuration)
cat > research-iteration/paseo-config.json <<CONF
{
  "run_id": "$RUN_ID",
  "root": "$ROOT",
  "target_metric": $TARGET_METRIC,
  "target_unit": "$TARGET_UNIT",
  "target_tolerance": 0.01,
  "max_iterations": ${ARG_MAX_ITERATIONS:-5},
  "reviewer_model": "gpt-5.5",
  "reviewer_bias_guard": true,
  "patience": 2,
  "baseline_plan": "$BASELINE_PLAN",
  "env_configured": $ENV_CONFIGURED
}
CONF

# 0f. Initialize state file
cat > "$STATE_FILE" <<STATE
{
  "iteration": 0,
  "current_metric": null,
  "target_metric": $TARGET_METRIC,
  "last_verdict": null,
  "last_score": null,
  "open_gaps": [],
  "consecutive_pivots": 0,
  "status": "running",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
STATE

node "$RUN_STATE" set "$ROOT" "$RUN_ID" preconditions done \
    --artifact "$ROOT/research-iteration/paseo-config.json"

# 0g. Read Reference Knowledge
REF_SKILLS=$(awk '/^## Reference Knowledge/{flag=1; next} flag && /^skills:/{flag2=1; next} flag2 && /^\[/{print; exit} flag2 && /^  -/{print}' CLAUDE.md | tr -d '[]" ' | paste -sd,)
REF_DOCS=$(awk '/^## Reference Knowledge/{flag=1; next} flag && /^documents:/{flag2=1; next} flag2 && /^\[/{print; exit} flag2 && /^  -/{print}' CLAUDE.md | tr -d '[]" ' | paste -sd,)
REF_KNOWLEDGE=$(awk '/^## Reference Knowledge/{flag=1; next} flag && /^knowledge:/{flag2=1; next} flag2 && /^\[/{print; exit} flag2 && /^  -/{gsub(/^  - /,""); print}' CLAUDE.md | paste -sd'|')

# If all empty, proceed without reference injection (no error — reference
# knowledge is optional).
```
---

## Phase 1: Idea Discovery (per iteration)

Dispatches `/idea-discovery` or `/idea-creator` as a paseo sub-agent. The parent constructs the prompt from file paths only — it does not read experiment results or compose improvement directions.

### Iteration 1: Improvement directions for baseline

The first iteration's goal is to identify what can be improved about the baseline. The baseline plan is the anchor.

```bash
PROMPT=$(bash "$RENDER" --phase "idea-discovery" --run-id "$RUN_ID" --root "$ROOT" \
    --skill skills/idea-discovery/SKILL.md \
    --extra "Baseline plan: $BASELINE_PLAN. Find improvement directions. Write IDEA_REPORT.md. | reference_skills: $REF_SKILLS | reference_docs: $REF_DOCS | domain_knowledge: $REF_KNOWLEDGE")

# Dispatch via paseo
mcp__paseo__create_agent \
    --title "research-loop-iter-1-idea-discovery" \
    --provider "claude/claude-sonnet-4-6" \
    --initialPrompt "$PROMPT" \
    --notifyOnFinish true
```

Wait for completion notification. Read receipt:
```
.aris/runs/$RUN_ID.research-iteration.iter-1.idea-discovery.done.json
```

Record ideas in wiki (verbatim from receipt):
```bash
for idea in $(jq -r '.ideas[] | @base64' "$RECEIPT"); do
    ID=$(echo "$idea" | base64 -d | jq -r '.id')
    TITLE=$(echo "$idea" | base64 -d | jq -r '.title')
    node "$WIKI_SCRIPT" upsert_idea research-wiki/ --id "$ID" --title "$TITLE"
done
```

### Iteration 2+: Ideas targeting open gaps

Before dispatching, rebuild the query pack so the idea generator has full context of what has been tried and what gaps remain open.

```bash
# Rebuild query pack with current wiki state
node "$WIKI_SCRIPT" rebuild_query_pack research-wiki/

# Read open gap IDs from gap_map.md
OPEN_GAPS=$(grep -E '^\*\*Status\*\*:.*open' research-wiki/gap_map.md \
    | grep -oE 'G[0-9]+' | paste -sd, -)

PROMPT=$(bash "$RENDER" --phase "idea-discovery" --run-id "$RUN_ID" --root "$ROOT" \
    --skill skills/idea-creator/SKILL.md \
    --extra "Target open gaps: $OPEN_GAPS. Query pack: research-wiki/query_pack.md. Gap map: research-wiki/gap_map.md. Find ideas that close the highest-priority open gaps. | reference_skills: $REF_SKILLS | reference_docs: $REF_DOCS | domain_knowledge: $REF_KNOWLEDGE")

mcp__paseo__create_agent \
    --title "research-loop-iter-${ITERATION}-idea-creator" \
    --provider "claude/claude-sonnet-4-6" \
    --initialPrompt "$PROMPT" \
    --notifyOnFinish true
```

**Gate:** deterministic — receipt file exists with non-empty `ideas[]` array.

```bash
node "$RUN_STATE" set "$ROOT" "$RUN_ID" idea-discovery done \
    --artifact "$RECEIPT"
```

---

## Phase 2: Experiment Bridge

Dispatches `/experiment-bridge` to implement and run experiments. Iteration 1 reproduces the baseline; iteration 2+ runs the improvement plan from Phase 1.

### Iteration 1: Baseline reproduction

```bash
PROMPT=$(bash "$RENDER" --phase "experiment-bridge" --run-id "$RUN_ID" --root "$ROOT" \
    --skill skills/experiment-bridge/SKILL.md \
    --extra "Reproduce baseline from: $BASELINE_PLAN. Record results to EXPERIMENT_TRACKER.md.")

mcp__paseo__create_agent \
    --title "research-loop-iter-1-experiment-bridge" \
    --provider "claude/claude-sonnet-4-6" \
    --initialPrompt "$PROMPT" \
    --notifyOnFinish true
```

After completion, verify the experiment environment:
```bash
if [ "$ENV_CONFIGURED" = "false" ] && [ -f "$ENV_JSON" ]; then
    STATUS=$(grep -oE '"status": *"[^"]+"' "$ENV_JSON" | head -1 | grep -oE '"[^"]+"$' | tr -d '"')
    [ "$STATUS" = "complete" ] && ENV_CONFIGURED=true
fi
```

### Iteration 2+: Run improvement experiments

```bash
# The plan comes from Phase 1's idea or Phase 5's kill-argument plan output
ITER_PLAN="refine-logs/EXPERIMENT_PLAN-iter-${ITERATION}.md"

PROMPT=$(bash "$RENDER" --phase "experiment-bridge" --run-id "$RUN_ID" --root "$ROOT" \
    --skill skills/experiment-bridge/SKILL.md \
    --extra "Run improvement experiments from: $ITER_PLAN. This is iteration $ITERATION targeting gaps: $OPEN_GAPS.")

mcp__paseo__create_agent \
    --title "research-loop-iter-${ITERATION}-experiment-bridge" \
    --provider "claude/claude-sonnet-4-6" \
    --initialPrompt "$PROMPT" \
    --notifyOnFinish true
```

Record experiments in wiki (verbatim from receipt):
```bash
RECEIPT=".aris/runs/$RUN_ID.research-iteration.iter-${ITERATION}.experiment-bridge.done.json"
for exp in $(jq -r '.experiments[] | @base64' "$RECEIPT"); do
    EXP_ID=$(echo "$exp" | base64 -d | jq -r '.id')
    EXP_TITLE=$(echo "$exp" | base64 -d | jq -r '.title')
    IDEA_ID=$(echo "$exp" | base64 -d | jq -r '.idea_id')
    node "$WIKI_SCRIPT" add_experiment research-wiki/ \
        --id "exp:$RUN_ID.iter-${ITERATION}:${EXP_ID}" \
        --title "$EXP_TITLE" \
        --idea-id "$IDEA_ID" \
        --status completed
done
```

**Gate:** deterministic — experiments[] in receipt is non-empty and all have `status: completed`.

```bash
node "$RUN_STATE" set "$ROOT" "$RUN_ID" experiment-bridge done \
    --artifact "$RECEIPT"
```
---

## Phase 2.5: Structured Analysis

After experiment-bridge completes (Phase 2), dispatch `/analyze-results` to
produce structured analysis before the review phase:

```bash
PROMPT="/analyze-results — project: $PROJECT"
# mcp__paseo__create_agent; await notifyOnFinish; read receipt
```

Receipt: `.aris/runs/<run_id>.research-iteration.iter-<N>.analyze-results.done.json`

The analysis output feeds:
- **Phase 3 (W2 review):** the reviewer gets `refine-logs/EXPERIMENT_RESULTS.md`
  with comparison tables and statistical tests rather than raw tracker rows.
- **Phase 4 (metric evaluation):** `CURRENT_METRIC` is read from the
  analyze-results receipt's `primary_metric` field rather than raw awk on
  EXPERIMENT_TRACKER.md.

```bash
# Read metric from analyze-results receipt instead of raw awk
RECEIPT=".aris/runs/${RUN_ID}.research-iteration.iter-${ITERATION}.analyze-results.done.json"
CURRENT_METRIC=$(jq -r '.primary_metric // empty' "$RECEIPT")
[ -z "$CURRENT_METRIC" ] && CURRENT_METRIC=$(awk '...' refine-logs/EXPERIMENT_TRACKER.md)  # fallback
```

---

## Phase 3: Auto Review Loop

Dispatches `/auto-review-loop` on the current iteration's results. The review loop runs up to 4 internal rounds (fix → re-review) before returning a final verdict. A **fresh** codex reviewer is used (per `REVIEWER_BIAS_GUARD`).

```bash
PROMPT=$(bash "$RENDER" --phase "auto-review" --run-id "$RUN_ID" --root "$ROOT" \
    --skill skills/auto-review-loop/SKILL.md \
    --extra "Review iteration $ITERATION results. Files: refine-logs/EXPERIMENT_RESULTS.md, refine-logs/EXPERIMENT_TRACKER.md, idea-stage/IDEA_REPORT.md. Metric target: $TARGET_METRIC $TARGET_UNIT. Use fresh codex reviewer (REVIEWER_BIAS_GUARD=true). Write verdict to research-iteration/review-iter-${ITERATION}.json. | reference_skills: $REF_SKILLS | reference_docs: $REF_DOCS | domain_knowledge: $REF_KNOWLEDGE")

mcp__paseo__create_agent \
    --title "research-loop-iter-${ITERATION}-auto-review" \
    --provider "claude/claude-sonnet-4-6" \
    --initialPrompt "$PROMPT" \
    --notifyOnFinish true
```

Wait for completion. Read review verdict:
```bash
REVIEW_FILE="research-iteration/review-iter-${ITERATION}.json"
VERDICT=$(jq -r '.verdict' "$REVIEW_FILE")
SCORE=$(jq -r '.score' "$REVIEW_FILE")
METRIC_PROGRESS=$(jq -r '.metric_progress' "$REVIEW_FILE")
CODEX_AGENT_ID=$(jq -r '.codex_agent_id' "$REVIEW_FILE")
```

**Gate:** codex verdict `score >= 6` (review acceptance threshold). If score < 6, the auto-review-loop's internal fix rounds have not converged — log and proceed to Phase 4 regardless (the metric is the primary gate).

```bash
node "$RUN_STATE" set "$ROOT" "$RUN_ID" auto-review done \
    --artifact "$REVIEW_FILE"
```

---

## Phase 4: Metric Evaluation + Compound Stop Gate

This is the critical decision point. The parent evaluates purely arithmetic conditions (Type-A) and reads the codex verdict (Type-B). No judgment, no interpretation — just comparisons.

### Type-A: Deterministic metric check

```bash
# Prefer metric from analyze-results receipt; fall back to raw awk on EXPERIMENT_TRACKER.md
ANALYZE_RECEIPT=".aris/runs/${RUN_ID}.research-iteration.iter-${ITERATION}.analyze-results.done.json"
CURRENT_METRIC=""
if [ -f "$ANALYZE_RECEIPT" ]; then
    CURRENT_METRIC=$(jq -r '.primary_metric // empty' "$ANALYZE_RECEIPT")
fi
if [ -z "$CURRENT_METRIC" ]; then
    CURRENT_METRIC=$(awk '/^|/{last=$0} END{
        split(last, a, "|");
        for(i=1;i<=length(a);i++) if(a[i] ~ /[0-9]+\.[0-9]+/) {print a[i]+0; exit}
    }' refine-logs/EXPERIMENT_TRACKER.md)
fi

# Compute threshold with tolerance
THRESHOLD=$(echo "$TARGET_METRIC * (1 - 0.01)" | bc -l)

# Type-A conditions
METRIC_MET=false
[ "$(echo "$CURRENT_METRIC >= $THRESHOLD" | bc -l)" = "1" ] && METRIC_MET=true

BUDGET_EXHAUSTED=false
[ "$ITERATION" -ge "${MAX_ITERATIONS:-5}" ] && BUDGET_EXHAUSTED=true

# Track consecutive pivots
CONSECUTIVE_PIVOTS=$(jq -r '.consecutive_pivots' "$STATE_FILE")
if [ "$VERDICT" = "pivot" ]; then
    CONSECUTIVE_PIVOTS=$((CONSECUTIVE_PIVOTS + 1))
else
    CONSECUTIVE_PIVOTS=0
fi
PATIENCE_EXCEEDED=false
[ "$CONSECUTIVE_PIVOTS" -ge 2 ] && PATIENCE_EXCEEDED=true

TYPE_A_FIRES=false
[ "$METRIC_MET" = "true" ] || [ "$BUDGET_EXHAUSTED" = "true" ] || [ "$PATIENCE_EXCEEDED" = "true" ] && TYPE_A_FIRES=true
```

### Type-B: Codex verdict confirmation

```bash
TYPE_B_FIRES=false
if [ "$VERDICT" = "stop" ] && [ "$SCORE" -ge 9 ] && [ "$METRIC_PROGRESS" = "met target" ]; then
    # Self-acquittal tripwire: reject if reviewer is Claude family
    if echo "$CODEX_AGENT_ID" | grep -qE '^claude'; then
        echo "TRIPWIRE: codex reviewer resolved to Claude model. Type-B rejected."
    else
        TYPE_B_FIRES=true
    fi
fi
```

### Compound gate evaluation

```bash
if [ "$TYPE_A_FIRES" = "true" ] && [ "$TYPE_B_FIRES" = "true" ]; then
    # FULL STOP — both gates fire
    STOP_REASON="compound_gate"
    # → Phase 6
elif [ "$TYPE_A_FIRES" = "true" ] && [ "$TYPE_B_FIRES" = "false" ]; then
    # Budget/patience exhausted without codex confirmation
    # Accept with deterministic reviewer
    STOP_REASON="deterministic:research-iteration:max-iter-reached"
    # → Phase 6
elif [ "$TYPE_A_FIRES" = "false" ] && [ "$TYPE_B_FIRES" = "true" ]; then
    # Codex says stop but metric not met — reviewer being conservative
    echo "Type-B fired without Type-A. Codex is conservative. Continuing."
    STOP_REASON=""
    # → Phase 5 (continue loop)
else
    # Neither fires — continue iterating
    STOP_REASON=""
    # → Phase 5
fi
```

### Update state file

```bash
cat > "$STATE_FILE" <<STATE
{
  "iteration": $ITERATION,
  "current_metric": $CURRENT_METRIC,
  "target_metric": $TARGET_METRIC,
  "last_verdict": "$VERDICT",
  "last_score": $SCORE,
  "metric_progress": "$METRIC_PROGRESS",
  "consecutive_pivots": $CONSECUTIVE_PIVOTS,
  "open_gaps": $(jq '.open_gaps' "$STATE_FILE"),
  "stop_reason": "$STOP_REASON",
  "status": "$([ -n "$STOP_REASON" ] && echo 'stopped' || echo 'running')",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
STATE

node "$RUN_STATE" set "$ROOT" "$RUN_ID" metric-eval done \
    --artifact "$STATE_FILE"
```

If `STOP_REASON` is non-empty → skip Phase 5, proceed to Phase 6.
If `STOP_REASON` is empty → proceed to Phase 5 (gap analysis + loop back).
---

## Phase 5: Gap Analysis (if metric not met)

When the compound gate does not fire, the loop must identify what to try next. This phase dispatches `/kill-argument` to find unresolved problems, records them as gaps, rebuilds the query pack, and loops back to Phase 1.

### 5a. Kill-argument with gap output

```bash
PROMPT=$(bash "$RENDER" --phase "gap-analysis" --run-id "$RUN_ID" --root "$ROOT" \
    --skill skills/kill-argument/SKILL.md \
    --extra "/kill-argument refine-logs/ — gap-output: research-wiki/gap_map.md — plan-output: refine-logs/EXPERIMENT_PLAN-iter-${NEXT_ITERATION}.md — render html: false | reference_skills: $REF_SKILLS | reference_docs: $REF_DOCS | domain_knowledge: $REF_KNOWLEDGE")

mcp__paseo__create_agent \
    --title "research-loop-iter-${ITERATION}-kill-argument" \
    --provider "claude/claude-sonnet-4-6" \
    --initialPrompt "$PROMPT" \
    --notifyOnFinish true
```

Kill-argument performs the adversarial analysis and directly:
- Appends `still_unresolved` findings as gap entries to `research-wiki/gap_map.md` (format: `## G<n> — <label>`, Status/Sub-direction/Why it matters/What would close it)
- Produces a diagnostic experiment plan at `refine-logs/EXPERIMENT_PLAN-iter-<N>.md` targeting those gaps

Receipt: `.aris/runs/$RUN_ID.research-iteration.iter-${ITERATION}.kill-argument.done.json`
```json
{
  "phase": "kill-argument",
  "iteration": "<N>",
  "gap_ids": ["G7", "G8"],
  "gap_titles": ["<label for G7>", "<label for G8>"],
  "plan_path": "refine-logs/EXPERIMENT_PLAN-iter-<N>.md",
  "milestone_count": 3,
  "overall_verdict": "PASS|WARN|FAIL",
  "completed_at": "<ISO-8601>"
}
```

### 5b. Evaluate kill-argument verdict

```bash
KA_VERDICT=$(jq -r '.overall_verdict' "$KA_RECEIPT")

if [ "$KA_VERDICT" = "PASS" ]; then
    # Defense survives — no unresolved gaps. Natural convergence.
    echo "Kill-argument: PASS. No new gaps. Loop converging."
    # Force Type-A to fire on next iteration (convergence signal)
fi
```

### 5c. Rebuild query pack

```bash
node "$WIKI_SCRIPT" rebuild_query_pack research-wiki/
```

This compresses the wiki state into `research-wiki/query_pack.md` (~8000 chars), giving Phase 1's idea generator full visibility into what has been tried and what gaps remain.

### 5d. Update gap tracking in state

```bash
OPEN_GAPS=$(grep -B2 'Status.*open' research-wiki/gap_map.md | grep -oE 'G[0-9]+' | jq -R . | jq -s .)

# Update state with new gaps
jq --argjson gaps "$OPEN_GAPS" '.open_gaps = $gaps' "$STATE_FILE" > "${STATE_FILE}.tmp"
mv "${STATE_FILE}.tmp" "$STATE_FILE"
```

### 5e. Iteration check and loop

```bash
NEXT_ITERATION=$((ITERATION + 1))

if [ "$NEXT_ITERATION" -gt "${MAX_ITERATIONS:-5}" ]; then
    echo "Max iterations ($MAX_ITERATIONS) reached. Exiting loop."
    STOP_REASON="deterministic:research-iteration:max-iter-reached"
    # → Phase 6
else
    ITERATION=$NEXT_ITERATION
    echo "Starting iteration $ITERATION..."
    # → Phase 1
fi

node "$RUN_STATE" set "$ROOT" "$RUN_ID" gap-analysis done \
    --artifact "$KA_RECEIPT"
```

### 5f. Log iteration (transcription only)

Every value below is read from a receipt — the parent does not compose analytical content.

```bash
cat >> "$LOG_FILE" <<LOG

## Iteration $ITERATION ($(date -u +%Y-%m-%dT%H:%M:%SZ))

- Metric: $CURRENT_METRIC / $TARGET_METRIC $TARGET_UNIT
- Reviewer verdict: $VERDICT (score: $SCORE/10)
- Metric progress: $METRIC_PROGRESS
- Gaps opened: $(jq -r '.gap_ids | join(", ")' "$KA_RECEIPT")
- Gaps closed: $CLOSED_GAPS_THIS_ITER
- Next direction: $(jq -r '.next_round_direction // "continue"' "$REVIEW_FILE")
- Stop reason: ${STOP_REASON:-none (continuing)}
LOG
```

---

## Phase 6: Summary

After the loop exits (metric met, budget exhausted, or convergence), produce the final narrative report with the full metric trajectory.

```bash
# Write NARRATIVE_REPORT.md
cat > "$REPORT_FILE" <<REPORT
# Auto Research Loop — Final Report

## Metric Trajectory

| Iteration | Metric ($TARGET_UNIT) | Target | Delta | Verdict |
|-----------|----------------------|--------|-------|---------|
REPORT

# Append trajectory from log (each iteration's metric)
for i in $(seq 1 $ITERATION); do
    ITER_METRIC=$(jq -r ".iterations[$((i-1))].metric // \"N/A\"" "$STATE_FILE" 2>/dev/null || echo "N/A")
    ITER_VERDICT=$(jq -r ".iterations[$((i-1))].verdict // \"N/A\"" "$STATE_FILE" 2>/dev/null || echo "N/A")
    DELTA=$(echo "$ITER_METRIC - $TARGET_METRIC" | bc -l 2>/dev/null || echo "N/A")
    echo "| $i | $ITER_METRIC | $TARGET_METRIC | $DELTA | $ITER_VERDICT |" >> "$REPORT_FILE"
done

cat >> "$REPORT_FILE" <<REPORT

## Stop Reason

$STOP_REASON

## Iteration Log

$(cat "$LOG_FILE")

## Open Gaps (remaining)

$(grep -A4 'Status.*open' research-wiki/gap_map.md 2>/dev/null || echo "None")

## Closed Gaps

$(grep -A4 'Status.*closed' research-wiki/gap_map.md 2>/dev/null || echo "None")

## Artifacts

- State: $STATE_FILE
- Log: $LOG_FILE
- Wiki: research-wiki/
- Plans: refine-logs/EXPERIMENT_PLAN-iter-*.md
- Reviews: research-iteration/review-iter-*.json
REPORT

node "$RUN_STATE" set "$ROOT" "$RUN_ID" summary done --artifact "$REPORT_FILE"

# Acceptance
if [ -n "$STOP_REASON" ]; then
    REVIEWER_ID="${CODEX_AGENT_ID:-deterministic:research-iteration:max-iter-reached}"
    node "$RUN_STATE" accept "$ROOT" "$RUN_ID" research-iteration \
        --verdict-id "$REVIEWER_ID" \
        --reviewer "$REVIEWER_ID"
fi
```

Optionally render HTML (dispatched as a sub-agent, non-blocking):
```bash
mcp__paseo__create_agent \
    --title "research-loop-render-html" \
    --provider "claude/claude-sonnet-4-6" \
    --initialPrompt "/render-html $REPORT_FILE" \
    --notifyOnFinish false
```
---

## Phase 7: Paper Writing (optional)

If the metric target was met and sufficient evidence exists, optionally dispatch the paper-writing pipeline. Same pattern as research-pipeline Stage 5.

```bash
if [ "$METRIC_MET" = "true" ] && [ "$ITERATION" -ge 2 ]; then
    PROMPT=$(bash "$RENDER" --phase "paper-writing" --run-id "$RUN_ID" --root "$ROOT" \
        --skill skills/paper-writing/SKILL.md \
        --extra "Write paper from iteration results. Narrative report: $REPORT_FILE. Wiki: research-wiki/. Results: refine-logs/EXPERIMENT_RESULTS.md.")

    mcp__paseo__create_agent \
        --title "research-loop-paper-writing" \
        --provider "claude/claude-sonnet-4-6" \
        --initialPrompt "$PROMPT" \
        --notifyOnFinish true
fi
```

This phase is optional and only triggered when:
1. The metric target was actually met (not just budget exhausted)
2. At least 2 iterations completed (sufficient evidence for a paper)
3. The user has not disabled paper writing via `— no-paper` argument

---

## State Management

### run-state.js integration

The skill registers phases with `run-state.js` at startup and updates them as each phase completes. This enables:
- **Resumability:** On resume (`— resume <run_id>`), read the last completed phase and iteration from run-state, then continue from the next step.
- **Visibility:** External tools (paseo UI, CLI) can query progress via `run-state.js status`.
- **Acceptance:** The final `accept` call requires both a `verdict_id` and `reviewer` — the codex agent ID or the deterministic string.

### Resume protocol

```bash
if [ -n "$ARG_RESUME" ]; then
    RUN_ID="$ARG_RESUME"
    # Read last iteration from state file
    ITERATION=$(jq -r '.iteration' "$STATE_FILE")
    LAST_PHASE=$(node "$RUN_STATE" resumePoint "$ROOT" "$RUN_ID")
    echo "Resuming run $RUN_ID from iteration $ITERATION, phase $LAST_PHASE"
    # Jump to the appropriate phase
fi
```

### Stale-state recovery (24h window)

On startup, if `STATE_FILE` exists and its `timestamp` is within 24 hours, resume from `iteration + 1`. If older than 24h, treat as a fresh start (the previous run likely crashed or was abandoned).

```bash
if [ -f "$STATE_FILE" ]; then
    LAST_TS=$(jq -r '.timestamp' "$STATE_FILE")
    AGE_HOURS=$(( ($(date +%s) - $(date -d "$LAST_TS" +%s)) / 3600 ))
    if [ "$AGE_HOURS" -lt 24 ]; then
        ITERATION=$(jq -r '.iteration' "$STATE_FILE")
        echo "Resuming from iteration $((ITERATION + 1)) (state is ${AGE_HOURS}h old)"
    else
        echo "State file is ${AGE_HOURS}h old (>24h). Starting fresh."
        ITERATION=0
    fi
fi
```

---

## Critical Rules

1. **Parent schedules only, never judges.** The parent's permitted actions are exhaustively: dispatch (`create_agent`), wait (`notifyOnFinish`), read a receipt JSON, run canonical helpers with receipt values transcribed verbatim, evaluate Type-A arithmetic, and archive children. If the parent is about to read an experiment log or write an original sentence, it is violating this rule — dispatch instead.

2. **Fresh codex reviewer per iteration (`REVIEWER_BIAS_GUARD=true`).** Every iteration creates a fresh codex sub-agent. Iteration N's review does NOT see iteration N-1's review. A continuation reviewer drifts toward confirming its own prior suggestions; freshness is the only way to get genuinely independent assessment.

3. **Canonical wiki writes only.** Every claim, idea, experiment, and edge goes through `research-wiki.js` subcommands (`add_claim`, `upsert_idea`, `add_experiment`, `add_edge`). No freehand markdown in `research-wiki/`. Exception: `gap_map.md` — there is no `add_gap` subcommand, so gaps are appended by `/kill-argument` in the established format.

4. **No in-process Skill calls.** All sub-skill dispatch via `mcp__paseo__create_agent`. The strict-mode rule (Rule 4 from `paseo-subagent-dispatch.md`) forbids in-process execution. No fallbacks.

5. **File-paths-only receipts.** The parent reads receipt JSONs for file paths and scalar values. It never reads the underlying experiment logs, result files, or review prose. Sub-agents write receipts; the parent transcribes from receipts.

6. **Metric evaluation is deterministic (Type-A).** The parent reads a number from `EXPERIMENT_TRACKER.md`, compares it to the target with tolerance. No interpretation, no "close enough" judgment. The arithmetic either passes or it doesn't.

7. **Codex verdict is never overridden.** If the codex reviewer says `stop` but Type-A hasn't fired, the parent logs the conservative verdict and continues. If Type-A fires but Type-B hasn't, the parent uses the deterministic acceptance path. The parent never overrides or reinterprets the codex verdict.

8. **Gap identification via kill-argument only.** The parent never identifies problems itself. Gaps come from `/kill-argument` dispatch with `— gap-output`. This ensures every gap has a provenance trail (which skill identified it, which iteration, what evidence).

9. **Environment configured once, replayed forever.** The frozen experiment skill at `.claude/skills/run-<project>-experiment/` (if configured) is used by all iterations. The loop never re-derives sync paths, conda hooks, or metric keys. If not configured, a warning is logged and the built-in backend is used.

10. **One long-lived agent, loops internally.** This skill runs as ONE paseo agent. Do NOT wrap in `/loop` / `CronCreate` / `create_heartbeat`. The single agent owns internal cadence per the fence (`shared-references/external-cadence.md`).

11. **Patience enforcement.** If `consecutive_pivot_verdicts >= PATIENCE` (2), force stop to prevent infinite direction-churn. This is Type-A fire-control — no quality judgment.

12. **Self-acquittal tripwire.** `run-state.js accept` with `reviewer` starting with `claude*` emits a stderr warning. Never accept on a Claude reviewer. Require `codex-gpt-5.5` or `deterministic:` for budget-exhausted stops.

13. **Gaps for open questions, claims for evidenced assertions.** Kill-argument's `still_unresolved` entries are unanswered — they are gaps, never claims. Claims arrive from `/result-to-claim` with `--addresses G<n>`.

14. **Archive sub-agents after receipt read.** Every child agent is archived (`mcp__paseo__archive_agent`) once its receipt has been read and processed. No lingering sub-agents.

---

## External Dependencies (reused, not modified)

### Infrastructure tools
- `src/tools/research-wiki.ts` — 12 subcommands: `init`, `slug`, `ingest_paper`, `sync`, `add_claim`, `upsert_idea`, `add_experiment`, `add_edge`, `rebuild_query_pack`, `rebuild_index`, `stats`, `log`
- `src/tools/run-state.ts` — `start`, `set`, `accept`, `status`, `resumePoint`. Accept requires non-empty `verdict_id` and `reviewer`; warns on `claude*` reviewer.
- `src/tools/iteration-log.ts` — `note` (per-iteration log to `.aris/runs/<run_id>.iterations.jsonl`)
- `src/tools/provenance.ts` — `stamp` after every codex round (cross-family integrity check)
- `dist/tools/render_w_agent_prompt.sh` — Prompt construction for sub-agent dispatch

### Dispatched sub-skills
- `skills/idea-discovery/SKILL.md` — Full idea discovery pipeline (iteration 1)
- `skills/idea-creator/SKILL.md` — Gap-targeted idea generation (iteration 2+)
- `skills/experiment-bridge/SKILL.md` — Implements and deploys experiments from plan
- `skills/auto-review-loop/SKILL.md` — Multi-round review with fix cycle
- `skills/kill-argument/SKILL.md` — Adversarial attack, gap output, diagnostic plan
- `skills/result-to-claim/SKILL.md` — Claim judgment per experiment
- `skills/run-experiment/SKILL.md` — Single experiment execution
- `skills/experiment-queue/SKILL.md` — Multi-seed/multi-config batch execution
- `skills/paper-writing/SKILL.md` — End-to-end paper generation (optional Phase 7)
- `skills/render-html/SKILL.md` — HTML rendering (optional)

### Shared references
- `shared-references/paseo-subagent-dispatch.md` — Rule 1 (one agent = one skill), Rule 2 (parent-child push), Rule 3 (file-paths-only), Rule 4 (Paseo MCP only)
- `shared-references/paseo-reviewer-dispatch.md` — Codex sub-agent spawn shape, fresh-thread bias guard
- `shared-references/external-cadence.md` — The fence (no wrapping in `/loop`)
- `shared-references/integration-contract.md` — Helper resolution chain
- `shared-references/review-tracing.md` — `save_trace.sh` (Policy C forensic)
- `shared-references/acceptance-gate.md` — Type-A vs Type-B gate classification
