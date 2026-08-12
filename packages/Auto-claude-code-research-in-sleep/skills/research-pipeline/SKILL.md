---
name: research-pipeline
description: 'Full end-to-end research pipeline: from a broad research direction through idea discovery, experiments, and review all the way to a polished paper PDF. Use when user says "全流程", "full pipeline", "从找idea到投稿", "end-to-end research", or wants the complete autonomous research lifecycle.'
argument-hint: "[research-direction] [— resume <run_id>]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, WebSearch, WebFetch, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__wait_for_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat

# See "Paseo substrate setup" — the orchestrator probes once and selects the path.
---

# Full Research Pipeline: Idea → Experiments → Submission (paseo orchestrator)

> **Thin paseo orchestrator.** Maintains flow state, the heartbeat, and creates
> the next W-agent — does not do research work itself. Each W1–W3 workflow runs
> as a paseo claude sub-agent (`paseo-subagent-dispatch.md`); each cross-model
> reviewer runs as a paseo codex sub-agent (`paseo-reviewer-dispatch.md`). The
> old single-session flow is recoverable via git history when paseo MCP is
> unavailable. Full mapping: [`docs/PASEO_MIGRATION.md`](../../docs/PASEO_MIGRATION.md).

> **Worker manifest protocol.** Per Rule 5 and
> [`worker-manifest.md`](../shared-references/worker-manifest.md), each W-agent
> receives an `input-manifest.json` and writes a `receipt.json` with
> `dashboard_patch`. The orchestrator reads only `dashboard.json` and receipt
> scalars — never worker output files.

> **Notification-driven.** All W-agents use `notifyOnFinish: true`. The
> orchestrator never calls `wait_for_agent`. It reacts to the child's completion
> notification by reading the receipt and running the gate. See the idle-supervision
> matrix in `paseo-subagent-dispatch.md` for stall handling.

End-to-end autonomous research workflow for: **$ARGUMENTS**

## Constants

| Constant | Default | Purpose |
|---|---|---|
| AUTO_PROCEED | true | Auto-select top idea at Gate 1 when true; wait for user when false |
| ARXIV_DOWNLOAD | false | Download top arXiv PDFs (true) or metadata only (false). → W1 |
| HUMAN_CHECKPOINT | false | Pause auto-review after each round for user input. → W2 |
| REVIEWER_DIFFICULTY | medium | How adversarial the reviewer is: medium / hard / nightmare. → W2 |
| CODE_REVIEW | true | GPT-5.5 xhigh reviews code before deployment. → W1.5 |
| BASE_REPO | false | GitHub repo URL as base codebase. → W1.5 |
| COMPACT | false | Generate compact summaries for short-context recovery. → W1, W1.5 |
| AUTO_WRITE | false | Auto-dispatch W3 paper-writing after Stage 4. Requires VENUE |
| VENUE | ICLR | Target venue (ICLR/NeurIPS/ICML/CVPR/ACL/AAAI/ACM/IEEE_CONF/IEEE_JOURNAL) |
| RENDER_HTML | true | Auto-render NARRATIVE_REPORT.md to HTML at Stage 4 (non-blocking) |
| RESUMABLE | true | Record per-stage state for `— resume <run_id>` recovery |
| AUTO_RESEARCH_ITERATIONS | 0 | When >0, insert research-iteration stage between W1 and W1.5 |

> Override via argument: `/research-pipeline "topic" — AUTO_PROCEED: false, difficulty: nightmare, auto_write: true, venue: NeurIPS`.

## Dispatch Pattern (all stages follow this)

Each stage follows the same four-step cycle. All `create_agent` parameters come
from `.aris/runs/<run_id>.paseo-config.json` (emitted once at startup, read as `$CFG`).
Full manifest/receipt/dashboard schemas: [`worker-manifest.md`](../shared-references/worker-manifest.md).

Variables used throughout:
```
DASHBOARD=".aris/runs/$RUN_ID/dashboard.json"
WORKERS_DIR=".aris/runs/$RUN_ID/workers"
RENDER=".claude/skills/research-pipeline/scripts/render_w_agent_prompt.sh"
RUN_STATE=".aris/dist/tools/run-state.js"   # resolved via integration-contract.md §2
```

1. **Prepare manifest.** `WORKER_DIR="$WORKERS_DIR/<phase>"`, then
   `mkdir -p "$WORKER_DIR/outputs/"`, write `$WORKER_DIR/input-manifest.json`
   with the stage's inputs (table below) and context scalars.
2. **Render prompt + dispatch.** `node "$RUN_STATE" set "$ROOT" "$RUN_ID" <phase> running`, then:
   ```bash
   PROMPT=$(bash "$RENDER" --phase <phase> --run-id "$RUN_ID" --root "$ROOT" \
            --skill skills/<leaf>/SKILL.md --extra "<stage context> | manifest: $WORKER_DIR/input-manifest.json")
   ```
   `mcp__paseo__create_agent` with `provider: $CFG.executor_provider`,
   `settings: {modeId: $CFG.executor_mode, thinkingOptionId: $CFG.executor_thinking}`,
   `notifyOnFinish: true`. Reviewer sub-agents (spawned by W-agents) use
   `$CFG.reviewer_provider` / `reviewer_mode` / `reviewer_thinking`.
3. **On notifyOnFinish:** read `$WORKER_DIR/receipt.json`. If its path is already
   in `dashboard.applied_receipts`, skip the merge. Otherwise apply the
   dot-aware `dashboard_patch`, append the receipt path, and atomically update
   `current_phase` plus `updated_at`. Save artifact with full path:
   `node "$RUN_STATE" set "$ROOT" "$RUN_ID" <phase> done --artifact "$WORKER_DIR/outputs/<receipt.primary_output>"`.

**Error tracking:** If `receipt.has_errors == true`, update dashboard:
`dashboard.system_errors.total += receipt.error_count` and
`dashboard.system_errors.last = "<phase>"`. Do NOT read
`progress_error.md` (Rule 5).

4. **Run the gate** (per acceptance table below). On pass:
   `node "$RUN_STATE" accept "$ROOT" "$RUN_ID" <phase> --verdict-id <id> --reviewer <reviewer>`,
   then `archive_agent` the W-agent (用完即 archive).

## Startup

```bash
_pr=$(git rev-parse --show-toplevel 2>/dev/null) || { _d=$(pwd); while [ "$_d" != "/" ]; do [ -f "$_d/.aris/installed-skills.txt" ] && { _pr=$_d; break; }; _d=$(dirname "$_d"); done; }
cd "${_pr:-$(pwd)}" || exit 1
ROOT=$(pwd)

# Resolve helpers (integration-contract.md §2 — project-local only)
RUN_STATE=".aris/dist/tools/run-state.js"
[ -f "$RUN_STATE" ] || RUN_STATE="dist/tools/run-state.js"
[ -f "$RUN_STATE" ] || RUN_STATE=""
# Render script lives alongside this skill
RENDER=".claude/skills/research-pipeline/scripts/render_w_agent_prompt.sh"
[ -f "$RENDER" ] || RENDER="skills/research-pipeline/scripts/render_w_agent_prompt.sh"
[ -f "$RENDER" ] || RENDER=""
```

### 1. Probe paseo MCP

If unavailable, mark the current phase `BLOCKED`, report that Paseo MCP is
required, and stop. The host harness `Skill` / `Task` / `Agent` mechanisms
are not an ARIS dispatch substrate and there is no synchronous fallback.

### 2. Determine phases

```bash
# Read AUTO_RESEARCH_ITERATIONS from CLAUDE.md (default 0)
ARI=$(awk '/^## ARIS Paseo/{f=1;next} f&&/^AUTO_RESEARCH_ITERATIONS:/{print $2;exit}' CLAUDE.md 2>/dev/null)
ARI=${ARI:-0}
if [ "$ARI" -gt 0 ] 2>/dev/null; then
    PHASES="idea-discovery,research-iteration,experiment-bridge,auto-review-loop,summary,paper-writing"
else
    PHASES="idea-discovery,experiment-bridge,auto-review-loop,summary,paper-writing"
fi
```

### 3. Fresh start vs Resume

```bash
if [ -n "$ARG_RESUME" ]; then
    # ---- RESUME PATH ----
    # Do NOT create/overwrite any files. Rehydrate from existing state.
    RUN_ID="$ARG_RESUME"
    DASHBOARD=".aris/runs/$RUN_ID/dashboard.json"
    WORKERS_DIR=".aris/runs/$RUN_ID/workers"

    if [ ! -f "$DASHBOARD" ]; then
        echo "ERROR: No dashboard at $DASHBOARD. Cannot resume."
        exit 1
    fi

    # Read run config (written at original startup)
    CFG=".aris/runs/${RUN_ID}.paseo-config.json"
    if [ ! -f "$CFG" ]; then
        echo "ERROR: No paseo config at $CFG. Cannot resume."
        exit 1
    fi

    ARI=$(jq -r '.config.auto_research_iterations // 0' "$DASHBOARD")
    AUTO_WRITE=$(jq -r '.config.auto_write // false' "$DASHBOARD")
    VENUE=$(jq -r '.config.venue // "ICLR"' "$DASHBOARD")
    RENDER_HTML=$(jq -r '.config.render_html // true' "$DASHBOARD")

    # Use run-state to find the resume point
    RESUME_PHASE=$(node "$RUN_STATE" resume "$ROOT" "$RUN_ID")
    if [ "$RESUME_PHASE" = "COMPLETE" ]; then
        jq '.status = "completed" | .updated_at = (now | todateiso8601)' \
            "$DASHBOARD" > "$DASHBOARD.tmp" && mv "$DASHBOARD.tmp" "$DASHBOARD"
        echo "Run $RUN_ID: all phases accepted/skipped. Nothing to resume."
        exit 0
    fi
    echo "Resuming run $RUN_ID at phase: $RESUME_PHASE"

    # Re-attach live agents (list_agents); recreate dead ones.
    # Jump to the phase returned by run-state resume.

else
    # ---- FRESH START PATH ----
    RUN_ID=$(date +%Y%m%d-%H%M%S)-research-pipeline
    DASHBOARD=".aris/runs/$RUN_ID/dashboard.json"
    WORKERS_DIR=".aris/runs/$RUN_ID/workers"
    mkdir -p "$WORKERS_DIR"
    AUTO_WRITE=${AUTO_WRITE:-false}
    VENUE=${VENUE:-ICLR}
    RENDER_HTML=${RENDER_HTML:-true}

    # Emit paseo run config (must happen after RUN_ID is assigned)
    CFG=$(bash "$RENDER" --emit-config --run-id "$RUN_ID" --root "$ROOT")

    # Initialize run-state
    node "$RUN_STATE" start "$ROOT" "$RUN_ID" --phases "$PHASES"

    # Initialize dashboard.json per worker-manifest.md schema
    cat > "$DASHBOARD" <<DASH
{
  "run_id": "$RUN_ID",
  "project": "$(basename "$ROOT")",
  "status": "running",
  "iteration": 1,
  "max_iterations": 1,
  "current_phase": "idea-discovery",
  "config": {
    "auto_research_iterations": $ARI,
    "auto_write": $AUTO_WRITE,
    "venue": "$VENUE",
    "render_html": $RENDER_HTML
  },
  "metric": { "name": null, "target": null, "direction": "higher_better",
              "tolerance": 0.01, "current": null, "baseline": null, "history": [] },
  "best_idea": null,
  "gaps": { "open": [], "closed": [], "total": 0 },
  "last_review": { "verdict": null, "score": null, "iteration": null },
  "stop_reason": null,
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "system_errors": { "total": 0, "last": null },
  "applied_receipts": []
}
DASH

    RESUME_PHASE="idea-discovery"
fi
# From here: $RUN_ID, $DASHBOARD, $WORKERS_DIR, $CFG, $RESUME_PHASE are set.
# Start executing from $RESUME_PHASE.
```

## Pipeline

### Stage 1: Idea Discovery (W1)

If `RESEARCH_BRIEF.md` exists, it is loaded as detailed context (replaces one-line prompt).

| Manifest inputs | |
|---|---|
| `research_brief` | `RESEARCH_BRIEF.md` |
| `claude_md` | `CLAUDE.md` |
| `dashboard` | `$DASHBOARD` |

| Context | |
|---|---|
| `direction` | `$ARGUMENTS` |
| `arxiv_download`, `compact` | from constants |
| `reference_skills/docs/knowledge` | from CLAUDE.md `## Reference Knowledge` |

Dispatch → `skills/idea-discovery/SKILL.md`. W1 internally fans out `/research-lit`
→ `/idea-creator` → `/novelty-check` → `/research-review` → `/research-refine-pipeline`
as paseo claude sub-agents with codex reviewers.

**Output:** `IDEA_REPORT.md` in `$WORKERS_DIR/idea-discovery/outputs/`.

**Gate 1 — Idea checkpoint.** Present top ideas to user.
- **AUTO_PROCEED=false:** wait for user to approve / request changes / reject / stop.
- **AUTO_PROCEED=true:** present results, wait 10s, auto-select #1 ranked idea.

On positive gate (novelty-check + research-review passed inside W1 as codex sub-agents):
`accept idea-discovery --verdict-id <codex-agent-id> --reviewer codex-gpt-5.5`.

### Stage 1.7: Auto Research Loop (optional)

**Skip if AUTO_RESEARCH_ITERATIONS = 0** (default).

When >0, dispatch `/auto-research-loop` as a single long-lived W-agent that loops
iterations 1→N internally with a fresh codex reviewer per round (baseline reproduction
→ problem diagnosis → hypothesis → experiment → review).

**Compound gate:** (Type-A: `current_metric >= target * 0.99` OR `iteration >= MAX`)
AND (Type-B: codex verdict=stop with `score>=9` AND `metric_progress=met target`).
Requires `## Metric Target` block in CLAUDE.md with `primary: <number> <unit>`.

### Stage 2: Experiment Bridge (W1.5)

| Manifest inputs | |
|---|---|
| `idea_report` | `$WORKERS_DIR/idea-discovery/outputs/IDEA_REPORT.md` |
| `experiment_plan` | `$WORKERS_DIR/idea-discovery/outputs/EXPERIMENT_PLAN.md` |
| `dashboard` | `$DASHBOARD` |

| Context | |
|---|---|
| `chosen_idea` | `$CHOSEN_IDEA_TITLE` |
| `code_review`, `base_repo`, `compact` | from constants |

Dispatch → `skills/experiment-bridge/SKILL.md`. Queue routing is automatic:
≤5 jobs → `/run-experiment`, ≥10 → `/experiment-queue`.

**What W1.5 does:** parse experiment plan → implement code → cross-model code review
(codex sub-agent) → sanity check (smallest experiment, up to 3 auto-debug attempts)
→ deploy full experiments → collect results → auto-plan ablations if positive.

**Output:** `EXPERIMENT_RESULTS.md`, `EXPERIMENT_TRACKER.md` in `$WORKERS_DIR/experiment-bridge/outputs/`.
`EXPERIMENT_LOG.md` (when COMPACT=true).

**Gate:** jobs completed (deterministic). Accept with `--reviewer deterministic:experiment-bridge`.

### Stage 3: Auto Review Loop (W2)

| Manifest inputs | |
|---|---|
| `experiment_results` | `$WORKERS_DIR/experiment-bridge/outputs/EXPERIMENT_RESULTS.md` |
| `idea_report` | `$WORKERS_DIR/idea-discovery/outputs/IDEA_REPORT.md` |
| `dashboard` | `$DASHBOARD` |

| Context | |
|---|---|
| `chosen_idea` | `$CHOSEN_IDEA_TITLE` |
| `reviewer_difficulty`, `human_checkpoint` | from constants |

Dispatch → `skills/auto-review-loop/SKILL.md`. **W2 is one long-lived claude agent**
looping rounds 1→N internally; round 1 creates a fresh codex reviewer, round 2+
continues it. Created once, never recreated by the heartbeat.

**What W2 does (up to 4 rounds):** GPT-5.5 xhigh review → implement fixes →
deploy fixes → re-review → repeat until (score ≥ 6 AND verdict ∈ {ready, almost})
or 4 rounds reached. If round 4 without positive assessment, stop and report.

**Output:** `AUTO_REVIEW.md` in `$WORKERS_DIR/auto-review-loop/outputs/`.

**Gate:** codex positive STOP. Accept with `--verdict-id <codex-agent-id> --reviewer codex-gpt-5.5`.

### Stage 4: Research Summary (delegated)

| Manifest inputs | |
|---|---|
| `idea_report` | `$WORKERS_DIR/idea-discovery/outputs/IDEA_REPORT.md` |
| `experiment_results` | `$WORKERS_DIR/experiment-bridge/outputs/EXPERIMENT_RESULTS.md` |
| `auto_review` | `$WORKERS_DIR/auto-review-loop/outputs/AUTO_REVIEW.md` |
| `claude_md` | `CLAUDE.md` |
| `dashboard` | `$DASHBOARD` |

Dispatch a summary sub-agent to generate `NARRATIVE_REPORT.md` with required
sections (Research Direction, Method Summary, Key Quantitative Results,
Figure/Table Inventory, Limitations & Next Steps). The sub-agent writes all
output to `$WORKERS_DIR/summary/outputs/`.

**Output:** `NARRATIVE_REPORT.md` in `$WORKERS_DIR/summary/outputs/`.

If `RENDER_HTML=true`: after summary receipt, dispatch `/render-html` to render
`NARRATIVE_REPORT.md` to HTML (non-blocking — log and continue on failure).

**Gate:** NARRATIVE_REPORT.md written (deterministic). Accept with `--reviewer deterministic:summary`.

### Stage 5: Paper Writing (W3 — optional)

**Skip if AUTO_WRITE=false** (default). Present `/paper-writing` command for
manual use, then `node "$RUN_STATE" set "$ROOT" "$RUN_ID" paper-writing skipped`.

**If AUTO_WRITE=true:** check VENUE is set (stop and ask if missing), check for
manual figures (pause and list if needed), then dispatch → `skills/paper-writing/SKILL.md`.

W3 handles `/paper-plan → /paper-figure → /paper-write → /paper-compile →
/auto-paper-improvement-loop` as sub-agents, plus 3 mandatory audits
(`/proof-checker`, `/paper-claim-audit`, `/citation-audit`) + `/kill-argument`.

**Output:** `paper/` directory in `$WORKERS_DIR/paper-writing/outputs/`.

**Gate:** `verify_paper_audits.sh "$WORKERS_DIR/paper-writing/outputs/paper/" --assurance submission` exit 0 (deterministic).
Accept with `--reviewer deterministic:verify_paper_audits.sh`.

After `paper-writing` is accepted, atomically set dashboard `status` to
`completed`, `current_phase` to `paper-writing`, and refresh `updated_at`.

## Acceptance Authority Table

| Phase | What sets `accepted` | Reviewer |
|---|---|---|
| `idea-discovery` | Gate 1 cross-model jury / novelty-check (codex sub-agents inside W1) | `codex-gpt-5.5` + codex agent-id |
| `research-iteration` | Compound gate (metric within 1% of target OR max iterations) AND (codex verdict=stop, score≥9) | `codex-gpt-5.5` + codex agent-id (or `deterministic:research-iteration:max-iter-reached`) |
| `experiment-bridge` | Jobs completed — deterministic | `deterministic:experiment-bridge` |
| `auto-review-loop` | Codex positive STOP (score≥6 AND verdict∈{ready,almost}) | `codex-gpt-5.5` + codex agent-id |
| `summary` | NARRATIVE_REPORT.md written (+ HTML if RENDER_HTML) | `deterministic:summary` |
| `paper-writing` | `verify_paper_audits.sh` exit 0 | `deterministic:verify_paper_audits.sh` |

Record each `accept` verdict_id as a durable handle (paseo codex agent-id or
path/sha of deterministic verifier). Mark `accepted` only after the stage's gate
passes — never on the executor's own say-so.

## Resume

Resolve `run-state.js` via canonical chain: `.aris/dist/tools/run-state.js` →
`dist/tools/run-state.js` (warn-and-skip if unresolved).

- **At start:** `node "$RUN_STATE" resume "$ROOT" "$RUN_ID"` prints the first
  non-accepted phase; begin at that stage.
- **Per stage:** `node "$RUN_STATE" set "$ROOT" "$RUN_ID" <phase> running` on entry;
  `node "$RUN_STATE" set "$ROOT" "$RUN_ID" <phase> done --artifact <path>` on receipt.
- **Re-attach vs recreate:** `list_agents` to check if the phase's W-agent is alive.
  Alive → await its notifyOnFinish (do NOT send_agent_prompt to a running verdict
  agent — the fence). Dead/archived → create_agent fresh (W-agent reads persisted
  state and resumes from saved round+1).
- **Done-but-unaccepted:** a stage left `done` (gate failed or run crashed before gate)
  is re-validated on resume — the acceptance obligation is never skipped.
- **AUTO_WRITE=false:** after summary is accepted,
  `node "$RUN_STATE" set "$ROOT" "$RUN_ID" paper-writing skipped`, then atomically
  set dashboard `status=completed`, so resume and dashboard agree.

## The Fence (paseo driver)

`external-cadence.md` forbids re-entering a verdict skill from the top on a timer.

- **W2 = ONE claude agent** looping rounds 1→N. Round 2+ continues the SAME codex
  reviewer (agent-id from `REVIEW_STATE.json`). Created once, never recreated.
- **W3's improvement loop = ONE claude agent** looping 2 rounds; each round creates
  a NEW codex reviewer (REVIEWER_BIAS_GUARD = fresh).
- **Heartbeat = Type-A only:** touch run_state, iteration-log note, nudge stalled
  sub-phases. FORBIDDEN: creating/recreating W2/W3, send_agent_prompt to a running
  verdict agent, calling accept, quality verdicts.

## Heartbeat: Stall Detection

Only when `heartbeat_cron != off`. Doctrine:
[`external-cadence.md`](../shared-references/external-cadence.md) → "Stall detection".

Resolve `iteration-log.js` via canonical chain (warn-and-skip if unresolved).
Each tick: `node "$ITER_LOG" note "$ROOT" "$RUN_ID" "$STAGE" "$N_NEW_FINDINGS"` →
returns `{stale_count, pivot}`.

| pivot | stale | Action |
|---|---|---|
| `none` | <2 | Keep going |
| `structural` | ≥2 | Change a structural constraint (frame/objective/data), pick untried direction |
| `human` | ≥4 | Flag for human attention, stop nudging blindly |

The heartbeat may say "keep going / change direction," never "good enough."

## Critical Rules

- **Orchestrator context discipline (Rule 5).** Read only `dashboard.json` and
  receipt scalars. Never read worker output files. All composition is delegated.
- **The orchestrator never judges quality.** It dispatches, reads receipts, runs
  gates, calls accept. Every quality verdict comes from codex (Type-B) or a
  deterministic verifier (Type-A).
- **Human checkpoint after Stage 1** is controlled by AUTO_PROCEED.
- **Stages 2-3 run autonomously** once the idea is confirmed — "sleep and wake
  up to results."
- **Stage 3 max 4 rounds.** If no positive assessment at round 4, stop and report.
- **Budget awareness.** Track total GPU-hours; flag approaching limits.
- **Fail gracefully.** Report clearly and suggest alternatives rather than forcing forward.
- **用完即 archive.** Archive each fresh-purpose W-agent after verdict is read + traced.
  Continuation reviewers (W2 r2+) stay alive until their loop terminates.
- **Large file handling.** If Write tool fails due to size, retry via Bash
  (`cat << 'EOF' > file`). Do not ask — just do it.

## Output Protocols

Follow [`output-versioning.md`](../shared-references/output-versioning.md),
[`output-manifest.md`](../shared-references/output-manifest.md), and
[`output-language.md`](../shared-references/output-language.md).

## Typical Timeline

| Stage | Duration | Can sleep? |
|---|---|---|
| 1. Idea Discovery | 30-60 min | Yes if AUTO_PROCEED=true |
| 2. Experiment Bridge | 30-120 min | Yes |
| 3. Auto Review | 1-4 hours | Yes |

Sweet spot: run Stage 1 in the evening, launch Stages 2-3 before bed, wake up to results.

## See Also

- [`paseo-subagent-dispatch.md`](../shared-references/paseo-subagent-dispatch.md) — executor dispatch
- [`paseo-reviewer-dispatch.md`](../shared-references/paseo-reviewer-dispatch.md) — codex reviewer dispatch
- [`external-cadence.md`](../shared-references/external-cadence.md) — the fence
- [`resumable-runs.md`](../shared-references/resumable-runs.md) — done/accepted resume
- [`docs/PASEO_MIGRATION.md`](../../docs/PASEO_MIGRATION.md) — full migration mapping
