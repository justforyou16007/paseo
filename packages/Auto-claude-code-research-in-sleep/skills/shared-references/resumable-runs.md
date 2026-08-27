# Resumable Runs

A long ARIS workflow (`/research-pipeline`, `/paper-writing`, `/idea-discovery`)
stores its ordered phases and statuses at
`<root>/.aris/runs/<run_id>.json`. An explicit resume uses this state to locate
the first phase that still needs execution or acceptance.

## Resume uses phase state, not session text

Resumption is not "reopen the id" — it is **resolve FORWARD to where progress
that can be TRUSTED actually landed.** And "trusted" is where ARIS's invariant
lives. The phase-status enum splits execution from acceptance:

| status         | meaning                                                                             | who sets it                                                                                                                                                        | gate class                                                        |
| -------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `pending`      | not started                                                                         | `start`                                                                                                                                                            | —                                                                 |
| `running`      | in progress                                                                         | executor (`set`)                                                                                                                                                   | —                                                                 |
| `failed`       | executor errored                                                                    | executor (`set`)                                                                                                                                                   | —                                                                 |
| **`done`**     | executor finished writing the artifact                                              | executor (`set`)                                                                                                                                                   | **EXECUTION-completeness — safe same-model self-report**          |
| **`accepted`** | a cross-model reviewer **or** a deterministic verifier returned a positive verdict  | **`accept` only** — requires a recorded verdict id + reviewer, AND the phase already `done` (use `--force` for a purely-deterministic phase with no executor step) | **QUALITY/correctness — cross-model (or a deterministic check)**  |
| `skipped`      | the phase does not apply to this run (e.g. `paper-writing` when `AUTO_WRITE=false`) | executor (`set`)                                                                                                                                                   | terminal — a deterministic config decision, not a quality verdict |

**Resume walks forward to the first phase that is NOT terminal ({`accepted`, `skipped`})** — never
the first non-`done`. So a phase the executor self-considered "done" but that
crashed _before its cross-model audit_ is **re-validated** on resume, never
silently skipped. This is `acceptance-gate.md` made operational: **a loop can
DRIVE resume, it cannot ACQUIT a phase past itself.**

The split is enforced in code, not just docs: `set_status()` may only write
`running/done/failed/skipped`; only `start()` writes `pending`; only `accept()`
writes `accepted`, and it **requires** a non-empty `verdict_id` + `reviewer` —
you cannot mark a phase accepted without recording who acquitted it. (A
`done`-but-never-`accepted` phase is therefore _structurally_ visible as an
unmet acceptance obligation.)

Terminal states are immutable. `set_status()` cannot move an `accepted` or
`skipped` phase back into execution. Repeating `accept()` with the same verdict
and reviewer is idempotent; conflicting acceptance provenance is rejected.

## Who may call `accept`

Only:

- a **cross-model reviewer** verdict (codex/gemini, per `reviewer-independence.md`)
  — `reviewer="codex-gpt-5.5"`, `verdict_id=<thread/trace id>`; or
- a **deterministic verifier** — `verify-papers.js`, a passing test suite, a
  compile that exits 0, a file-exists check for a purely mechanical phase.
  Record it as `reviewer="deterministic:verify-papers.js"` so the audit trail
  shows acceptance was not a model self-report (per `fan-out-pattern.md`: a
  deterministic verifier is a valid jury; a process is not a model family).

The **executor (Claude) must never call `accept` on its own self-report.** Marking
your own phase done is fine (`set done`); acquitting it is not. `accept` records
the `reviewer` and warns loudly if it looks like the executor's own family
(a `claude*` reviewer ≈ self-acquittal). Record `verdict_id` as a **durable
handle** — the reviewer thread/trace id, or the path/sha of the verifier's report
(e.g. `.aris/audit-verifier-report.json`) — not just a label, so the acceptance
is auditable later.

**Concurrency:** one orchestrator per run (single-writer contract). All mutations
use an advisory file lock (`O_EXCL` lock file with ownership token) around a
load-modify-save cycle with atomic temp-file rename. The lock contains a
`PID:timestamp:random` token; release verifies ownership before unlinking.
A lock held by a confirmed-dead local PID is broken immediately; a lock whose
PID is alive is never broken regardless of age. Malformed locks older than 120s
are broken as a last resort. PID ownership is host-local; do not place one run
on a filesystem concurrently written by orchestrators on different hosts.
Concurrent `set` calls from parallel phases on one host serialize correctly.
JSON is validated on load (structure, types, run_id consistency, phase
uniqueness, acceptance provenance) — corrupt state files raise a clear error
instead of silently propagating bad data.

## Helper API / CLI

TypeScript API (exported from `src/tools/run-state.ts`):
```ts
import { startRun, setStatus, accept, resumePoint } from "./run-state.js";
startRun(root, runId, phases)                        // phases: ["W1","W1.5","W2","W3"]
setStatus(root, runId, phase, "running"|"done"|"failed"|"skipped", artifact?)
accept(root, runId, phase, verdictId, reviewer)      // the ONLY path to `accepted`
resumePoint(root, runId)  // -> first NON-TERMINAL phase, or null
```

CLI (via built `dist/tools/run-state.js`):
```
node dist/tools/run-state.js start  <root> <run_id> --phases "W1,W1.5,W2,W3"
node dist/tools/run-state.js set    <root> <run_id> W1 done --artifact idea-stage/IDEA_REPORT.md
node dist/tools/run-state.js accept <root> <run_id> W1 --verdict-id codex:019e... --reviewer codex-gpt-5.5
node dist/tools/run-state.js resume <root> <run_id>   # prints the resume-target phase name on stdout
node dist/tools/run-state.js status <root> <run_id>
```

## Integration pattern for a workflow skill

1. **At run start** (or `— resume <run_id>`): if resuming, `resume_point` gives
   the phase to start at; else `start_run` with the phase list.
2. **Per phase:** `set running` → do the work → `set done --artifact <path>`.
3. **At the phase's gate:** run the phase's existing cross-model audit / jury (or
   deterministic verifier). **Only on a positive verdict** call
   `accept --verdict-id <id> --reviewer <name>`. A failed/ambiguous verdict leaves
   the phase `done` (unaccepted) → it will be re-validated on the next resume.
4. **Resume** therefore re-runs `running`/`failed` phases and **re-audits**
   `done`-but-unaccepted phases, and skips only terminal (`accepted`/`skipped`) ones.

### Paseo driver note (re-attach vs recreate)

> Resume operates under the Global Rule 2 push model: re-attach if
> `list_agents` shows the W-agent alive, else `create_agent` fresh.
> See [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md)
> §"Rule 2" for the parent-child push contract this section
> depends on.

When the workflow runs on the paseo substrate (per
`paseo-subagent-dispatch.md`), each phase's W-agent (and, for verdict phases,
its codex reviewer) is a paseo agent with its own `agentId`. Resume therefore
has one extra decision per phase — **is the phase's agent still alive?**

- `mcp__paseo__list_agents` / `get_agent_status` — is the W-agent (or its
  reviewer) `running` / `idle`?
  - **Alive** → **re-attach**: await its `notifyOnFinish` (do NOT
    `send_agent_prompt` to a running verdict agent — the fence in
    `external-cadence.md` interrupts it via `replaceRunning`). The agent
    completes its in-flight round and notifies; the orchestrator then reads
    the receipt and runs the gate.
  - **Dead / archived** → `create_agent` fresh. The W-agent's startup reads
    `REVIEW_STATE.json` / `PAPER_IMPROVEMENT_STATE.json` and resumes from saved
    round+1, recreating the codex reviewer by its persisted agent-id
    (`threadId` field) if still alive
    (continuation preserved), else a fresh codex agent. Reviewer memory may be
    lost when a fresh agent is required; trace files remain available.

The `verdict_id` recorded at `accept` is either the paseo codex agent id or the
verifier-report path and hash for deterministic phases. Resume treats the
stored value as an opaque handle and checks live agents with `list_agents`.

**Reclaim the dead agent's watchdog by archiving it.** A resuming agent comes
back with a **new** agent id, and `delete_heartbeat` is creator-only — it
cannot delete the watchdog the dead agent armed on itself. Do not try:
`archive_agent` the dead agent instead. Paseo then fails that schedule's next
tick with a target-gone error and completes the schedule itself, so nothing is
orphaned. The resuming agent arms its own watchdog and writes a fresh
`handles/dispatch-watch.<new_agent_id>.json`; the stale handle file from the
dead agent can be deleted with it. See
[`external-cadence.md`](external-cadence.md) §"Paseo heartbeat bounds
convention".

## Cross-references

- `acceptance-gate.md` — the source rule (`done` = execution-completeness, safe
  same-model; `accepted` = quality/correctness, must be cross-model or
  deterministic). This file is that rule applied to multi-phase resume.
- `external-cadence.md` — `/loop` / `/schedule` may _trigger_ a resume (fire-control)
  but the acceptance status is owned by the gate, not the scheduler.
- `reviewer-independence.md` — the `accept` verdict comes from a fresh cross-model
  thread (paths only), and its id is recorded for audit.

> Shape inspired by NousResearch/hermes-agent's resume-resolves-forward insight
> (`hermes_state.py` resolve_resume_session_id). ARIS's increment: Hermes's phase
> is execution-driven only ("the agent finished → resumable"); ARIS adds the
> `accepted` gate so resume cannot carry a self-judged-but-unverified phase forward.
