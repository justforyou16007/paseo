# Paseo Sub-Agent Dispatch

When an ARIS workflow skill needs to delegate a unit of work — a sub-skill,
a workflow phase, an audit, a fan-out shard — it does so by **spawning a
paseo child agent** rather than by making an in-process `Skill`-tool call.
This document is the canonical convention for doing that **without**
weakening the cross-model jury, the acceptance gate, the reviewer
independence, or the run-state machine that the entire ARIS design rests on.

Rule of thumb: **a parent agent dispatches the unit; it never dispatches the
verdict.** Fan out sub-skills (independent units of work). Never fan out the
loop iterations of a verdict-bearing skill — keep those inside one
long-lived agent (see `external-cadence.md`, the fence).

This is the **executor** dispatch pattern (claude parent → claude child).
The **reviewer** dispatch pattern (claude parent → codex child, GPT-5.5) is
the cross-model jury step and lives in its own doc:
[`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md). The two share
the lifecycle / continuity / fanout discipline below; only the provider and
independence rules differ.

## Global Agent Rules (apply to every ARIS workflow skill)

> These four rules govern ARIS agent identity, handshake, content boundary,
> and lifecycle. They are the single source of truth; this document is the
> **executor** half (Claude parent → Claude child), and the reviewer half
> lives in [`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md).
> Companion extensions: `reviewer-independence.md` (Rule 3 detail),
> `external-cadence.md` (Rule 4 heartbeat detail), `resumable-runs.md`
> (Rule 2 resume detail), `skill-governance.md` (Rule 4 provenance detail).

### Rule 1 — One Agent = One Skill (Strict)

Every agent executes **exactly one** currently-loaded skill. The skill plus
its run-bound context variables (`run_id`, `phase`, `project root`,
`CLAUDE.md` vars) is the agent's whole identity. If the skill's body
instructs the agent to trigger another skill, a sub-skill, a cross-model
review, or any fan-out shard, the agent **MUST** spawn a Paseo child
agent — it MUST NOT use the host `Skill` tool, `Task` tool, or `Agent`
tool to do it in-process.

### Rule 2 — Parent-Child Push Workflow

A parent agent dispatches work; it never dispatches the verdict. The
handshake is **push**, not request-response:

  1. **Spawn** — `mcp__paseo__create_agent` with `notifyOnFinish: true`,
     `relationship: {kind: "subagent"}`, `workspace: {kind: "current"}`.
     Bind the child to one skill (Rule 1) and to the run's variables.
  2. **Wait** — parent calls `mcp__paseo__wait_for_agent` (or reacts to
     the push notification). Parent **MUST NOT** poll `get_agent_status`
     in a loop.
  3. **Judge** — parent reads the child's receipt file
     (`.aris/runs/<run_id>.<phase>.done.json`). The receipt is the
     authoritative payload; `<agent-response>` text is convenience only
     and can be lost to preemption (`replaceRunning: true`).
  4. **Archive** — for fresh-purpose children, call
     `mcp__paseo__archive_agent` the moment the receipt is read
     ("用完即 archive"). For continuation children, keep alive until the
     loop terminates, then archive.

Children **MUST NOT** spawn their parent (no cycles). Children are free
to spawn their own sub-children (cascading sub-agent tree is fine;
grandchild archives cascade with the child).

### Rule 4 — Paseo MCP Only (Strict, no graceful degradation)

Agent lifecycle is **exclusively** managed by Paseo MCP — the 33 tools
listed at `mcp__paseo__*` (see `paseo-tools.ts` in `packages/server`).
The host `Skill` / `Task` / `Agent` tools and the legacy `mcp__codex__codex`
/ `mcp__codex__codex-reply` are **forbidden** in ARIS workflows.

**Strict mode**: if `mcp__paseo__list_agents` is unavailable at
orchestrator startup, the run is **blocked** (`run_state.py` writes
`status=BLOCKED` for the current phase) — it does **not** fall back to
in-process `Skill` + `mcp__codex__codex`. The run stops and the user is
asked to start the Paseo daemon.

The only MCP exception is `mcp__manual_review__*`, used for the
`— reviewer: manual` option (human-in-browser; cannot be a real agent).

#### Rule 4a — Creator Owns Lifecycle (sub-rule of Rule 4)

The agent that calls `mcp__paseo__create_agent` is the **lifecycle owner**
of the spawned child agent — sole authority for every other LIFECYCLE tool
against that child, for the child's full lifetime. This is the same
"owned by its parent" discipline the cascade-archive rule
(`relationship: {kind: "subagent"}`) already implies; this sub-rule makes
it explicit and exhaustive.

**The 13 LIFECYCLE tools** (the lifecycle-sensitive subset of the 33
`mcp__paseo__*` tools; the other ~20 — terminals, worktrees, schedules,
provider discovery — are adjacent but are NOT lifecycle ownership) are
reserved to the owner of the child they target. For any child the
owner spawned, only that owner may call:

  - `wait_for_agent` — receive the child's `notifyOnFinish` signal
  - `send_agent_prompt` — continuation (e.g. round 2+ reviewer, stalled
    child recovery per `Idle agent supervision`)
  - `get_agent_status` / `get_agent_activity` — supervision / idle
    detection
  - `set_agent_mode` / `update_agent` — runtime tuning
  - `list_pending_permissions` / `respond_to_permission` — permission
    lifecycle for that child
  - `cancel_agent` / `kill_agent` — forced termination
  - `archive_agent` — 用完即 archive (the Rule 2 step 4 / `Child lifecycle`
    discipline)

**Non-owners must not invoke LIFECYCLE tools against the owner's child.**
Specifically:

  - **Siblings** (other children of the same parent) are non-owners. They
    must not call any of the 13 tools against a peer's agent-id.
  - **The grandparent** (e.g. the orchestrator that spawned the parent
    W-agent) is a non-owner of the W-agent's children. The grandparent
    may read the W-agent's child IDs only via the W-agent's own report
    (e.g. the receipt file's `sub_agent_ids` array) or via
    `list_agents` (read-only inventory); it MUST NOT `send_agent_prompt`
    / `cancel_agent` / `archive_agent` them.
  - **The heartbeat** (`create_heartbeat` / overnight nudge) is a
    non-owner of every W-agent's children. Per
    `external-cadence.md` "Paseo driver note", the heartbeat may
    `get_agent_status` to detect a stall, but once a verdict agent is
    `running` it is hands-off until it `notifyOnFinish`-es. Recovery is
    **the owner's** job — the heartbeat nudges the owner, the owner
    re-dispatches.
  - **Cascade-archive reinforces, does not replace, this rule.**
    `relationship: {kind: "subagent"}` prunes grandchildren when the
    parent is archived (see `Verified paseo semantics` above), but the
    owner is still the only one that should call `archive_agent` on its
    own child explicitly (step 4 of Rule 2). Cascade-archive is the
    safety net; the owner is the primary.

**Owner-transfer rule (resume edge case).** If the original owner is
dead / archived and a fresh agent calls `create_agent` on resume, the
resuming agent becomes the new owner. The new owner may `send_agent_prompt`
to a still-alive codex reviewer that the dead owner spawned (reading its
agent-id from `REVIEW_STATE.json` per `resumable-runs.md`); the resume
hand-off re-attaches, it does not create a third owner. There is at all
times exactly **one** owner per child.

The owner's authority is bounded by the other rules: it cannot inject
guidance into a reviewer child (Rule 3 / `reviewer-independence.md`),
cannot self-acquit a quality verdict (`acceptance-gate.md`), and cannot
re-create a verdict-bearing loop's claude agent per round (the fence in
`external-cadence.md`). Ownership is a **lifecycle** authority, not a
verdict authority.

### Relationship to existing ARIS principles

- The DRIVE/ACQUIT split (`acceptance-gate.md`) is preserved: a Rule 1
  child is a DRIVE; the parent's gate is the ACQUIT step.
- The 6-component contract (`integration-contract.md`) applies: every
  cross-skill dispatch still needs predicate + helper + artifact +
  checklist + backfill + verifier.
- The fan-out pattern (`fan-out-pattern.md`) lives entirely **inside**
  the child agent spawned under Rule 2 — never across children.

## Why this contract exists

ARIS today chains sub-skills inside one Claude session via synchronous
`Skill`-tool calls. That works, but it (a) holds the whole workflow in one
context window, (b) gives the orchestrator no survival across a session
crash, and (c) fuses the executor and the reviewer onto one substrate.
Paseo parent-child agents replace the synchronous `Skill` call with a
durable, observable agent boundary: the child runs in its own context, the
parent is notified on completion, and either layer can crash and resume
without losing the other.

The risk this contract guards against is the same one
`integration-contract.md` and `fan-out-pattern.md` already name: **prose
can describe an integration; it cannot guarantee one.** "MUST invoke X via
paseo" without a canonical spawn shape, a continuity rule, and a lifecycle
policy will drift the moment a workflow author is under context pressure.
So this document fixes the shape once.

## Verified paseo semantics (load-bearing)

These were read from `third_parties/paseo/` (untouched) and are the
foundation everything below rests on:

- **`create_agent` = fresh context; `send_agent_prompt` to the SAME agent =
  continuation.** A paseo agent holds its own conversation thread. First
  prompt opens it; subsequent prompts to the same `agentId` continue it.
  This is the exact analog of `mcp__codex__codex` (fresh) vs
  `codex-reply` (continuation).
- **`relationship: {kind: "subagent"}` cascade-archives.** A subagent is
  owned by its parent; archiving the parent archives its children. Use
  `subagent` for every workflow child (W-agents, sub-skills, reviewers) so
  the tree prunes cleanly.
- **`workspace: {kind: "current"}` shares the project dir.** All children
  read/write the same `paper/`, `idea-stage/`, `.aris/runs/`,
  `.aris/traces/` paths the parent uses. Use `current` unless a child
  needs isolation (experiments that mutate the repo — see `subagent_workspace`).
- **`notifyOnFinish: true` + `wait_for_agent` is the notification contract.**
  The child sends a push notification via `notifyOnFinish`; the parent
  receives it by calling `wait_for_agent`, which blocks until the child
  completes or raises a permission request. The parent then reads the
  child's receipt file from disk. This is a push model — the parent does
  NOT poll the child's status.
- **`replaceRunning: true` on notifications.** A child's
  `notifyOnFinish` turn can preempt the parent's in-flight turn. So the
  parent's notification-handling turn must be SHORT (read the artifact
  file, append to results, return) and the authoritative payload must be a
  FILE the child writes — not the `<agent-response>` text (which is only
  the last contiguous assistant run and can be lost to preemption).
- **Cross-provider spawn needs explicit `settings.modeId`.** A claude
  parent spawning a codex child MUST pass `modeId` — cross-provider mode
  inheritance throws. See the reviewer doc.

## The executor sub-agent spawn shape

Every workflow SKILL that delegates a sub-skill or a phase spawns it with
this canonical shape. The variables come from the user project's CLAUDE.md
`## ARIS Paseo` block (see `templates/CLAUDE_MD_PASEO_SECTION.md`); defaults
are shown.

```
mcp__paseo__create_agent:
  relationship: {kind: "subagent"}
  workspace:    {kind: "current"}        # or "create" + worktree for isolated experiment runs
  title:        "<skill> :: <phase> :: <run_id>"
  provider:     "<executor_provider>"      # default claude/sonnet-4-6
  settings:
    modeId:           "<executor_mode>"   # default "auto"
    thinkingOptionId: "<executor_thinking>"  # model default; "xhigh" only when the skill demands
  initialPrompt: |
    <rendered prompt — see contract below>
  notifyOnFinish: true                    # push; parent calls wait_for_agent
```

### The `initialPrompt` contract

The child's prompt points at a **workflow definition** (a SKILL.md) and
binds it to **this run's context**. It does not paraphrase the workflow —
it hands the child the skill path and the run's variables, and tells it
where to write its completion receipt. Concretely:

```
You are an ARIS workflow sub-agent. Execute the workflow defined in:

    skills/<leaf>/SKILL.md

Run context (this run, do not re-derive):
  - run_id:        <run_id>
  - phase:         <phase-name>            # e.g. idea-discovery
  - project root:  <cwd>                  # workspace:{kind:"current"} shares this
  - CLAUDE.md vars: read the ## ARIS Paseo + ## ARIS sections of ./CLAUDE.md

Operating rules (non-negotiable):
  1. Resolve every helper via integration-contract.md §2 (.aris/tools → tools → $ARIS_REPO/tools). Never hardcode a path.
  2. Write artifacts to the standard stage dir for this phase (per the SKILL's output protocol). Do NOT write elsewhere.
  3. When you need the GPT-5.5 reviewer, spawn/continue a paseo codex sub-agent per paseo-reviewer-dispatch.md (NOT mcp__codex__codex).
  4. Do NOT call run_state.py accept. You may `set done --artifact <path>`; acceptance is the orchestrator's job (acceptance-gate.md).
  5. On completion, write the receipt file below and stop. Do not call accept, do not start the next phase.

Receipt (write this last, to .aris/runs/<run_id>.<phase>.done.json):
  { "phase": "<phase>", "artifact_path": "<abs path>", "summary": "<1-3 lines>",
    "next_step": "<suggested next phase or null>", "reviewer_used": "<codex-agent-id or null>" }
```

Why a receipt file (and not `<agent-response>`): the orchestrator reads the
receipt in its SHORT notification turn, preemption-safe. The file is the
observable side effect (`integration-contract.md` §3 — "the model said it
ran" is not a receipt). `run_state.py` is unchanged; the orchestrator uses
the receipt's `artifact_path` for `set done` and its own gate result for
`accept`.

## The two continuity modes (the core of the migration)

A parent agent continues a child in exactly two ways, mirroring today's two
codex call types:

| Today                                     | After migration                           | Used by                                                                                                                               |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__codex__codex` (fresh thread)        | **create a NEW paseo child agent**        | every sub-skill dispatch; every fresh-reviewer round (bias guard); every audit layer                                                  |
| `mcp__codex__codex-reply` (same threadId) | **`send_agent_prompt` to the SAME agent** | multi-round reviewer continuation (`auto-review-loop` round 2+); `idea-creator` devil's-advocate triage; `research-review` follow-ups |

**For executor sub-agents, the default is fresh.** A sub-skill like
`/research-lit` or `/proof-checker` is dispatched as a new child each time
it is needed — independent context, no carryover. Continuation
(`send_agent_prompt` to the same agent) is the **exception**, reserved for
the cases in the table, and always carries reviewer-memory semantics — see
the reviewer doc.

**Never recreate a verdict-bearing loop's claude agent per round.**
`auto-review-loop` (W2), `auto-paper-improvement-loop`, and
`auto-research-loop` (the optional W1.7 stage) are each ONE paseo
claude agent that loops rounds 1→N internally. The claude agent is created
once; what changes per round is whether the _codex reviewer_ it dispatches
is fresh (paper-improvement bias guard + auto-research-loop's
`REVIEWER_BIAS_GUARD`) or continued (auto-review-loop r2+).
`auto-research-loop` always uses a fresh codex sub-agent per round — its
round cadence is one iteration of the 10-step baseline-review-experiment
loop, and a continuation reviewer would drift toward confirming its own
prior direction. This is the fence (`external-cadence.md`) made operational:
the loop's internal round cadence is owned by one long-lived agent, not
re-entered from the top on a timer.
the top on a timer.

## Parallel fan-out discipline

When a workflow fans out N independent units (idea lenses, audit layers,
per-source retrieval), the parent spawns N children concurrently. The
invariants below are the preemption-safe subset of `fan-out-pattern.md`:

1. **Each child writes its result to its OWN file** on the shared workspace
   (`workspace:{kind:"current"}`). The parent reads files in its
   notification turns — never the `<agent-response>` text. A later child's
   notification can preempt the parent mid-turn (`replaceRunning:true`); a
   file on disk survives that, an in-memory variable does not.
2. **Parent notification turns are SHORT.** Read the artifact file, append
   to a results manifest, return. Do not deliberate, do not call accept,
   do not spawn more children from inside a notification turn. Long
   notification turns raise the chance the next child's notify preempts
   unfinished state.
3. **Fan out the search, never the bench.** Children GENERATE candidates
   (ideas, attack points, draft sections, audit findings); they NEVER
   render the acceptance verdict (`fan-out-pattern.md`). Quality/correctness
   verdicts stay a single cross-model codex sub-agent step per
   `paseo-reviewer-dispatch.md`.
4. **Mechanical merge/dedup on the parent only.** After all N children
   notify, the parent merges the candidate files and dedups
   judgment-free, exactly as today (`fan-out-pattern.md` §dedup). This is
   safe same-model work.
5. **Cascade-archive cleans up.** Children spawned as `subagent` are
   pruned when the parent is archived; the parent need not track every
   child id for cleanup (though it should for tracing — see below).

## Child lifecycle (用完即 archive / 用即留)

Two lifecycles, chosen by whether the child holds durable continuity:

- **Fresh-purpose child (the common case): archive as soon as its verdict
  / artifact is read.** A one-shot sub-skill agent, a fresh-reviewer codex
  agent, a single audit pass — `archive_agent` it the moment the parent
  has read its receipt and (for reviewers) run `save_trace.sh`. The full
  review history stays auditable via `.aris/traces/<skill>/...` (Policy C
  forensic) + the artifact JSON, NOT via live agent records. No
  fresh-purpose agent accumulates past its turn.
- **Continuation child: keep alive until its loop terminates, then archive.**
  `auto-review-loop`'s codex reviewer agent (round 2+ continues it) stays
  alive across rounds — it IS the thread — and is `archive_agent`-ed only
  when the loop ends (PASS/FAIL/BLOCKED). The claude W2 agent that owns it
  is likewise one long-lived agent, archived when the orchestrator accepts
  the phase.

A parent that spawns a fresh-purpose child and then forgets to archive it
leaves a live agent record that (a) can still receive stray prompts and (b)
clutters `list_agents` on resume. **Archive on read** for fresh-purpose
children — this is the 用完即 archive rule. Cascade-archive then prunes any
grandchildren the child had spawned.

## Permission handling (overnight autonomy)

`executor_mode` (CLAUDE.md `## ARIS Paseo`) selects the child's autonomy:

- `auto` (default) — workspace-write, on-request approvals. The parent
  handles the child's permission requests via `list_pending_permissions`
  - `respond_to_permission`, OR the human approves interactively.
- `bypassPermissions` — overnight autonomy. No approval round-trips; the
  child runs unattended. Use this for overnight pipelines where no human
  is watching.
- `plan` — read-only planning; never for a workflow phase that must write
  artifacts.

When `executor_mode: auto` and a child raises a permission request, the
parent is notified (`wait_for_agent` returns the pending request). The
parent should respond promptly so the child is not blocked overnight — but
must NOT use permission approval as a covert way to inject guidance into a
reviewer child (that violates `reviewer-independence.md`).

## Cross-provider gotcha (recap)

When the executor (claude) spawns a **codex** reviewer child, the spawn
MUST pass explicit `settings.modeId` — cross-provider mode inheritance
throws. This is the single most common spawn bug. Full detail and the exact
codex spawn shape are in `paseo-reviewer-dispatch.md`; it is mentioned here
only so an executor-author who copy-pastes the claude shape for a reviewer
is warned before they hit it.

## Resume: re-attach or recreate

On `/research-pipeline — resume <run_id>`, the orchestrator's job is to
restore each phase's child agent if possible:

1. `run_state.py resume <run_id>` → first non-terminal phase.
2. `list_agents` — is that phase's W-agent (or reviewer) still alive?
   - **Alive** → re-attach: await its `notifyOnFinish` (do NOT re-prompt a
     verdict agent mid-run — the fence; only await).
   - **Dead / archived** → `create_agent` fresh. The W-agent's startup reads
     `REVIEW_STATE.json` / `PAPER_IMPROVEMENT_STATE.json` and resumes from
     saved round+1, recreating the codex reviewer agent by reading its
     persisted agent-id if still alive (continuation preserved), else a
     fresh codex agent (reviewer memory may be lost — same risk as today's
     codex-server-restart; the trace files survive, the live thread may not).

The orchestrator never judges quality on resume — it reads on-disk
artifacts, runs the gate, calls `run_state.py accept`. The
`run_state.py` self-acquittal tripwire (`accept` warns on a `claude*`
reviewer) is the backstop.

## Anti-patterns to refuse in review

- **"Spawn a fresh W2 agent each round."** Recreating a verdict-bearing
  loop's claude agent per round breaks its round-to-round state and is the
  fence violation (`external-cadence.md`). W2 is one agent looping
  internally.
- **"Pass the executor's summary in the reviewer's initialPrompt."**
  Violates `reviewer-independence.md`. Reviewer children get file paths
  only; executor children may receive run context but not pre-digested
  verdicts about quality.
- **"Poll the child's status instead of using `wait_for_agent`."** The
  parent must call `wait_for_agent` on a notify-enabled child to receive
  its completion signal. Polling burns tokens and delays reaction time.
- **"Read the verdict from `<agent-response>`."** Not preemption-safe and
  only the last contiguous run. The verdict lives in a file the child
  writes; `<agent-response>` is a convenience for short status, not the
  authoritative payload.
- **"Forget to archive a fresh-purpose child."** Live agent records
  accumulate and can receive stray prompts. 用完即 archive.
- **"Let the heartbeat `send_agent_prompt` to a running verdict agent."**
  Interrupts it via `replaceRunning`. Heartbeat is Type-A only
  (`external-cadence.md`).

## Provider resolution: direct from config, never list_providers

Every `create_agent` call reads its `provider` field from the run's
`.aris/runs/<run_id>.paseo-config.json` (emitted once at orchestrator
startup by `render_w_agent_prompt.sh --emit-config`). The provider is
either `executor_provider` (for claude executor sub-agents) or
`reviewer_provider` (for codex reviewer sub-agents) from the `## ARIS
Paseo` config block in `CLAUDE.md`.

**Rule: never call `mcp__paseo__list_providers` before `create_agent`.**
The provider is pre-configured in CLAUDE.md; calling `list_providers`
adds a round-trip that burns tokens for no benefit. Instead:

1. Read `provider` from the cached `paseo-config.json`.
2. Call `mcp__paseo__create_agent` with that provider directly.
3. **On failure**: if `create_agent` returns an error indicating the
   provider is unavailable (not found, not configured, API key missing,
   model not accessible), **stop immediately** and notify the user:
   ```
   ⛔ Provider "<provider>" unavailable.
      Configured in CLAUDE.md ## ARIS Paseo → <field>.
      Check API keys, model availability, or update the config.
      Pipeline paused until resolved.
   ```
   Do NOT fall back to a different provider, do NOT retry with a default,
   do NOT silently continue. The user configured that provider explicitly;
   an unavailable provider is a configuration problem, not a transient
   error. The orchestrator enters BLOCKED state.

This is the `paseo-subagent-dispatch.md` equivalent of
`paseo-reviewer-dispatch.md`'s provider rule — both dispatch paths
use the same direct-from-config pattern.

## Idle agent supervision: the parent never does the child's work

When a child agent transitions to `idle` before sending its
`notifyOnFinish` notification, the parent must **investigate, not
assume**. The core principle:

> **The parent never implements the child's work.**
> If the child is idle, the parent checks why and either continues the
> child or archives it — it never takes over the task itself.

### Idle detection flow

1. The parent's heartbeat or supervision loop calls
   `mcp__paseo__get_agent_status` on the child.
2. If `status` is `idle` (not `running`, not `closed`), the child may
   have completed early, be blocked waiting for its own sub-agent, or
   have encountered a silent error.
3. **Check the child's logs** via `mcp__paseo__get_agent_activity` or
   by reading the child's terminal/output files to determine why it
   stopped.

### Decision matrix

| Child state / log signal                                    | Parent action                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Child completed its task (receipt file `.done.json` exists) | Read the receipt, `set done`, run the gate, `archive_agent`. This is the normal wait_for_agent path — no idle     |
| Child is **idle and waiting for its OWN sub-agent**         | **Do nothing.** The child is supervising its sub-agent correctly. Wait for the child's notifyOnFinish.            |
| (child has live sub-agents listed via `list_agents`)        | Do NOT send a continuation prompt — that would interrupt the child's own supervision loop.                        |
| Child is **idle with no sub-agents, no receipt**            | The child may have stalled or hit a silent error. Send a **continuation prompt** via `send_agent_prompt`:         |
|                                                             | `"You appear to have stopped. Continue your task and write the receipt file when done."`                          |
| Child is **idle with error logs**                           | Check the error. If recoverable (timeout, rate limit), send a continuation prompt with context. If fatal, archive |
|                                                             | the child, report the error to the user, and mark the phase BLOCKED.                                              |
| Child is **idle and its sub-agents are all archived/done**  | The child may have finished but failed to write its receipt. Send a continuation prompt to write the receipt.     |

### Anti-patterns

- ❌ **"The child is idle; I'll just do its work myself."** — Violates
  the core principle. Archive the child and re-dispatch if needed.
- ❌ **"The child is idle; I'll wait forever."** — Set a timeout per
  phase. After `max_idle_seconds` (configurable in CLAUDE.md
  `## ARIS Paseo` → `max_phase_idle`), escalate.
- ❌ **"The child is idle; I'll kill it and recreate."** — Only if the
  child has no receipt and no sub-agents. If it has sub-agents, those
  grandchild agents would be orphaned (unless cascade-archive handles
  them — but the loss of state may be expensive).

## Notification-driven feedback loop (notifyOnFinish + wait_for_agent)

The parent-child communication model is **notification-driven**: the
child pushes its completion signal via `notifyOnFinish` and writes a
receipt file. The parent receives this signal by calling `wait_for_agent`.

### Contract

1. **Every `create_agent` call MUST set `notifyOnFinish: true`** (the
   default in paseo). This configures the child to notify the parent
   when its run completes.
2. **The parent MUST call `mcp__paseo__wait_for_agent` after creating
   the child** to block until the child finishes or raises a permission
   request. `wait_for_agent` returns the child's completion signal;
   it does NOT poll — it awaits the push notification.
3. **The child MUST write a receipt file** (`.aris/runs/<run_id>.<phase>.done.json`)
   as its last action before stopping. The receipt is the authoritative
   payload — preemption-safe, survives crashes.
4. **After `wait_for_agent` returns**, the parent reads the receipt file
   (NOT `<agent-response>`), runs the gate, and archives the child.
   The notification handler is SHORT: read → `set done` → gate → archive.
   Do NOT deliberate or spawn new children inside the handler.
5. **Multiple children may be awaited sequentially** (one `create_agent` +
   `wait_for_agent` pair per child). For parallel fan-out, see
   `fan-out-pattern.md`.

### Receipt file format (standardized)

Written by the child agent as its final action:

```json
{
  "phase": "<phase-name>",
  "run_id": "<run_id>",
  "artifact_path": "<absolute-path-to-main-output>",
  "summary": "<1-3 line summary of what was accomplished>",
  "next_step": "<suggested next phase or null>",
  "sub_agent_ids": ["<agent-id-1>", "<agent-id-2>"],
  "completed_at": "<ISO-8601-timestamp>"
}
```

The parent reads this file after `wait_for_agent` returns. The
`sub_agent_ids` array helps the parent understand if the child was
managing sub-agents (for idle-supervision decision matrix above).

### Parent dispatch flow (pseudocode)

```
# Dispatch a child agent
child_id = create_agent(provider, initialPrompt, notifyOnFinish=true)

# Wait for the child to complete (push notification via notifyOnFinish)
result = wait_for_agent(child_id)
# result contains the child's completion status / permission requests

# Read the receipt file
receipt_path = ".aris/runs/<run_id>.<phase>.done.json"
if receipt_path exists:
    receipt = read_json(receipt_path)
    run_state.set(run_id, phase, "done", artifact=receipt.artifact_path)
    if gate_passes(phase, receipt):
        run_state.accept(run_id, phase, verdict_id=..., reviewer=...)
    archive_agent(child_id)  # 用完即 archive
else:
    # Child finished but no receipt — check status
    status = get_agent_status(child_id)
    if status == "idle":
        # Send continuation to write receipt
        send_agent_prompt(child_id,
            "Write the completion receipt file and stop.")
```

> **Why `wait_for_agent` is needed even with `notifyOnFinish: true`:**
> `notifyOnFinish` configures the child to notify the parent, but the
> parent must actively await that notification via `wait_for_agent`.
> Without it, the parent would have to poll or risk missing the signal.
> `wait_for_agent` blocks until the notification arrives — it is the
> **receiver** side of the push model.

## Cross-references

- [`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md) — the
  cross-model codex reviewer spawn shape, fresh-vs-continuation rule, and
  the `save_trace.sh` `--thread-id <codex-agent-id>` contract. The jury
  half of this migration.
- [`fan-out-pattern.md`](fan-out-pattern.md) — fan-out is firepower; the
  jury is the bench. Paseo parallel fan-out is the Tier-1/2 dispatch
  mechanism; the verdict stays single and cross-model.
- [`external-cadence.md`](external-cadence.md) — the fence: do not wrap
  verdict-bearing loops in external cadence. Restated for the paseo driver:
  the heartbeat nudges Type-A only, never re-creates a running verdict agent.
- [`acceptance-gate.md`](acceptance-gate.md) — a parent can DRIVE (dispatch
  children, mark `done`); it cannot ACQUIT (call `accept` on its own
  family's quality verdict). Acceptance stays cross-model or deterministic.
- [`integration-contract.md`](integration-contract.md) — §2 helper
  resolution chain (children resolve helpers the same way); §3 the receipt
  file is the observable side effect.
- [`reviewer-independence.md`](reviewer-independence.md) — reviewer
  children get file paths only; the executor child may carry run context
  but never a pre-digested quality verdict.
- [`resumable-runs.md`](resumable-runs.md) — `run_state.py` done/accepted
  machine; resume re-attaches a live child or recreates a dead one.
- [`external-cadence.md`](external-cadence.md) — stall detection →
  forced structural pivot; heartbeat idle-supervision rules.
