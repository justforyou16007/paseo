---
name: research-pipeline
description: 'Full end-to-end research pipeline: from a broad research direction through idea discovery, experiments, and review all the way to a polished paper PDF. Use when user says "全流程", "full pipeline", "从找idea到投稿", "end-to-end research", or wants the complete autonomous research lifecycle.'
argument-hint: "[research-direction] [— resume <run_id>]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, WebSearch, WebFetch, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__wait_for_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat
# Fallback only (paseo MCP unavailable): Skill (in-process) + mcp__codex__codex / mcp__codex__codex-reply.
# See "Paseo substrate setup" — the orchestrator probes once and selects the path.
---

# Full Research Pipeline: Idea → Experiments → Submission (paseo orchestrator)

> This skill is now a **thin paseo orchestrator**. It maintains flow state, the
> heartbeat, and creates the next W-agent — it does **not** do the research work
> itself. Each W1–W6 workflow runs as a **paseo claude sub-agent**
> (`paseo-subagent-dispatch.md`); each cross-model reviewer runs as a **paseo
> codex sub-agent** (`paseo-reviewer-dispatch.md`). The old single-session flow
> (synchronous `Skill`-tool calls + `mcp__codex__codex` MCP) is recoverable via
> git history and remains the graceful-degradation fallback when paseo MCP is
> unavailable. Full mapping: [`docs/PASEO_MIGRATION.md`](../../docs/PASEO_MIGRATION.md).
>
> **What did NOT change:** the 11 constants, the acceptance-authority table, the
> gates, the cross-model jury, the 5-layer audit chain, `verify_paper_audits.sh`,
> the fence, resumable runs. Only the dispatch substrate changed.

> ⏱ **External cadence: non-judgmental heartbeat only.** An overnight
> `create_heartbeat` (self-target) may wake, detect a **stalled** phase (no
> progress, dead process, blocked on a freed resource) and **nudge** it forward
> — it may NEVER decide the work is good. Every quality verdict stays on its
> skill's own internal cadence and terminates in the cross-model jury. The
> heartbeat may say "keep going," never "good enough." See
> [`shared-references/external-cadence.md`](../shared-references/external-cadence.md)
> (the fence, restated for the paseo driver, below). At heartbeat startup, touch
> the run state first each tick and register this run with the watchdog `loop`
> type; unregister on completion. The watchdog only detects — it never acquits.
> Each tick also record the new-finding count via `iteration_log.py` (resolve
> through the canonical `.aris/tools → tools → $ARIS_REPO/tools` chain,
> integration-contract §2; warn-and-skip if unresolved):
> `python3 "$ITER_LOG" note <root> <run_id> <phase> <n>`. On `pivot=structural`
> (stale ≥ 2) the nudge must change a STRUCTURAL constraint and pick an untried
> direction; on `pivot=human` (stale ≥ 4) flag for attention. Counting only —
> never a quality verdict.
>
> ⏱ **Notification-driven feedback: the orchestrator does NOT poll.** All
> W-agents use `notifyOnFinish: true` (push model). The orchestrator never calls
> `wait_for_agent` on a notify-enabled child. It reacts to the child's completion
> notification by reading the receipt file and running the gate. If a child is
> unexpectedly idle (no notification within the expected window), the heartbeat
> follows the idle-supervision decision matrix in
> [`paseo-subagent-dispatch.md`](../shared-references/paseo-subagent-dispatch.md)
> — it checks status, never does the child's work.

End-to-end autonomous research workflow for: **$ARGUMENTS**

## Constants

- **AUTO_PROCEED = true** — When `true`, Gate 1 auto-selects the top-ranked idea (highest pilot signal + novelty confirmed) and continues to implementation. When `false`, always waits for explicit user confirmation before proceeding.
- **ARXIV_DOWNLOAD = false** — When `true`, `/research-lit` downloads the top relevant arXiv PDFs during literature survey. When `false` (default), only fetches metadata via arXiv API. Passed through to W1 → `/research-lit`.
- **HUMAN_CHECKPOINT = false** — When `true`, the auto-review loops (Stage 3) pause after each round's review to let you see the score and provide custom modification instructions before fixes are implemented. When `false` (default), loops run fully autonomously. Passed through to W2 (`/auto-review-loop`).
- **REVIEWER_DIFFICULTY = medium** — How adversarial the reviewer is. `medium` (default): standard review. `hard`: adds reviewer memory + debate protocol. `nightmare`: GPT reads repo directly (paseo codex agent in `full-access` mode — the `codex exec` analog) + memory + debate. Passed through to W2.
- **CODE_REVIEW = true** — GPT-5.5 xhigh reviews experiment code before deployment. Catches logic bugs before wasting GPU hours. Set `false` to skip. Passed through to W1.5 (`/experiment-bridge`).
- **BASE_REPO = false** — GitHub repo URL to use as base codebase. When set, W1.5 clones the repo first and implements experiments on top of it. When `false` (default), writes code from scratch or reuses existing project files. Passed through to W1.5.
- **COMPACT = false** — When `true`, generates compact summary files for short-context models and session recovery. Passed through to W1 and W1.5.
- **AUTO_WRITE = false** — When `true`, automatically dispatch W3 (`/paper-writing`) after Stage 4. Requires `VENUE` to be set. When `false` (default), Stage 4 generates `NARRATIVE_REPORT.md` and stops — user invokes `/paper-writing` manually.
- **VENUE = ICLR** — Target venue for paper writing (Stage 5). Only used when `AUTO_WRITE=true`. Options: `ICLR`, `NeurIPS`, `ICML`, `CVPR`, `ACL`, `AAAI`, `ACM`, `IEEE_CONF`, `IEEE_JOURNAL`.
- **RENDER_HTML = true** — When `true` (default), auto-render `NARRATIVE_REPORT.md` to HTML at Stage 4 completion via `/render-html`. Uses `--no-review` (internal handoff doc to W3, not reviewer-facing — Stage 3 already cross-model-reviewed the claims). Set `false` to skip, or pass `— render html: false`. **Non-blocking**: if `/render-html` fails, log and continue.
- **RESUMABLE = true** — When `true` (default), the pipeline records per-stage state to `.aris/runs/<run_id>.json` so a crashed/interrupted run can resume via `/research-pipeline — resume <run_id>` instead of restarting. Stage status splits `done` (executor finished writing) from `accepted` (the stage's cross-model gate / deterministic verifier passed); resume re-validates any `done`-but-unaccepted stage. See `shared-references/resumable-runs.md`.

> 💡 Override via argument, e.g., `/research-pipeline "topic" — AUTO_PROCEED: false, human checkpoint: true, difficulty: nightmare, code review: false, base repo: https://github.com/org/project, auto_write: true, venue: NeurIPS`.

## Overview

The pipeline orchestrates up to four major workflows in sequence, each as a
paseo claude sub-agent:

```
create_agent W1 (idea-discovery) → W1.5 (experiment-bridge) → W2 (auto-review-loop) → W3 (paper-writing, optional)
```

Workflow 3 (paper writing) is optional and controlled by `AUTO_WRITE`. The
orchestrator itself does no research work — it renders each W-agent's
`initialPrompt`, dispatches it, reads the receipt on `notifyOnFinish`, runs the
gate, and calls `run_state.py accept`.

## Paseo substrate setup (do once at start)

1. **Probe the paseo MCP.** Check whether `mcp__paseo__list_agents` (or any
   paseo tool) is available.
   - **Available** → use the paseo dispatch path below.
   - **Unavailable** → log `WARN: paseo MCP unavailable; using in-process
Skill + mcp__codex__codex fallback`. Use today's synchronous `Skill`-tool +
     `mcp__codex__codex` path. The verdict, audit chain, and acceptance gate are
     **identical** on either path — only the dispatch substrate changes
     (`paseo-subagent-dispatch.md` §"Auto-skip"). Skip step 2 (no config.json
     needed for the fallback path).
2. **Resolve the W-agent prompt renderer + emit the run config ONCE**
   (a non-helper skill script, resolved at
   `skills/research-pipeline/scripts/render_w_agent_prompt.sh` — Layer 0,
   `$CLAUDE_SKILL_DIR/scripts/` if set, else the `skills/` tree). Run:
   ```bash
   CONFIG=$(bash "$RENDER" --emit-config --run-id "$RUN_ID" --root "$ROOT")
   ```
   The script reads the CLAUDE.md `## ARIS Paseo` block (optional — defaults if
   absent, per [`templates/CLAUDE_MD_PASEO_SECTION.md`](../../templates/CLAUDE_MD_PASEO_SECTION.md))
   and writes **all 12 paseo variables** to `.aris/runs/<run_id>.paseo-config.json`,
   returning its path on stdout. **Read this JSON once and hold it for the whole
   run** — every `create_agent` / `create_heartbeat` call below takes its
   `provider` / `settings.modeId` / `settings.thinkingOptionId` / `workspace` /
   `notifyOnFinish` / `fanout_subagents` / `heartbeat_cron` from this JSON,
   NOT from re-reading CLAUDE.md prose. This is script-guaranteed
   (integration-contract §2: prose can describe the integration; the script
   guarantees it) — it closes the gap where `reviewer_mode` could otherwise be
   missed and trigger the cross-provider `modeId` throw
   (`paseo-reviewer-dispatch.md` gotcha).
3. **Per stage: render the W-agent initialPrompt** with the same script
   (default mode, not `--emit-config`):
   ```bash
   PROMPT=$(bash "$RENDER" --phase <phase> --run-id "$RUN_ID" --root "$ROOT" \
            --skill skills/<leaf>/SKILL.md --extra "<stage-specific context>")
   ```
   The prompt embeds `executor_provider` / `executor_mode` / `subagent_workspace`
   / `fanout_subagents` from the config (the script re-reads CLAUDE.md, same
   values) and points the child at the workflow SKILL.md as the workflow
   definition. Pass `$PROMPT` as `initialPrompt` to `mcp__paseo__create_agent`.

## Resumable runs (`— resume <run_id>`)

Skip this section if `RESUMABLE = false`.

Resolve `run_state.py` via the canonical chain (integration-contract §2):
`.aris/tools/run_state.py` → `tools/run_state.py` → `$ARIS_REPO/tools/run_state.py`
(warn-and-skip if unresolved — never block the pipeline).

**Phases**, in order: `idea-discovery, experiment-bridge, auto-review-loop, summary, paper-writing`.

- **At start:** if `— resume <run_id>` was passed, run
  `run_state.py resume <root> <run_id>` — it prints the first non-`accepted`
  phase; **begin the pipeline at that stage** (re-dispatch a `running`/`failed`
  stage; **re-audit** a `done`-but-unaccepted stage). Otherwise derive `<run_id>`
  from the direction slug + date and `run_state.py start <root> <run_id> --phases
"idea-discovery,experiment-bridge,auto-review-loop,summary,paper-writing"`.
- **Per stage:** `set <run_id> <phase> running` on entry; `set <run_id> <phase>
done --artifact <path>` once the W-agent's receipt reports the artifact.
- **Re-attach vs recreate on resume:** `mcp__paseo__list_agents` to see whether
  the phase's W-agent (and, for W2/W3, its reviewer) is still alive:
  alive → await its `notifyOnFinish` (do NOT `send_agent_prompt` to a running
  verdict agent — the fence); dead/archived → `create_agent` fresh (the W-agent
  startup reads `REVIEW_STATE.json` / `PAPER_IMPROVEMENT_STATE.json` and resumes
  from saved round+1, recreating the codex reviewer by its persisted agent-id if
  still alive, else a fresh codex agent — reviewer memory may be lost, same risk
  as today's codex-server-restart; trace files survive).
- **Mark `accepted` ONLY after the stage's gate passes** — never on the
  executor's own say-so (`run_state.py accept` requires a recorded verdict id +
  reviewer):

  | phase               | what sets `accepted`                                                                     | record as reviewer                     |
  | ------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------- |
  | `idea-discovery`    | Gate 1 cross-model jury / novelty-check passed (ran inside W1 as codex sub-agents)       | `codex-gpt-5.5` + codex agent-id       |
  | `experiment-bridge` | experiments actually ran (jobs completed) — deterministic                                | `deterministic:experiment-bridge`      |
  | `auto-review-loop`  | the loop hit its positive STOP (`score>=6 AND verdict∈{ready,almost}` — codex's verdict) | `codex-gpt-5.5` + final codex agent-id |
  | `summary`           | `NARRATIVE_REPORT.md` written (+ rendered if `RENDER_HTML`) — deterministic              | `deterministic:summary`                |
  | `paper-writing`     | submission audits passed (`verify_paper_audits.sh` exit 0) — deterministic               | `deterministic:verify_paper_audits.sh` |

  Record each `accept` `verdict_id` as a **durable handle** — the paseo codex
  agent-id (codex-accepted phases) or the path/sha of the deterministic
  verifier's report — not just the reviewer label.

**If `AUTO_WRITE = false`** (default), `paper-writing` is not part of this run:
after `summary` is accepted, `set <run_id> paper-writing skipped` so `resume`
reports COMPLETE instead of pointing forever at a pending stage.

A stage left `done` (gate failed/ambiguous, or the run crashed before the gate)
is re-validated on the next resume — the acceptance obligation is never skipped.

## The fence (restated for the paseo driver)

`external-cadence.md` forbids re-entering a verdict skill from the top on a
timer. For the paseo driver this means concretely:

- **W2 (`auto-review-loop`) = ONE paseo claude agent** that loops rounds 1→N
  internally. Round 2+ continues the SAME codex reviewer agent (W2 holds its
  agent-id / reads it from `REVIEW_STATE.json`). W2 is **created once, never
  recreated** by the heartbeat.
- **W3's `auto-paper-improvement-loop` = ONE paseo claude agent** looping 2
  rounds; each round creates a NEW codex reviewer agent (REVIEWER_BIAS_GUARD =
  fresh). The claude agent is one; the codex agents are per-round.
- **Heartbeat (self-target `create_heartbeat`) is Type-A only**: touch
  `run_state`, `iteration_log.py note`, nudge stalled Type-A sub-phases via
  their sub-agent status. **FORBIDDEN**: creating/re-creating W2/W3/W5/W6,
  `send_agent_prompt` to a running verdict agent (would interrupt it via
  `replaceRunning`), calling `accept`, quality verdicts.

Design rule: fan out **sub-skills** (independent units). For the reviewer:
fresh-context reviews = new codex agent each time; continuation reviews =
`send_agent_prompt` to the same codex agent. **Never** fan out the **loop
iterations** of a verdict-bearing claude skill.

## Overnight heartbeat: stall detection → forced structural pivot

Only when an unattended heartbeat is driving this run (`heartbeat_cron != off`).
Skip otherwise. Doctrine + rationale:
[`shared-references/external-cadence.md`](../shared-references/external-cadence.md)
→ "Stall detection & forced structural pivot". This is a Type-A signal — it counts
findings and changes _direction_, never _judges quality_.

Resolve `iteration_log.py` via the canonical chain (integration-contract §2),
warn-and-skip if unresolved (never block the run):

```bash
ITER_LOG=".aris/tools/iteration_log.py"
[ -f "$ITER_LOG" ] || ITER_LOG="tools/iteration_log.py"
[ -f "$ITER_LOG" ] || ITER_LOG="${ARIS_REPO:-}/tools/iteration_log.py"
[ -f "$ITER_LOG" ] || { echo "WARN: iteration_log.py not resolved; skipping stall detection" >&2; ITER_LOG=""; }
```

Then, **each heartbeat tick**, record how many concrete new findings the current
stage produced and read the returned `pivot`:

```bash
[ -n "$ITER_LOG" ] && python3 "$ITER_LOG" note "$ROOT" "$RUN_ID" "$STAGE" "$N_NEW_FINDINGS"
# → {"stale_count": N, "pivot": "none|structural|human"}
```

Act on `pivot`:

- `none` — keep going.
- `structural` (stale ≥ 2) — the next nudge must change a **structural constraint**
  (frame / objective / data / representation), not a tactical parameter, and pick a
  direction different from every one already tried. Record the chosen frame so future
  ticks can avoid it: `python3 "$ITER_LOG" note "$ROOT" "$RUN_ID" "$STAGE" 0 --direction "<the new frame>"`.
- `human` (stale ≥ 4) — stop nudging blindly; flag for human attention (escalate, do
  not silently abandon).

The heartbeat may say "keep going / change direction," never "good enough" — every
quality verdict still terminates in the cross-model jury (`acceptance-gate.md`).

## The W-agent dispatch (per stage)

For each stage, the orchestrator does the same four-step dispatch per
`paseo-subagent-dispatch.md`. All `create_agent` parameters come from the
run's `.aris/runs/<run_id>.paseo-config.json` (emitted once in "Paseo
substrate setup" step 2) — read it as `$CFG`:

1. **Render the initialPrompt** with `render_w_agent_prompt.sh` (default mode):
   ```bash
   PROMPT=$(bash "$RENDER" --phase <phase> --run-id "$RUN_ID" --root "$ROOT" \
            --skill skills/<leaf>/SKILL.md --extra "<stage-specific context>")
   ```
2. **`set <run_id> <phase> running`**, then **`mcp__paseo__create_agent`** for the
   W-skill, reading every field from `$CFG`:
   - `relationship: {kind: "subagent"}`
   - `workspace: {kind: <CFG.subagent_workspace>}` (`current` shares the project
     dir; `worktree` gives an isolated git worktree)
   - `provider: <CFG.executor_provider>`
   - `settings: {modeId: <CFG.executor_mode>, thinkingOptionId: <CFG.executor_thinking>}`
     (omit `thinkingOptionId` when `CFG.executor_thinking` is null — model default)
   - `initialPrompt: $PROMPT`
   - `notifyOnFinish: <CFG.notify_on_finish>`
3. **Do NOT `wait_for_agent`** (push model). Continue; when the child's
   `notifyOnFinish` lands, read its receipt file (`.aris/runs/<run_id>.<phase>.done.json`)
   — preemption-safe, NOT `<agent-response>` — and `set <run_id> <phase> done
--artifact <receipt.artifact_path>`.
4. **Run the gate** (per the acceptance-authority table). Only on a positive
   verdict call `run_state.py accept <run_id> <phase> --verdict-id <id>
--reviewer <name>`. Then `archive_agent` the W-agent (用完即 archive — fresh-purpose).

**Reviewer sub-agents** (spawned by the W-agents, not the orchestrator) read
the SAME `$CFG` for `reviewer_provider` / `reviewer_mode` / `reviewer_thinking`
— the executor prompt embeds these and points at `paseo-reviewer-dispatch.md`,
so the W-agent fills `provider: <CFG.reviewer_provider>`, `settings:
{modeId: <CFG.reviewer_mode>, thinkingOptionId: <CFG.reviewer_thinking>}`
(omit `thinkingOptionId` when null).

Each W-agent runs its own workflow SKILL.md (the workflow definition, unchanged)
and spawns its own sub-agents + codex reviewer sub-agents per
`paseo-subagent-dispatch.md` / `paseo-reviewer-dispatch.md`.

## Pipeline

### Stage 1: Idea Discovery (Workflow 1)

If `RESEARCH_BRIEF.md` exists in the project root, it will be automatically loaded as detailed context (replaces one-line prompt). See `templates/RESEARCH_BRIEF_TEMPLATE.md`.

Dispatch the W1 idea-discovery agent. The renderer threads in the run context;
the W1 agent internally fans out its sub-skills (`/research-lit` → `/idea-creator`
→ `/novelty-check` → `/research-review` → `/research-refine-pipeline`) as paseo
claude sub-agents, and each cross-model reviewer as a paseo codex sub-agent.

```bash
PROMPT=$(bash "$RENDER" --phase idea-discovery --run-id "$RUN_ID" --root "$ROOT" \
         --skill skills/idea-discovery/SKILL.md \
         --extra "direction: $ARGUMENTS | ARXIV_DOWNLOAD=$ARXIV_DOWNLOAD COMPACT=$COMPACT")
# create_agent W1 (claude) with $PROMPT ; await notifyOnFinish ; read receipt
```

**Output:** `idea-stage/IDEA_REPORT.md` with ranked, validated, pilot-tested ideas.

**🚦 Gate 1 — Human Checkpoint:**

After `idea-stage/IDEA_REPORT.md` is generated, **pause and present the top ideas to the user**:

```
📋 Idea Discovery complete. Top ideas:

1. [Idea 1 title] — Pilot: POSITIVE (+X%), Novelty: CONFIRMED
2. [Idea 2 title] — Pilot: WEAK POSITIVE (+Y%), Novelty: CONFIRMED
3. [Idea 3 title] — Pilot: NEGATIVE, eliminated

Recommended: Idea 1. Shall I proceed with implementation?
```

**If AUTO_PROCEED=false:** Wait for user confirmation before continuing. The user may:

- **Approve the idea** → proceed to Stage 2. W1.5 reads `refine-logs/EXPERIMENT_PLAN.md` already generated by W1.
- **Request changes** (e.g., "combine Idea 1 and 3", "focus more on X") → update the idea prompt with user feedback, re-dispatch W1 with refined constraints, and present again.
- **Reject all ideas** → collect feedback on what's missing, re-dispatch Stage 1 with adjusted research direction. Repeat until the user commits to an idea.
- **Stop here** → save current state to `idea-stage/IDEA_REPORT.md` for future reference.

**If AUTO_PROCEED=true:** Present the top ideas, wait 10 seconds for user input. If no response, auto-select the #1 ranked idea (highest pilot signal + novelty confirmed) and proceed to Stage 2. Log: `"AUTO_PROCEED: selected Idea 1 — [title]"`.

On a positive Gate 1 (novelty-check + research-review passed inside W1 as codex
sub-agents), `run_state.py accept idea-discovery --verdict-id <codex-agent-id>
--reviewer codex-gpt-5.5`, then `archive_agent` W1.

> ⚠️ **This gate waits for user confirmation when AUTO_PROCEED=false.** When `true`, it auto-proceeds after presenting results. The rest of the pipeline (Stages 2-3) is expensive (GPU time + multiple review rounds), so set `AUTO_PROCEED=false` if you want a final review checkpoint before committing GPU resources.

### Stage 2: Experiment Bridge (Workflow 1.5)

Once the user confirms which idea to pursue, dispatch the W1.5 experiment-bridge agent:

```bash
PROMPT=$(bash "$RENDER" --phase experiment-bridge --run-id "$RUN_ID" --root "$ROOT" \
         --skill skills/experiment-bridge/SKILL.md \
         --extra "chosen idea: $CHOSEN_IDEA_TITLE | CODE_REVIEW=$CODE_REVIEW BASE_REPO=$BASE_REPO COMPACT=$COMPACT")
# create_agent W1.5 (claude) ; await notifyOnFinish ; read receipt
```

> 💡 **Queue routing is automatic**: W1.5 Phase 4 routes each milestone by job count — ≤5 jobs → `/run-experiment`, ≥10 jobs or teacher→student phase dependencies → `/experiment-queue` (with OOM retry, wave gating, crash-safe state). No manual override is needed.

**What W1.5 does (fully autonomous):**

1. Parses `refine-logs/EXPERIMENT_PLAN.md` — extracts milestones, run order, compute budget
2. Implements experiment code — extends pilot to full scale, follows existing codebase conventions
3. **Cross-model code review** — GPT-5.5 xhigh reviews the implementation (a paseo codex sub-agent, fresh) for logic bugs, incorrect metrics, and ground-truth misuse before any GPU time is spent
4. **Sanity check** — runs the smallest experiment first; auto-debugs failures (up to 3 attempts, with `/codex:rescue` fallback)
5. Deploys full experiments — auto-routes by job count (≤5 → `/run-experiment`, ≥10 → `/experiment-queue`)
6. Collects initial results — parses outputs, updates `refine-logs/EXPERIMENT_TRACKER.md`, runs `/training-check` if W&B is configured
7. Auto-plans ablations via `/ablation-planner` if main results are positive

**Output:**

- `refine-logs/EXPERIMENT_RESULTS.md` — structured results by milestone
- `refine-logs/EXPERIMENT_TRACKER.md` — updated run-by-run status
- `EXPERIMENT_LOG.md` (when `COMPACT=true`) — session-recovery-friendly log

On jobs-completed (deterministic gate), `run_state.py accept experiment-bridge
--verdict-id <results-path/sha> --reviewer deterministic:experiment-bridge`,
then `archive_agent` W1.5.

### Stage 3: Auto Review Loop (Workflow 2)

Once initial results are in, dispatch the W2 auto-review-loop agent. **W2 is one
long-lived claude agent** that loops rounds 1→N internally; round 1 creates a
fresh codex reviewer agent, round 2+ continues it (`paseo-reviewer-dispatch.md`).

```bash
PROMPT=$(bash "$RENDER" --phase auto-review-loop --run-id "$RUN_ID" --root "$ROOT" \
         --skill skills/auto-review-loop/SKILL.md \
         --extra "chosen idea: $CHOSEN_IDEA_TITLE | REVIEWER_DIFFICULTY=$REVIEWER_DIFFICULTY HUMAN_CHECKPOINT=$HUMAN_CHECKPOINT")
# create_agent W2 (claude) ; await notifyOnFinish ; read receipt
```

**What W2 does (up to 4 rounds):**

1. GPT-5.5 xhigh reviews the work (codex sub-agent; round 1 fresh, r2+ continued)
2. Claude implements fixes (code changes, new experiments, reframing)
3. Deploy fixes, collect new results
4. Re-review → repeat until (score ≥ 6/10 AND verdict ∈ {ready, almost}) or 4 rounds reached

**Output:** `review-stage/AUTO_REVIEW.md` with full review history and final assessment.

On W2's positive STOP (codex verdict), `run_state.py accept auto-review-loop
--verdict-id <codex-agent-id> --reviewer codex-gpt-5.5`, then `archive_agent` W2
(and its codex reviewer).

### Stage 4: Research Summary & Writing Handoff

This stage is **deterministic and runs in the orchestrator** (no W-agent) — it
only writes a summary from existing artifacts, a Type-A execution step
(`acceptance-gate.md`).

**Step 1:** Write a final research status report.

**Step 2:** Generate `NARRATIVE_REPORT.md` from:

- `IDEA_REPORT.md` (chosen idea, hypothesis, novelty justification)
- Implementation details from the repo
- Experiment configs and final results
- `AUTO_REVIEW.md` (review history, weaknesses fixed, remaining limitations)

The narrative report must contain:

- Problem statement and core claim
- Method summary
- Key quantitative results with evidence for each claim
- Figure/table inventory (which exist, which need manual creation)
- Limitations and remaining follow-up items

**Output:** `NARRATIVE_REPORT.md` + research pipeline report.

```markdown
# Research Pipeline Report

**Direction**: $ARGUMENTS
**Chosen Idea**: [title]
**Date**: [start] → [end]
**Pipeline**: idea-discovery → experiment-bridge → auto-review-loop

## Journey Summary

- Ideas generated: X → filtered to Y → piloted Z → chose 1
- Implementation: [brief description of what was built]
- Experiments: [number of GPU experiments, total compute time]
- Review rounds: N/4, final score: X/10

## Writing Handoff

- NARRATIVE_REPORT.md: ✅ generated
- Venue: [VENUE or "not set — run /paper-writing manually"]
- Manual figures needed: [list or "none"]

## Remaining TODOs (if any)

- [items flagged by reviewer that weren't addressed]
```

`set <run_id> summary done --artifact NARRATIVE_REPORT.md`, then
`run_state.py accept summary --verdict-id <narrative-path/sha> --reviewer deterministic:summary`.

### Stage 5: Paper Writing (Workflow 3 — Optional)

**Skip this stage if `AUTO_WRITE=false` (default).** Present the `/paper-writing` command for manual use:

```
📝 Research complete. To write the paper:
/paper-writing "NARRATIVE_REPORT.md" — venue: ICLR
```

Then `set <run_id> paper-writing skipped` so resume reports COMPLETE.

**If `AUTO_WRITE=true`:**

🚦 **Gate 2 — Writing Checkpoint:**

```
📝 Research pipeline complete. Ready for Workflow 3.

- Venue: [VENUE]
- Input: NARRATIVE_REPORT.md
- Manual figures required: [list or none]
- Next step: dispatch W3 paper-writing

Proceeding with paper writing...
```

Checks before proceeding:

- If `VENUE` is missing → stop and ask. Do NOT silently use a default venue.
- If manual figures are required → pause and list them. Wait for user to add them.

Then dispatch the W3 paper-writing agent:

```bash
PROMPT=$(bash "$RENDER" --phase paper-writing --run-id "$RUN_ID" --root "$ROOT" \
         --skill skills/paper-writing/SKILL.md \
         --extra "input: NARRATIVE_REPORT.md | VENUE=$VENUE")
# create_agent W3 (claude) ; await notifyOnFinish ; read receipt
```

W3 handles its own phases (`/paper-plan → /paper-figure → /paper-write →
/paper-compile → /auto-paper-improvement-loop`) as sub-agents, plus the 3
mandatory audits (`/proof-checker`, `/paper-claim-audit`, `/citation-audit`) +
`/kill-argument` each as a claude sub-agent spawning a fresh codex reviewer
sub-agent. When W3 finishes, update the pipeline report with:

- Paper writing completion status
- Final PDF path (`paper/main.pdf`)
- Improvement scores (round 0 → round N)
- Remaining issues

**Output:** `paper/` directory with LaTeX source, compiled PDF, and `PAPER_IMPROVEMENT_LOG.md`.

On `verify_paper_audits.sh paper/ --assurance submission` exit 0 (deterministic
gate), `run_state.py accept paper-writing --verdict-id <audit-report-path/sha>
--reviewer deterministic:verify_paper_audits.sh`, then `archive_agent` W3.

## Render HTML view (auto, when `RENDER_HTML = true`)

After Stage 4 finalizes `NARRATIVE_REPORT.md` (before paper writing branches), invoke `/render-html` on the narrative report:

```
/render-html "NARRATIVE_REPORT.md" --no-review
```

`--no-review` is intentional: this is an internal handoff doc, not reviewer-facing — the claims it summarizes were already cross-model-reviewed in Stage 3's W2. Output: `NARRATIVE_REPORT.html` next to the MD, with embedded source SHA256.

**Non-blocking**: if `/render-html` fails (helper missing, file write error, etc.), log the failure and continue Stage 4 — the HTML view is a convenience artifact, not a pipeline prerequisite.

Skip this step if `RENDER_HTML = false`.

## Output Protocols

> Follow these shared protocols for all output files:
>
> - **[Output Versioning Protocol](../shared-references/output-versioning.md)** — write timestamped file first, then copy to fixed name
> - **[Output Manifest Protocol](../shared-references/output-manifest.md)** — log every output to MANIFEST.md
> - **[Output Language Protocol](../shared-references/output-language.md)** — respect the project's language setting

## Key Rules

- **Large file handling**: If the Write tool fails due to file size, immediately retry using Bash (`cat << 'EOF' > file`) to write in chunks. Do NOT ask the user for permission — just do it silently.

- **The orchestrator never judges quality.** It renders prompts, dispatches W-agents, reads receipts, runs gates, calls `accept`. Every quality verdict is rendered by a codex sub-agent inside a W-agent (Type-B, cross-model) or a deterministic verifier (Type-A). The `run_state.py` self-acquittal tripwire is the backstop.
- **Human checkpoint after Stage 1 is controlled by AUTO_PROCEED.** When `false`, do not proceed without user confirmation. When `true`, auto-select the top idea after presenting results.
- **Stages 2-3 can run autonomously** once the user confirms the idea. This is the "sleep and wake up to results" part.
- **If Stage 3 ends at round 4 without positive assessment**, stop and report remaining issues. Do not loop forever.
- **Budget awareness**: Track total GPU-hours across the pipeline. Flag if approaching user-defined limits.
- **Documentation**: Every stage updates its own output file. The full history should be self-contained.
- **Fail gracefully**: If any stage fails (no good ideas, experiments crash, review loop stuck), report clearly and suggest alternatives rather than forcing forward.
- **用完即 archive**: archive each fresh-purpose W-agent (and its fresh reviewer) after its verdict is read + traced. Continuation reviewers (W2 r2+) stay alive until their loop terminates. The full history stays auditable via `.aris/traces/` + the verdict files.

## Typical Timeline

| Stage                | Duration                                           | Can sleep?               |
| -------------------- | -------------------------------------------------- | ------------------------ |
| 1. Idea Discovery    | 30-60 min                                          | Yes if AUTO_PROCEED=true |
| 2. Experiment Bridge | 30-120 min (implement + review + deploy + collect) | Yes ✅                   |
| 3. Auto Review       | 1-4 hours (depends on experiments)                 | Yes ✅                   |

**Sweet spot**: Run Stage 1 in the evening, launch Stage 2-3 before bed, wake up to a reviewed paper.

## See also

- [`shared-references/paseo-subagent-dispatch.md`](../shared-references/paseo-subagent-dispatch.md) — executor sub-agent dispatch.
- [`shared-references/paseo-reviewer-dispatch.md`](../shared-references/paseo-reviewer-dispatch.md) — codex reviewer dispatch.
- [`shared-references/external-cadence.md`](../shared-references/external-cadence.md) — the fence.
- [`shared-references/resumable-runs.md`](../shared-references/resumable-runs.md) — done/accepted resume.
- [`docs/PASEO_MIGRATION.md`](../../docs/PASEO_MIGRATION.md) — full migration mapping.
