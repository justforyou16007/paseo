# ARIS → Paseo Multi-Agent Migration

This document maps the ARIS research pipeline from its **single Claude
session + codex MCP** architecture to a **unified paseo parent-child agent**
architecture. It is the reference for what changed, what stayed identical,
and why.

> **Design choice (decisive).** The migration **replaces** the codex-MCP +
> paseo-MCP fusion with paseo parent-child agent logic throughout. The
> cross-model reviewer (GPT-5.5) itself becomes a paseo codex sub-agent,
> not an `mcp__codex__codex` call. See "Option A vs Option B" below.

## TL;DR

|                                                                        | Before                                                     | After                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Workflow chaining                                                      | synchronous `Skill`-tool calls in one Claude session       | paseo claude agents; `create_agent` once, `send_agent_prompt` to continue     |
| Cross-model reviewer                                                   | `mcp__codex__codex` (fresh) / `codex-reply` (continuation) | paseo codex agent; `create_agent` = fresh, `send_agent_prompt` = continuation |
| Verdict / audit / gate                                                 | unchanged                                                  | unchanged                                                                     |
| Helpers (`run_state.py`, `save_trace.sh`, `verify_paper_audits.sh`, …) | —                                                          | **unchanged**                                                                 |
| `third_parties/paseo/`                                                 | —                                                          | **untouched**                                                                 |

The migration changes **only the flow-control substrate**. Every research
contract — the cross-model jury, the acceptance gate, reviewer
independence, the 5-layer audit chain, the fence, resumable runs — is
preserved verbatim.

## Why migrate

ARIS today runs the entire research lifecycle inside one Claude session.
That session:

1. **Holds the whole workflow in one context window** — long pipelines
   (idea → experiment → review → paper) press the context ceiling.
2. **Has no survival across a session crash** — a compacted / closed /
   timed-out session loses in-flight state (mitigated, not solved, by
   `run_state.py` resume).
3. **Fuses two substrates** — the Claude executor and the codex MCP
   reviewer are different mechanisms with different liveness, different
   tracing, different failure modes.

Paseo parent-child agents give each workflow unit its own context, a
durable agent boundary that survives the parent, and a single substrate
for both executor and reviewer. The user's explicit goal: **replace the
fusion with paseo parent-child logic throughout** — not keep codex MCP for
the reviewer alongside paseo MCP for dispatch.

## Session-continuity model (the core of the migration)

Two **independent** continuation layers, both now paseo-managed:

| Layer                                  | Before                                                             | After                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Claude executor (W-agents, sub-agents) | one Claude session, `Skill`-tool calls                             | paseo claude agents; `create_agent` once, `send_agent_prompt` to continue                          |
| codex reviewer (GPT-5.5)               | `mcp__codex__codex` (fresh thread) / `codex-reply` (same threadId) | paseo codex agent; `create_agent` = fresh thread, `send_agent_prompt` to same agent = continuation |

The mapping is exact because a paseo codex agent holds `currentThreadId`
internally: the first prompt opens a fresh thread (`thread/start`); later
prompts to the same agent reuse that thread. So `create_agent` ≡ a fresh
`mcp__codex__codex`, and `send_agent_prompt` to the same agent ≡
`codex-reply`. The two continuity layers are independent: the claude
executor agent and the codex reviewer agent each have their own
continuation handle, each can be alive or dead independently on resume.

## The two continuity modes

Every reviewer call is one of two kinds. The kind is fixed by the calling
skill's doctrine, not chosen by the parent:

| Today                                                      | After migration                                 | Used by                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp__codex__codex` (fresh thread every round)             | **`create_agent` a NEW codex agent**            | `auto-paper-improvement-loop` (REVIEWER_BIAS_GUARD — round 1 AND round 2 fresh); every audit layer (`proof-checker`, `paper-claim-audit`, `citation-audit`, `kill-argument`); `novelty-check`; `research-review` round 1; `experiment-bridge` Phase 2.5 code review; `idea-creator` Phase 4 first pass |
| `mcp__codex__codex-reply` (same threadId, reviewer memory) | **`send_agent_prompt` to the SAME codex agent** | `auto-review-loop` round 2+ (reviewer checks resolution against its OWN prior critique + Debate ruling); `research-review` follow-ups; `rebuttal` stress-test follow-ups; `idea-creator` devil's-advocate triage                                                                                       |

For **executor** sub-agents, the default is fresh (each sub-skill is a new
child). Continuation is the exception, reserved for the reviewer cases above.

Full detail: [`skills/shared-references/paseo-reviewer-dispatch.md`](../skills/shared-references/paseo-reviewer-dispatch.md).

## The fence (restated for the paseo driver)

`external-cadence.md` forbids re-entering a verdict-bearing skill from the
top on a wall-clock timer. In paseo terms:

- **`auto-review-loop` (W2) = ONE paseo claude agent** that loops rounds 1→N
  internally. Round 2+ continues the SAME codex reviewer agent (the W2
  agent holds its agent-id / reads it from `REVIEW_STATE.json`). The W2
  agent is **created once, never recreated** by the heartbeat.
- **`auto-paper-improvement-loop` = ONE paseo claude agent** looping 2
  rounds; each round creates a NEW codex reviewer agent (bias guard =
  fresh). The claude agent is one; the codex agents are per-round.
- **Heartbeat (orchestrator self-target via `create_heartbeat`) is Type-A
  only**: touch `run_state`, `iteration_log.py note`, nudge stalled Type-A
  sub-phases. **FORBIDDEN**: creating/re-creating W2/W3/W5/W6,
  `send_agent_prompt` to a running verdict agent (would interrupt it via
  `replaceRunning`), calling `accept`, quality verdicts.

Design rule (positive form): fan out **sub-skills** (independent units).
For the reviewer: fresh-context reviews = new codex agent each time;
continuation reviews = `send_agent_prompt` to the same codex agent. **Never**
fan out the **loop iterations** of a verdict-bearing claude skill — keep
them in one long-lived claude agent.

## State-schema adaptations (values change, helpers do NOT)

The helpers (`run_state.py`, `save_trace.sh`, `verify_paper_audits.sh`,
`iteration_log.py`, …) are **not modified**. The **values** stored in
state files change — and only because a handle that used to be a codex-MCP
thread id is now a paseo codex agent-id (both opaque strings to the helpers):

| File / field                                | Before                                          | After                                                                                           |
| ------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `REVIEW_STATE.json` `threadId`              | codex MCP thread id                             | paseo codex agent-id (continuation: r2+ `send_agent_prompt` targets this)                       |
| `PAPER_IMPROVEMENT_STATE.json` `threadId`   | codex MCP thread id                             | paseo codex agent-id (per-round, bookkeeping only — NOT reused; REVIEWER_BIAS_GUARD)            |
| `run_state.py accept --verdict-id`          | codex thread / trace id                         | paseo codex agent-id (codex-accepted phases) or verifier-report path/sha (deterministic phases) |
| audit JSON `thread_id` / `trace_path`       | codex thread id                                 | paseo codex agent-id / trace dir                                                                |
| `save_trace.sh --thread-id`                 | codex thread id                                 | paseo codex agent-id                                                                            |
| `save_trace.sh` trace `request.json` `tool` | `mcp__codex__codex` / `mcp__codex__codex-reply` | `paseo:create_agent` / `paseo:send_agent_prompt`                                                |

`verify_paper_audits.sh` validates `trace_path` / `thread_id` as non-empty
strings — unchanged. Field names are unchanged (zero helper churn). The
migration is byte-for-byte compatible with on-disk state from the old
architecture: an old `REVIEW_STATE.json` with a codex-MCP thread id is
simply a dead handle after migration (the codex MCP thread is gone); a
fresh resume recreates the reviewer.

## Mechanism → paseo equivalent

| Mechanism (before)                                       | Paseo equivalent (after)                                                                                                                                          | What stays unchanged                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `/research-pipeline` orchestration in one Claude session | orchestrator = the user's session; thin paseo driver: `run_state.py` resume/start, `create_heartbeat`, per-stage `create_agent` W-skill, notify → gate → `accept` | the 11 constants; the acceptance-authority table; gates 1 & 2          |
| `Skill`-tool call to a sub-skill                         | `create_agent` a claude sub-agent per `paseo-subagent-dispatch.md`                                                                                                | sub-skill's SKILL.md (workflow definition); output protocol; artifacts |
| `mcp__codex__codex` (fresh reviewer)                     | `create_agent` a codex sub-agent per `paseo-reviewer-dispatch.md`                                                                                                 | reviewer-independence; `save_trace.sh`; verdict schema; 6-state        |
| `mcp__codex__codex-reply` (continuation)                 | `send_agent_prompt` to the same codex agent                                                                                                                       | reviewer memory semantics; Debate ruling                               |
| `codex exec` CLI (nightmare mode)                        | paseo codex agent in `full-access` mode                                                                                                                           | autonomous repo read; network on                                       |
| overnight `/loop` / `CronCreate` heartbeat               | `create_heartbeat` (self-target) Type-A only                                                                                                                      | the fence; stall→pivot ladder; `iteration_log.py`                      |
| `run_state.py` resume                                    | orchestrator `run_state.py resume` + `list_agents` (re-attach live child / recreate dead)                                                                         | done/accepted machine; self-acquittal tripwire                         |
| `Agent`-tool fan-out (Tier 2)                            | paseo parallel `create_agent` N children                                                                                                                          | fan-out-pattern; jury stays single + cross-model                       |
| `REVIEWER_DIFFICULTY` / `— reviewer: codex`              | selects paseo codex agent (default)                                                                                                                               | the directive; pass-through                                            |
| `— reviewer: oracle-pro` / `agy` / `manual`              | still MCP (alternate backends / human)                                                                                                                            | reviewer-routing; not every backend is an agent                        |

## Target architecture (3-level agent tree)

```
User session invokes /research-pipeline "topic"   ← this session IS the orchestrator (provider: claude; default child mode: bypassPermissions)
│
├── run_state.py resume|start  ;  reads CLAUDE.md ## ARIS Paseo
├── create_heartbeat (self-target, cron=heartbeat_cron)   ← overnight Type-A nudge only
│
├── create_agent W1 (claude) idea-discovery   ── notifyOnFinish ──► accept idea-discovery (Gate 1)
│     ├── W1 spawns claude sub-agents: research-lit, idea-creator, novelty-check, research-review, research-refine-pipeline
│     └── each, when it needs GPT-5.5, spawns a codex sub-agent (codex/gpt-5.5, full-access, xhigh)
├── create_agent W1.5 (claude) experiment-bridge ── notifyOnFinish ──► accept experiment-bridge (deterministic)
│     ├── W1.5 spawns: run-experiment|experiment-queue, monitor-experiment, training-check, ablation-planner, codex:rescue
│     └── Phase 2.5 code review → spawns a codex sub-agent (fresh)
├── create_agent W2 (claude) auto-review-loop  ── notifyOnFinish ──► accept auto-review-loop (codex STOP verdict)
│     ├── W2 loops rounds 1→N internally (NOT split per round, NOT recreated)
│     ├── Round 1: W2 creates a codex reviewer agent (fresh) → persists agent-id to REVIEW_STATE.json
│     ├── Round 2+: W2 send_agent_prompt to the SAME codex agent (continuation) + Debate ruling
│     └── per-round sub-agents: training-check, render-html, result-to-claim (terminal, writes CLAIMS_FROM_RESULTS.md)
├── Stage 4 summary (deterministic, in-orchestrator) ──► accept summary
└── if AUTO_WRITE: create_agent W3 (claude) paper-writing ──► accept paper-writing (verify_paper_audits.sh exit 0)
      ├── W3 spawns: paper-plan, paper-figure(+figure-spec|paper-illustration|mermaid|paper-illustration-image2),
      │             paper-write, paper-compile, auto-paper-improvement-loop (loops internally, 2 rounds, each a FRESH codex agent),
      │             proof-checker, paper-claim-audit, citation-audit, kill-argument, render-html
      └── each audit = a claude sub-agent that runs its detector (regex/hash/JSON) and spawns a codex reviewer sub-agent (fresh) for the verdict
```

W4/W5/W6 (rebuttal / resubmit-pipeline / paper-talk) created on demand,
same pattern.

**Every** agent uses `workspace:{kind:"current"}` (shared project dir → all
artifacts + `.aris/runs/` + `.aris/traces/` land together) and
`relationship:{kind:"subagent"}` (cascade-archive). Claude executor agents
default to `modeId:"bypassPermissions"`; codex reviewer agents default to
`modeId:"full-access"`. `notifyOnFinish:true` (default); the parent does NOT
`wait_for_agent` on notify agents.

## Resume model

On `/research-pipeline — resume <run_id>`:

1. `run_state.py resume <run_id>` → first non-terminal phase (a `done`-but-
   unaccepted phase is re-validated, never skipped — `resumable-runs.md`).
2. `list_agents` — is that phase's W-agent (or its reviewer) still alive?
   - **Alive** → re-attach: await its `notifyOnFinish` (do NOT re-prompt a
     running verdict agent — the fence).
   - **Dead / archived** → `create_agent` fresh. The W-agent's startup
     reads `REVIEW_STATE.json` / `PAPER_IMPROVEMENT_STATE.json` and resumes
     from saved round+1, recreating the codex reviewer by reading its
     persisted agent-id if still alive (continuation preserved), else a
     fresh codex agent (reviewer memory may be lost — same risk as today's
     codex-server-restart; trace files survive, the live thread may not).
3. The orchestrator never judges quality — reads on-disk artifacts, runs
   the gate, calls `run_state.py accept`. The `run_state.py` self-acquittal
   tripwire (warns on a `claude*` reviewer) is the backstop.

## Option A vs Option B (why unified-paseo)

Two designs were considered:

|                          | Option A: MCP fusion                      | Option B: unified paseo (CHOSEN)         |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| Executor dispatch        | paseo claude agents                       | paseo claude agents                      |
| Cross-model reviewer     | `mcp__codex__codex` MCP (kept)            | paseo codex agent                        |
| Substrates               | two (paseo + codex MCP)                   | one (paseo)                              |
| Continuity handles       | agent-id (executor) + threadId (reviewer) | agent-id (both)                          |
| Liveness model           | mixed (paseo notify + codex MCP blocking) | uniform (paseo notify both layers)       |
| Reviewer as a real agent | no — it's an MCP tool call                | yes — inspectable, archivable, resumable |
| Verdict / audit / gate   | identical                                 | identical                                |

Option B is chosen because the user's explicit goal is to **replace** the
fusion, not preserve it: _"我的目标是全部替换为paseo父子agent的逻辑,而不是
原有融合codex mcp和paseo mcp."_ The codex reviewer becoming a real paseo
agent (inspectable via `list_agents` / `get_agent_status`, archivable via
`archive_agent`, resumable via `list_agents`-then-reattach) is the point —
it unifies liveness, tracing, and recovery across both layers.

## What is NOT modified (hard constraints)

- `third_parties/paseo/` — entirely untouched.
- `tools/*.py` / `tools/*.sh` helpers — `run_state.py`, `iteration_log.py`,
  `verify_paper_audits.sh`, `save_trace.sh`, `watchdog.py`, `provenance.py`,
  `extract_paper_style.py`, all fetchers, `experiment_queue/*` — called
  unchanged.
- `.aris/` layout — unchanged; paseo agents read/write the same paths.
- `shared-references/assurance-contract.md`, `reviewer-independence.md`,
  `acceptance-gate.md`, `integration-contract.md`, `output-*.md` —
  unchanged mechanism docs.
- The 11 research-pipeline constants — preserved verbatim.
- The 5-layer audit chain + `verify_paper_audits.sh` gate — unchanged.
- The fence, the stall→pivot ladder, the reviewer-independence protocol,
  the REVIEWER_BIAS_GUARD — unchanged.

## Phased rollout

- **Phase A — orchestrator + W-agents (claude), reviewer still MCP.** Rewrite
  `research-pipeline/SKILL.md` as the paseo orchestrator; W-agents created
  via paseo; reviewer still `mcp__codex__codex`. Validates: `run_state`
  transitions, gates, heartbeat fence, resume, agent-id continuation.
- **Phase B — reviewer → paseo codex agent.** Swap
  `mcp__codex__codex`/`codex-reply` for paseo codex sub-agents per
  `paseo-reviewer-dispatch.md`; adapt `REVIEW_STATE.json` /
  `PAPER_IMPROVEMENT_STATE.json` `threadId` → codex agent-id. Validates:
  fresh-vs-continuation, bias guard, tracing.
- **Phase C — full fanout.** Flip `fanout_subagents=true`; convert all
  sub-skill invocations across the 7 workflow + leaf verdict SKILLs to
  `paseo-subagent-dispatch.md`. Validates: parallel audit fanout (5 codex
  children), preemption-safe file handoff, cascade-archive, overnight run.

## Verification (end-to-end)

1. **Happy path**: `/research-pipeline "tiny topic" — auto_proceed: true,
auto_write: false`. Assert W1→W1.5→W2 (claude agents) in order; each
   spawns codex reviewer sub-agents as needed; `run_state.py status` shows
   all phases `accepted` with correct `reviewer`/`verdict_id` (codex
   agent-ids); `NARRATIVE_REPORT.md` produced.
2. **Resume**: kill orchestrator mid-W2; resume; assert resumes at
   non-terminal phase, W2 agent reused if alive (continues r2+ via
   `send_agent_prompt` to the same codex reviewer agent), recreated only
   if dead.
3. **Heartbeat fence**: `heartbeat_cron: */2 * * * *`; assert tick calls
   `iteration_log.py note`, nudges only Type-A sub-phases; does NOT
   `create_agent` new W2, does NOT `send_agent_prompt` to running W2,
   does NOT call `accept`.
4. **Audit gate**: `AUTO_WRITE=true, VENUE=ICLR, effort: beast`; assert W3
   runs 3 mandatory audits as claude sub-agents each spawning a fresh codex
   reviewer sub-agent (each writes JSON with `trace_path` +
   `thread_id`=codex agent-id); `verify_paper_audits.sh paper/ --assurance
submission` exits 0; delete `CITATION_AUDIT.json` → exit 1 blocks Final
   Report.
5. **Continuation (codex-reply analog)**: in W2, assert round 2
   `send_agent_prompt` targets the SAME codex agent-id persisted in
   `REVIEW_STATE.json` from round 1; assert W2 claude agent was NOT
   recreated between rounds.
6. **Bias guard (fresh agent)**: in auto-paper-improvement-loop, assert
   round 2 creates a NEW codex agent (different agent-id from round 1);
   assert round-1 codex agent was archived after round 1's verdict was
   read (用完即 archive).
7. **Reviewer-independence**: assert each codex reviewer's prompt contains
   file paths only, no executor summary (grep the review prompt passed to
   `create_agent`/`send_agent_prompt`).
8. **Parallel fanout**: 5 audit codex children run concurrently; assert
   all 5 complete and their JSON artifacts are non-preempted (parent reads
   files, not `<agent-response>`).
9. **Tracing**: after each reviewer round, `save_trace.sh` wrote
   `.aris/traces/<skill>/...` with `thread_id`=codex agent-id; audit
   artifacts' `trace_path` non-empty (verifier checks).
10. **Strict-substrate gate**: paseo MCP unavailable → run_state.py
    emits `BLOCKED` for the current phase; the run does NOT start.
    Per Global Rule 4 in
    [`skills/shared-references/paseo-subagent-dispatch.md`](../skills/shared-references/paseo-subagent-dispatch.md),
    there is no graceful-degradation fallback to in-process `Skill` +
    `mcp__codex__codex` — the user must start the Paseo daemon.

## Post-migration optimizations (v2)

After the paseo migration is complete, three operational improvements
are applied to the auto-research pipeline:

### 1. Direct provider resolution (no list_providers)

Every `create_agent` reads its `provider` from the cached
`.aris/runs/<run_id>.paseo-config.json`. **Never call `list_providers`
first** — it burns tokens for no benefit. If `create_agent` fails because
the provider is unavailable, **stop and notify the user** with a clear
message pointing to the CLAUDE.md `## ARIS Paseo` config field.

See [`paseo-subagent-dispatch.md`](../skills/shared-references/paseo-subagent-dispatch.md)
§"Provider resolution" and
[`paseo-reviewer-dispatch.md`](../skills/shared-references/paseo-reviewer-dispatch.md)
§"Provider resolution".

### 2. Idle agent supervision (parent never does child's work)

When a child agent transitions to `idle` before sending `notifyOnFinish`,
the parent investigates via `get_agent_status` + `get_agent_activity`
but **never implements the child's work itself**. The decision matrix:

| Child state                                        | Parent action                               |
| -------------------------------------------------- | ------------------------------------------- |
| Idle with live sub-agents (waiting for them)       | Do nothing — child is supervising correctly |
| Idle with no sub-agents, no receipt                | Send continuation prompt                    |
| Idle with error logs                               | Report BLOCKED                              |
| Idle with all sub-agents archived (missed receipt) | Send prompt to write receipt                |

See [`paseo-subagent-dispatch.md`](../skills/shared-references/paseo-subagent-dispatch.md)
§"Idle agent supervision" for the full decision matrix.

### 3. Notification-driven feedback loop

All agents use `notifyOnFinish: true` (push model). The parent never
calls `wait_for_agent` on a notify-enabled child. Each child writes a
`.done.json` receipt file as its last action. The parent's notification
handler is SHORT: read receipt → `set done` → run gate → archive child.

Multiple children can notify concurrently. File writes to distinct paths
are safe. The receipt file is the authoritative payload (preemption-safe).

See [`paseo-subagent-dispatch.md`](../skills/shared-references/paseo-subagent-dispatch.md)
§"Notification-driven feedback loop".

## See also

- [`skills/shared-references/paseo-subagent-dispatch.md`](../skills/shared-references/paseo-subagent-dispatch.md) — executor sub-agent dispatch. Contains canonical provider resolution, idle supervision, and notification-driven feedback rules.
- [`skills/shared-references/paseo-reviewer-dispatch.md`](../skills/shared-references/paseo-reviewer-dispatch.md) — reviewer sub-agent dispatch. Contains reviewer-specific provider resolution and idle supervision.
- [`templates/CLAUDE_MD_PASEO_SECTION.md`](../templates/CLAUDE_MD_PASEO_SECTION.md) — the `## ARIS Paseo` config block.
- [`skills/shared-references/external-cadence.md`](../skills/shared-references/external-cadence.md) — the fence. Heartbeat idle-supervision rules.
- [`skills/shared-references/resumable-runs.md`](../skills/shared-references/resumable-runs.md) — done/accepted resume.
- [`skills/shared-references/fan-out-pattern.md`](../skills/shared-references/fan-out-pattern.md) — fan-out vs jury.
