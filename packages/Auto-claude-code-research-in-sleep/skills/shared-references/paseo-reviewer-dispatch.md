# Paseo Reviewer Dispatch

The cross-model reviewer in ARIS is a **GPT-5.5** verdict rendered against a
**Claude** executor's work. The reviewer is a **paseo codex sub-agent** —
spawned by the Claude executor (a workflow agent or a leaf verdict skill
running inside one), not called through an in-process MCP tool.

This document is the **single place** that maps today's codex-MCP reviewer
discipline to paseo agent semantics. It is the jury half of the migration;
the executor half is [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md).

Rule of thumb: **fresh review = new codex agent each time; continuation
review = `send_agent_prompt` to the same codex agent.** Nothing else
changes — the reviewer is still GPT-5.5, still `xhigh`, still receives file
paths only, still writes a traceable verdict.

## Global Agent Rules (reviewer half)

> Companion to [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md)
> §"Global Agent Rules". The executor half is the single source of
> truth for Rule 1 / Rule 4; this document owns the **reviewer-
> specific** view of Rule 2 and the **full** Rule 3 (content-free
> handshake), since review is the only path where executor and
> reviewer are different model families.

### Rule 1 — One Agent = One Skill (reviewer applies)

A reviewer sub-agent runs exactly one review skill
(`/auto-review-loop`, `/proof-checker`, `/paper-claim-audit`, etc.).
Cross-skill composition (e.g. running novelty + paper-claim-audit in
one reviewer) is **forbidden** — spawn separate children.

### Rule 2 — Parent-Child Push Workflow (reviewer adds: cross-model verification BEFORE notify)

A reviewer-bearing child **MUST** invoke cross-model verification per
the §"When to apply" pattern below before notifying its parent.
Specifically: the child runs its skill, the cross-model reviewer
(typically codex/GPT-5.5) reads the artifact cold and emits a
verdict, the child records the verdict in its receipt file, and
**only then** does `notifyOnFinish` fire. The parent sees the verdict
in the receipt — not in the child's text.

For multi-round review (e.g. `auto-review-loop` r2+), the reviewer
is a **continuation** child (`send_agent_prompt` to the same
agentId), not a fresh child — see §"Fresh vs continuation" below.

### Rule 3 — Content-Free Inter-Agent Handshake (full text)

Communication between any two ARIS agents (parent ↔ child, child ↔
sub-child, executor ↔ reviewer) **MUST NOT** carry:

  - ❌ File contents, snippets, or previews
  - ❌ Executor summaries, paraphrases, or interpretations
  - ❌ Key findings or bullet points extracted by the sender
  - ❌ Recommendations, leading questions, or assertions of quality
  - ❌ Previous round feedback from any agent other than the
    recipient's own prior round

Communication **MAY** carry:

  - ✅ Task status (`pending` / `running` / `done` / `failed` /
     `accepted` / `skipped`)
  - ✅ Verdict id, reviewer name, verdict schema path
  - ✅ Artifact **paths** (let the recipient read the file)
  - ✅ Role/persona, review objective, structural metadata
  - ✅ Venue constraints (page limit, format)

**Exception — reviewer's self-reference**: a reviewer's continuation
`send_agent_prompt` MAY reference **its own** prior feedback ("did
you fix round 1's gap?"). It MUST NOT reference the executor's
interpretation of that feedback (the same exclusion that
`reviewer-independence.md` §"Exception" already documents).

### Rule 4 — Paseo MCP Only

See [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md)
§"Rule 4". The reviewer is a Paseo agent (`provider: "codex/gpt-5.5"`
via `create_agent`); it MUST NOT be called via legacy MCP tools. The only allowed
MCP exception is `mcp__manual_review__*` for `— reviewer: manual`.

#### Rule 4a — Creator Owns Lifecycle (reviewer view; sub-rule of Rule 4)

The agent that calls `mcp__paseo__create_agent` is the **lifecycle owner**
of the spawned child — for the reviewer's two sides:

  - **The reviewer is itself an owned child.** A codex reviewer agent
    is created by its parent W-agent (e.g. `auto-review-loop` round 1,
    `proof-checker`, `paper-claim-audit`). That W-agent — and only that
    W-agent — is the reviewer's owner. The 13 LIFECYCLE tools against
    the reviewer (`wait_for_agent`, `send_agent_prompt` for round 2+
    continuation, `get_agent_status` / `get_agent_activity`,
    `archive_agent` for 用完即 archive, etc.) are reserved to the
    owning W-agent. The heartbeat, the orchestrator, and any other
    W-agent are non-owners of THIS reviewer — they must not invoke
    LIFECYCLE tools against its agent-id.
  - **The reviewer that spawns a sub-child is itself an owner.** A
    codex reviewer that fan-outs sub-audits (e.g. a novelty pass that
    spawns a per-section audit) becomes the lifecycle owner of those
    sub-children, with the same 13-tool authority. The reviewer's
    parent W-agent (the original owner) is NOT the owner of the
    reviewer's children; the reviewer is. This is the same
    "owned by its parent" cascade-archive discipline applied one level
    down.

**Owner-transfer (resume).** Same as the executor half: on
`/research-pipeline — resume <run_id>`, if the original owning W-agent
is dead / archived, the fresh W-agent that `create_agent`s on resume
becomes the new owner of any still-alive codex reviewer (read its
agent-id from `REVIEW_STATE.json` `threadId` and re-attach with
`send_agent_prompt`). At all times exactly one owner per child.

The owner is the **lifecycle** authority. The reviewer's verdict
independence is preserved by Rule 3 + `reviewer-independence.md` —
ownership does not let the parent inject guidance into a reviewer
child. The two are orthogonal: lifecycle ≠ verdict.

### Cross-references

- `reviewer-independence.md` — the detailed CAN/CANNOT list for
  executor→reviewer comm; this rule generalizes it to **all**
  inter-agent comm.
- `acceptance-gate.md` — the cross-model-vs-same-model distinction
  that motivates Rule 3.
- `resumable-runs.md` — Rule 2's resume / re-attach path lives there.

## Why a separate doc from the executor dispatch

The executor and the reviewer share the paseo substrate, the lifecycle, and
the fanout discipline. They differ in three load-bearing ways that make a
shared doc unsafe:

1. **Provider.** The executor is `claude`; the reviewer is `codex/gpt-5.5`.
   Crossing providers is the one spawn path that throws without an explicit
   `modeId`.
2. **Independence.** The reviewer's prompt is file-paths-only
   (`reviewer-independence.md`); the executor's prompt may carry run
   context. The reviewer must not see the executor's summary.
3. **Continuity.** The reviewer has a fresh-vs-continuation rule with a
   bias guard; the executor is almost always fresh. Getting this wrong
   re-introduces the self-acquittal / bias risks the existing
   `REVIEWER_BIAS_GUARD` and `external-cadence.md` fence exist to prevent.

## Verified codex-agent semantics (load-bearing)

Read from `third_parties/paseo/` (untouched):

- **A codex agent holds `currentThreadId`.** First prompt calls `thread/start`
  (fresh thread); subsequent `send_agent_prompt` to the same agent reuse
  `currentThreadId` (continuation). So: **`create_agent` = fresh review;
  `send_agent_prompt` to the same agent = continuation review.** The mapping
  is exact.
- **The codex child is self-contained.** It runs Codex CLI with native tools
  (shell, apply_patch, web_search) + only the paseo MCP server injected. It
  does NOT recursively spawn sub-agents — that is the whole point of
  having a dedicated paseo codex agent.
- **Cross-provider spawn REQUIRES explicit `settings.modeId`.** Without it,
  the spawn throws "cannot inherit mode" (`create-agent-mode.ts`). This is
  the single most common reviewer-spawn bug.
- **`reasoning_effort: xhigh`** is set via `settings.thinkingOptionId:
"xhigh"` (the raw codex reasoning-effort string; verify the exact id for
  `gpt-5.5` via `list_models` / `inspect_provider`).
- **`<agent-response>` = the child's full last contiguous assistant message**
  (no truncation), but only the last contiguous run. So the structured
  verdict must ALSO be written to a file the child produces — not relied on
  from the response text alone (preemption-safe, per
  `paseo-subagent-dispatch.md`).

## The codex reviewer spawn shape

```
mcp__paseo__create_agent:
  relationship: {kind: "subagent"}        # cascade-archive with the parent
  workspace:    {kind: "current"}         # shared project dir; reviewer reads the same artifacts
  title:        "<skill> reviewer round <N> :: <run_id>"
  provider:     "<reviewer_provider>"      # default codex/gpt-5.5
  settings:
    modeId:           "<reviewer_mode>"   # default "full-access"; MANDATORY for cross-provider
    thinkingOptionId: "<reviewer_thinking>"  # default "xhigh"
  initialPrompt: |
    <review prompt — FILE PATHS ONLY, no executor summary; see reviewer-independence.md>
  notifyOnFinish: true
```

### Mode selection (`reviewer_mode`)

| mode                    | sandbox              | approvals    | use                                                                                                                                                                |
| ----------------------- | -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `full-access` (default) | `danger-full-access` | `never`      | autonomous repo read — the `codex exec` analog. The reviewer reads the whole project, runs shell to inspect, returns a verdict. Use this for every default review. |
| `auto`                  | `workspace-write`    | `on-request` | when the reviewer must also apply a fix (rare; most reviewers judge, not fix)                                                                                      |
| `read-only`             | —                    | —            | **cannot write the verdict file** — do NOT use for a reviewer that must emit an artifact                                                                           |
| `auto-review`           | —                    | —            | Codex's _internal_ guardian mode. NOT our reviewer. Do not confuse the names.                                                                                      |

`full-access` is the default because the reviewer needs to read the whole
project (code, results, paper draft) to form an independent assessment,
exactly as `codex exec` does today. Network is on (the reviewer may fetch a
citation to verify it); approvals are `never` (autonomous overnight).

### The `initialPrompt` contract (reviewer-independence is absolute)

The reviewer's prompt carries **file paths and the review objective only**.
Per `reviewer-independence.md`, it must NOT carry:

- ❌ the executor's summary or paraphrase of file contents
- ❌ the executor's interpretation of results
- ❌ "since last round we fixed X, Y, Z"
- ❌ leading questions, key findings, recommendations

```
You are a senior cross-model reviewer (GPT-5.5). Review the work below.

Role: <e.g. NeurIPS-level ML reviewer / proof auditor / citation auditor>
Objective: <e.g. score novelty/soundness/clarity/significance 1-10; emit a 6-state verdict>

Files to read (read them yourself; do not trust any summary):
  - /abs/path/to/PROPOSAL.md
  - /abs/path/to/EXPERIMENT_LOG.md
  - /abs/path/to/paper/main.tex
  - /abs/path/to/src/

Output: write your verdict to /abs/path/to/<SKILL>_REVIEW.json with the schema:
  { "verdict": "PASS|WARN|FAIL|BLOCKED|ERROR|NOT_APPLICABLE",
    "score": <int>, "summary": "<text>", "issues": [...], "trace_path": "<filled by parent>" }
Then return a one-line status. Do not call run_state.py.
```

The one **exception** (`reviewer-independence.md` §Exception): a continuation
`send_agent_prompt` may reference the reviewer's OWN prior feedback to check
resolution — but still must not include executor interpretations of that
feedback.

## The fresh-vs-continuation rule (the heart of this doc)

Every reviewer call is one of two kinds. The kind is decided by the
**calling skill's doctrine**, not by the parent's convenience:

| Kind                               | Paseo action                                | Persisted handle                                        | Used by                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fresh** (REVIEWER_BIAS_GUARD)    | `create_agent` a NEW codex agent            | new agent-id; `archive_agent` after the verdict is read | `auto-paper-improvement-loop` (round 1 AND round 2 — bias guard); every audit layer (`proof-checker`, `paper-claim-audit`, `citation-audit`, `kill-argument`); `novelty-check`; `research-review` round 1; `experiment-bridge` Phase 2.5 code review; `idea-creator` Phase 4 first pass |
| **Continuation** (reviewer memory) | `send_agent_prompt` to the SAME codex agent | the round-1 agent-id, read from `REVIEW_STATE.json`     | `auto-review-loop` round 2+ (reviewer checks resolution against its OWN prior critique + the Debate ruling); `research-review` follow-ups; `rebuttal` stress-test follow-ups; `idea-creator` devil's-advocate triage                                                                    |

### Why fresh exists: REVIEWER_BIAS_GUARD

`auto-paper-improvement-loop` runs review → fix → recompile → re-review. If
the round-2 reviewer were a continuation of the round-1 reviewer, it would
see its own earlier critique and be biased toward confirming the fix ("I
flagged this last round and they addressed it → PASS"). To force a
**genuinely independent** re-assessment, round 2 spawns a **fresh** codex
agent with no memory of round 1. The fresh agent sees only the current
artifact state and re-judges from scratch. This is the REVIEWER_BIAS_GUARD,
preserved verbatim — only the mechanism changes (new agent vs fresh thread).

### Why continuation exists: reviewer memory + Debate

`auto-review-loop` is different: round 2+ the reviewer is meant to **check
whether its own round-1 concerns were resolved**. That requires memory of
what it flagged. So round 2 continues the SAME codex agent — `send_agent_prompt`
to the agent-id persisted in `REVIEW_STATE.json` — and the reviewer checks
resolution against its own prior critique (the `reviewer-independence.md`
Exception). The Debate ruling is likewise a continuation. This is the
exact analog of today's `codex-reply` reusing `threadId`.

### The lifecycle rule (用完即 archive)

- **Fresh reviewer:** `archive_agent` the moment the parent has read the
  verdict AND run `save_trace.sh`. No fresh reviewer accumulates past its
  round. The full review history stays auditable via `.aris/traces/<skill>/...`
  - the verdict JSON, NOT via a live agent.
- **Continuation reviewer (auto-review-loop r2+):** keep alive across rounds
  (it IS the thread); `archive_agent` when the loop terminates
  (PASS/FAIL/BLOCKED/ERROR). The claude W2 agent that owns it is one
  long-lived agent; the codex reviewer it dispatches is one long-lived agent.

## The verdict-file handoff contract

The reviewer writes its structured verdict to a **file** on the shared
workspace. The parent reads the file in its SHORT notification turn
(preemption-safe). The file is the authoritative payload; `<agent-response>`
is at most a one-line status.

Per-skill verdict files (paths unchanged from today):

| Skill                         | Verdict file                                        | Schema                                                                      |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| `auto-review-loop`            | `.aris/runs/<run_id>.auto-review.REVIEW_STATE.json` | 6-state verdict + score + `threadId` (= codex agent-id now)                 |
| `auto-paper-improvement-loop` | `PAPER_IMPROVEMENT_STATE.json`                      | per-round verdict + `threadId` (per-round codex agent-id, bookkeeping only) |
| `proof-checker`               | `paper/PROOF_AUDIT.json`                            | 6-state + `trace_path` + `thread_id`                                        |
| `paper-claim-audit`           | `paper/PAPER_CLAIM_AUDIT.json`                      | 6-state + `trace_path` + `thread_id`                                        |
| `citation-audit`              | `paper/CITATION_AUDIT.json`                         | 6-state + `trace_path` + `thread_id`                                        |
| `kill-argument`               | computed from per-point counts                      | the skill computes the verdict; codex only classifies points                |

`verify_paper_audits.sh` validates `trace_path` / `thread_id` as non-empty
strings — **unchanged**. The values now hold paseo codex agent-ids instead
of codex-MCP thread ids; both fit the "durable handle string" contract.

## The trace contract (`save_trace.sh` — helper UNCHANGED)

After **every** reviewer round, the parent (the claude agent that spawned
the reviewer) runs `save_trace.sh`, resolved via `integration-contract.md`
§2 (Policy C, forensic — never skip; write inline if the helper is
unresolved). The only thing that changes is the `--thread-id` value: it now
holds the **paseo codex agent-id**.

```bash
# Resolve $TRACE_HELPER (canonical strict-safe chain; see integration-contract.md §2).
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1
if [ -z "${ARIS_REPO:-}" ] && [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi
TRACE_HELPER=".aris/tools/save_trace.sh"
[ -f "$TRACE_HELPER" ] || TRACE_HELPER="tools/save_trace.sh"
[ -f "$TRACE_HELPER" ] || { [ -n "${ARIS_REPO:-}" ] && TRACE_HELPER="$ARIS_REPO/tools/save_trace.sh"; }
[ -f "$TRACE_HELPER" ] || TRACE_HELPER=""

# <codex_agent_id> is the paseo agent-id returned by create_agent / read from REVIEW_STATE.json
if [ -n "$TRACE_HELPER" ]; then
  bash "$TRACE_HELPER" \
    --skill "<skill-name>" \
    --purpose "<purpose>" \
    --model "gpt-5.5" \
    --thread-id "<codex_agent_id>" \
    --prompt "<full prompt as sent>" \
    --response "<full response content>"
else
  # Policy C fallback: write run.meta.json + request.json + response.md + meta.json
  # directly per review-tracing.md schema. Do NOT silently skip.
  echo "WARN: save_trace.sh not resolved; writing trace files directly per review-tracing.md." >&2
fi
```

The trace's `meta.json` `thread_id` field therefore holds a paseo codex
agent-id; the `request.json` `tool` field is now `paseo:create_agent` (fresh)
or `paseo:send_agent_prompt` (continuation). `save_trace.sh` itself is not modified — it
treats `--thread-id` as an opaque string.

## Persisting the handle (state-schema adaptation, helpers UNCHANGED)

The state files that carry `threadId` are repurposed to hold paseo codex
agent-ids. **Field names are unchanged** (zero helper churn — they are
opaque strings to the helpers):

| File                                 | Field                      | Today                   | After                                                                                           |
| ------------------------------------ | -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `REVIEW_STATE.json`                  | `threadId`                 | codex MCP thread id     | paseo codex agent-id (continuation: round 2+ `send_agent_prompt` targets this)                  |
| `PAPER_IMPROVEMENT_STATE.json`       | `threadId`                 | codex MCP thread id     | paseo codex agent-id (per-round, bookkeeping only — NOT reused; REVIEWER_BIAS_GUARD)            |
| `run_state.py accept --verdict-id`   | `verdict_id`               | codex thread / trace id | paseo codex agent-id (codex-accepted phases) or verifier-report path/sha (deterministic phases) |
| audit JSON (`PROOF_AUDIT.json` etc.) | `thread_id` / `trace_path` | codex thread id         | paseo codex agent-id / trace dir                                                                |

On resume, a workflow agent reads the persisted codex agent-id from
`REVIEW_STATE.json` and: if that agent is still alive (`list_agents`),
continue it (`send_agent_prompt`); else create a fresh codex agent (reviewer
memory may be lost — same risk as today's codex-server-restart; the trace
files survive, the live thread may not). This is `resumable-runs.md` applied
to the reviewer layer.

## The fence, restated for the reviewer

`external-cadence.md` forbids re-entering a verdict skill from the top on a
timer. For the reviewer specifically:

- **`auto-review-loop` reviewer = ONE codex agent** continued across rounds
  (r2+). The heartbeat / orchestrator must NOT `send_agent_prompt` to it
  while a round is in flight (`replaceRunning` would interrupt it), and
  must NOT recreate it (loses reviewer memory — breaks continuation).
- **`auto-paper-improvement-loop` reviewer = a FRESH codex agent each
  round.** The heartbeat must NOT pre-emptively spawn round 2's reviewer;
  the loop's own claude agent creates it when round 2 begins (bias guard
  preserved).

The heartbeat is Type-A only: touch `run_state`, `iteration_log.py note`,
nudge stalled Type-A sub-phases. It never renders a quality verdict.

## Reviewer backend selection (passes through `— reviewer:`)

`reviewer-routing.md`'s directive still selects the reviewer backend. After
migration:

- `— reviewer: codex` (default) **or unset** → paseo codex sub-agent per
  this doc (`codex/gpt-5.5`, `full-access`, `xhigh`).
- `— reviewer: oracle-pro` / `agy` → still MCP (`mcp__oracle__consult` /
  `mcp__gemini_review__review`). These are alternate cross-model backends;
  they stay MCP because they are not the codex-as-paseo-agent path. The
  independence + tracing contracts apply identically.
- `— reviewer: manual` → still the manual-review MCP (human-in-browser).
  This cannot be a paseo agent (it is a human). Stays as-is.

The `REVIEWER_DIFFICULTY` / `REVIEWER_BACKEND` pass-throughs are unchanged;
they now select a paseo codex agent (default) vs an MCP fallback.

## Anti-patterns to refuse in review

- **"Continue the same codex agent in auto-paper-improvement-loop round 2."**
  That is the bias guard violation — round 2 must be a FRESH agent.
- **"Create a fresh codex agent for auto-review-loop round 2."** That loses
  reviewer memory and breaks the continuation that `codex-reply` provided.
  Round 2+ continues the round-1 agent.
- **"Omit `settings.modeId` on the codex spawn."** Throws (cross-provider).
  Always pass it explicitly.
- **"Read the verdict only from `<agent-response>`."** Not preemption-safe.
  The verdict is in the file the reviewer writes.
- **"Forget to archive a fresh reviewer."** Live codex agents accumulate
  and can receive stray prompts. 用完即 archive after `save_trace.sh`.
- **"Pass the executor's summary in the reviewer prompt."** Violates
  `reviewer-independence.md`. File paths only.
- **"Let the heartbeat `send_agent_prompt` to a running reviewer."**
  Interrupts the in-flight round via `replaceRunning`. Heartbeat is Type-A.

## Provider resolution: direct from config, never list_providers

**Same rule as executor dispatch.** The reviewer's `provider` field is
read from `.aris/runs/<run_id>.paseo-config.json` → `reviewer_provider`.
Never call `mcp__paseo__list_providers` before `create_agent`.

If `create_agent` fails because the reviewer provider (e.g.
`codex/gpt-5.5`) is unavailable, **stop and notify the user**:

```
⛔ Reviewer provider "<reviewer_provider>" unavailable.
   Configured in CLAUDE.md ## ARIS Paseo → reviewer_provider.
   Cross-model jury cannot proceed without a reviewer.
   Pipeline paused until resolved.
```

Do NOT fall back to a different provider or to an in-process reviewer.
The cross-model jury (`acceptance-gate.md`) requires the configured
reviewer — a degraded jury is not the same jury.

## Idle reviewer supervision

Reviewer sub-agents follow the same idle-detection rules as executor
sub-agents ([paseo-subagent-dispatch.md](paseo-subagent-dispatch.md)
§"Idle agent supervision"). The parent (W-agent) checks:

- **Reviewer idle with no sub-agents, no verdict file written** → the
  reviewer may have stalled. Send a continuation prompt:
  `"You were reviewing. Continue and write your verdict."`
- **Reviewer idle waiting for its own sub-agent** (has live sub-agents)
  → do nothing. The reviewer is supervising correctly.
- **Reviewer idle with verdict file written** → normal completion. Read
  the verdict, `save_trace.sh`, archive.

**Never take over the reviewer's work.** If the reviewer is idle and
not producing a verdict, the parent continues it or archives it — it
never writes its own review verdict. That would violate
`reviewer-independence.md`.

## Notification-driven verdict collection

Reviewer verdicts follow the same notification-driven model:

1. `create_agent` with `notifyOnFinish: true`.
2. The parent calls `mcp__paseo__wait_for_agent` to await the reviewer's
   completion notification.
3. After `wait_for_agent` returns, the parent reads the verdict file
   (per the calling skill's schema — `REVIEW_STATE.json`,
   `AUDIT_RESULT.json`, etc.), runs `save_trace.sh`, and archives the
   reviewer (fresh-purpose) or keeps it alive (continuation reviewer,
   W2 r2+).
4. The verdict file is the authoritative payload — preemption-safe.
   `<agent-response>` is at most a one-line status.

For continuation reviewers (W2 round 2+), the parent keeps the codex
agent alive between rounds. The parent does NOT re-create — it calls
`send_agent_prompt` to continue the same agent, then `wait_for_agent`
again. The reviewer's verdict file is overwritten each round (the parent
reads it before sending the next prompt).

## Cross-references

- [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md) — the executor
  half (claude parent → claude child). Shares lifecycle / fanout / fence;
  differs in provider, independence, and continuity defaults.
- [`reviewer-routing.md`](reviewer-routing.md) — backend selection. The
  default codex reviewer is now a paseo codex agent; `oracle-pro`/`agy`/
  `manual` stay MCP. `codex exec` CLI (nightmare mode) maps to a paseo
  codex agent in `full-access` mode.
- [`reviewer-independence.md`](reviewer-independence.md) — reviewer prompt
  is file-paths-only; the continuation Exception (reviewer may reference
  its OWN prior feedback).
- [`review-tracing.md`](review-tracing.md) — `save_trace.sh` after every
  reviewer round; `--thread-id` now holds a paseo codex agent-id. Helper
  unchanged.
- [`acceptance-gate.md`](acceptance-gate.md) — Type-A (execution, safe
  same-model) vs Type-B (quality, must be cross-model). The reviewer is the
  Type-B authority; the executor may mark `done` but never `accept`.
- [`external-cadence.md`](external-cadence.md) — the fence. The reviewer
  agent is one long-lived agent (continuation) or fresh-per-round (bias
  guard), never re-entered from the top on a timer.
- [`fan-out-pattern.md`](fan-out-pattern.md) — fan out the evidence that
  feeds the verdict; the verdict itself stays a single cross-model step.
