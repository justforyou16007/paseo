# External Cadence

External schedulers — `/loop`, `/schedule`, `CronCreate`, and any
wall-clock "wake me every N minutes" mechanism — decide **WHEN** an
agent wakes up. They do not, and must not, decide **WHO** judges the
work or **WHETHER** a result is accepted.

## Core Principle

**External cadence is pure fire-control. It is never a jury.**

A scheduler picks the firing moment. It points the agent at a task at a
chosen time. It has no opinion on correctness, quality, novelty, or
publishability, and it must never silently re-spawn an agent or drop a
verdict step in order to stay cheap or finish faster.

Rule of thumb: **cadence can DRIVE; it cannot ACQUIT.** This is the
fire-control corollary of the acceptance-gate rule
(`acceptance-gate.md`): a goal/loop may keep an agent going, but the
STOP/ACCEPT decision still belongs to whoever the acceptance gate
assigns it to — for quality/correctness verdicts, that is always a
different model family (`reviewer-independence.md`).

## Known failure mode (why this doc exists)

External cadence is genuinely useful for one shape of work — waiting on
the external world — and genuinely harmful for another — wrapping
ARIS's own internal semantic loops. The two look superficially similar
("run this skill again later"), so people reach for `/loop` on both. The
harmful case has a specific pathology:

- **Verdict re-run on a wall-clock timer.** Wrapping
  `/auto-review-loop` in `/loop 30m` does not produce 30-minutes-better
  review. It re-runs a verdict-bearing skill on a clock that has nothing
  to do with whether the artifact changed. Zero new signal, full token
  cost.
- **Thread discontinuity.** ARIS's multi-round review skills carry state
  across rounds in the same Paseo reviewer child and its accumulated
  `REVIEWER_MEMORY` so the reviewer can check resolution against its _own_
  prior critique (`reviewer-independence.md`, Exception). An external `/loop`
  re-enters the skill from the top each tick and loses that continuation state;
  "did you fix round 1's gap?" becomes unanswerable.
- **Duplicated scheduling.** `/experiment-queue` already runs a
  detached server-side scheduler that polls job status every 60s and
  enforces `depends_on`. Wrapping the queue skill in an external poll
  loop duplicates that scheduler on a second, uncoordinated clock and
  invites wave-transition races the queue was built to prevent.

The fix is a clean split: external cadence for **external-world-wait**,
never for **internal semantic loops**.

## The distinction

|                    | External-world-wait (ADDITIVE)                                    | Internal semantic loop (HARMFUL to wrap)                                                                                         |
| ------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| What it waits on   | A fact in the outside world: job done, metric logged, file landed | A judgment the agent itself produces                                                                                             |
| What advances it   | Reality changing (GPU frees, epoch logs, PDF compiles)            | A model emitting a verdict                                                                                                       |
| Owns its own loop? | No — without cadence a Claude session blocks on `sleep`           | Yes — the skill already iterates internally, carrying its own round-to-round state (a reviewer thread, or fed-forward summaries) |
| Cadence replaces   | A blocking session burning context on a wait                      | Nothing — it only re-spawns and re-judges                                                                                        |
| Acceptance gate    | Machine-checkable existence/completion (safe same-model)          | Quality/correctness (must be cross-model)                                                                                        |

One-liner: **schedule the wait, never the verdict.**

## ADDITIVE cases (external-world-wait shape)

These replace a Claude session that would otherwise sit `sleep`-ing on
an external event. The cadence is the _only_ thing the agent is waiting
for; no semantic judgment is being re-run. ARIS already validated this
pattern in production.

- **GPU / experiment job completion polling.** The monitoring heartbeat
  armed by `/run-experiment` Step 5.5 (per job) and `/experiment-queue`
  Step 3f (per queue): each tick runs the generated skill's
  `ops/job-status.sh` — "is the job done? are the GPUs still busy?" The
  agent wakes, reads status, and either collects or sleeps again. The thing
  it waits on (job exit, GPU free) is external and machine-checkable.
- **WandB anomaly facts.** `ops/job-status.sh` carries the `wandb` fields
  each tick; suspected NaN / divergence is RECORDED as a fact line in the
  monitor tick log (never judged in-tick) and analyzed after termination
  by `/analyze-results` sub-skills (`analysis-convergence`,
  `analysis-training-dynamics`). The cadence exists so the agent does not
  have to hold a session open for the whole training run.
- **Experiment-queue progression visibility.** Periodically surfacing
  _where the queue is_ (N done / N running / N pending) so a human can
  watch overnight progress. Read-only visibility — see the fence below
  on not re-polling the queue's own scheduler.
- **Overnight `research-pipeline` heartbeat.** A non-judgmental wake
  that checks whether the current phase is still advancing and, if a
  phase has stalled, nudges it forward. Heartbeat only — see the
  overnight-pipeline rule below.
- **Daily literature watch.** A once-a-day `/research-lit` or
  `/deepxiv` sweep for new arXiv papers in a tracked direction. The
  external fact is "the world published something new today"; the
  cadence just sets the polling rhythm.

The generated experiment skill's ops make the additive shape explicit:
`ops/job-status.sh` emits one machine-readable JSON object per call, built
_so that_ a low-frequency heartbeat can read completion state cheaply,
without holding a session open. The per-tick line appended to
`.aris/runs/<run_id>.monitor.jsonl` serves the same role for the
heartbeat's own liveness evidence.

### Why these are safe same-model

In every additive case the acceptance gate is **execution-completeness**
— exit code, file exists, N jobs ran, metric logged, PDF compiled. Those
are machine-checkable, so the polling agent may judge them itself
(`acceptance-gate.md`: "self-judging EXECUTION-completeness is safe
same-model"). The cadence never touches a quality/correctness verdict.

## NOISE / HARMFUL cases (wrapping internal semantic loops)

- **`/loop` around `/auto-review-loop`.** The auto-review loop _is_
  already a loop: review → implement fix → re-review, with the reviewer
  holding round-to-round memory in one `threadId`. Wrapping it in an
  external timer breaks that continuity (a fresh `threadId` per tick,
  `REVIEWER_MEMORY` reset) and fires a verdict on wall-clock time
  instead of on artifact change. Pure noise.
- **Polling `/experiment-queue` on a timer.** Duplicates the queue's
  own 60s server-side scheduler on a second clock, racing its
  wave-transition logic. Use the queue's status output for visibility;
  do not run a competing poll loop.
- **Re-asking an agent to "improve the paper" on a timer.** Quality
  does not improve on a schedule. A timed "improve again" with no new
  review signal is token burn — and if the loop also _accepts_ its own
  output to decide whether to stop, it has crossed from fire-control
  into self-acquittal, which the acceptance gate forbids.

## The fence: do NOT wrap these in external cadence

Any **verdict-bearing** skill — one whose output is a judgment of
quality, correctness, support, novelty, or satisfaction — must run on
its own internal cadence with its own round-to-round state (a persistent
reviewer thread, or prior-round summaries fed forward — whichever the skill
uses), and must terminate in the cross-model jury. Never put one inside
`/loop`, `/schedule`, or `CronCreate`:

- `/auto-review-loop` — already loops internally; reviewer carries
  round-to-round memory in one Paseo agent
- `/auto-paper-improvement-loop` — review → fix → recompile loop with its own
  round structure and a fresh-reviewer bias guard each round
- `/research-review` — produces a cross-model review verdict
- `/result-to-claim` — judges whether results support a claim
- `/experiment-audit` — judges experiment integrity
- `/paper-claim-audit` — judges paper-to-evidence fidelity
- `/citation-audit` — judges bibliographic correctness
- `/proof-checker` — judges proof validity across rounds
- `/kill-argument` — adversarial accept/reject verdict

If you find yourself wanting to schedule one of these, the thing you
actually want to schedule is the _external wait that precedes it_ (job
done → then audit once), not the verdict itself.

> **Adjacent but distinct — `/dse-loop`.** It also loops internally, so do
> not wrap it in external cadence either, but for a _different_ reason: its
> stop gate is an **objective machine-checkable metric** ("objective met or
> timeout"), which is Type-A, not a quality verdict — so it is not a
> self-acquittal hazard. The reason not to wrap it is **scheduler
> duplication** (component #4 below), the same reason as `/experiment-queue`,
> not the verdict fence. Its own objective gate is a safe same-model
> self-termination (`acceptance-gate.md`).

## The affordance: natural external-wait surfaces

These are the surfaces external cadence is _for_. They wait on the
outside world and self-judge only machine-checkable completion:

- `ops/job-status.sh` + the monitoring heartbeat — poll for job
  completion / progress (armed by `/run-experiment` Step 5.5 and
  `/experiment-queue` Step 3f)
- `ops/query-resources.sh` — poll for resource availability
- `/experiment-queue` — **visibility only** (report position); never a
  re-poll that competes with its own scheduler
- overnight `/research-pipeline` — a **non-judgmental heartbeat + nudge**
  (see next), never a quality gate

## The overnight-pipeline rule

An overnight `research-pipeline` heartbeat may wake on a cadence,
detect that a phase has **stalled** (no progress since last tick,
process died, waiting on a freed resource), and **nudge** it forward —
unblock a stuck step, restart a dropped job, prod a phase to continue
("搞快点"). That is fire-control: it changes _when/whether work
resumes_, not _whether work is good_.

The heartbeat must **NEVER** become a quality gate. It may not decide
that a paper is good enough, that a proof holds, that a claim is
supported, or that a review is satisfied. Every such verdict stays on
its skill's own internal cadence and terminates in the cross-model jury
(`acceptance-gate.md`). The nudge keeps the pipeline moving; it does not
acquit the work the pipeline produces.

One-liner: **a heartbeat may say "keep going," never "good enough."**

### Paseo driver note

When the pipeline runs on the paseo substrate (orchestrator + W-agents as
paseo parent-child agents per `paseo-subagent-dispatch.md`), the **driver** is
the orchestrator session's self-target `create_heartbeat`. `/loop` and
`CronCreate` are not ARIS scheduling mechanisms.

> The Paseo MCP substrate is **mandatory** for any scheduled run per
> Global Rule 4 in
> [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md) and
> [`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md). If
> `mcp__paseo__create_heartbeat` is unavailable, the schedule MUST
> emit `BLOCKED` and the user must start the agent manually — there
> is no fallback to `/loop` / `CronCreate` for ARIS work.

Two paseo-specific constraints follow directly from
the existing fence and are restated here so a paseo driver author does not
re-derive them, plus a third that bounds the dispatch watchdog:

- **Never `send_agent_prompt` to a running verdict agent.** Paseo
  notifications use `replaceRunning: true`, so a heartbeat prompt to an
  in-flight W2/W3 (or their codex reviewer) would **interrupt** the round it
  is mid-way through — silently corrupting the verdict. The heartbeat may
  `get_agent_status` / read on-disk artifacts to detect a stall, but once a
  verdict agent is `running` it is hands-off until it `notifyOnFinish`-es.
- **Nudge Type-A sub-phases only.** A stalled Type-A sub-phase (a blocked
  experiment job, a dropped monitor) may be nudged (re-dispatch the
  stalled sub-phase's parent (which, as the child's owner, re-dispatches
  its own sub-agent if needed)). A stalled Type-B verdict phase must NOT
  be re-created or
  re-prompted by the heartbeat — the fence forbids it; recovery is a
  human/cron decision, as below.
- **The dispatch watchdog observes; it does not drive.** A watchdog tick may
  read only: `get_agent_status`, `get_agent_activity`, receipts, artifacts.
  Its one permitted write is the continuation prompt the idle-supervision
  sections already sanction — `paseo-subagent-dispatch.md` §"Idle agent
  supervision" for executors, `paseo-reviewer-dispatch.md` §"Idle reviewer
  supervision" for reviewers. It adds no policy of its own. It never prompts
  a `running` agent, and it never **creates** an agent — a re-created verdict
  agent loses reviewer memory or pre-empts the bias guard, which the two
  bullets above forbid. The tick's full procedure lives in
  `paseo-subagent-dispatch.md` §"What the watchdog tick does"; the heartbeat's
  own prompt is one sentence pointing there, so a tick costs one short turn.

**Every level arms its own.** `create_heartbeat` is self-target-only, so a
heartbeat can only ever wake the agent that created it. This is why the
decision matrix's "child is idle waiting for its OWN sub-agent → do nothing"
is safe: that child has its own watchdog and will wake itself. Skip a level
and that level — plus everything above it — loses its recovery path. A single
heartbeat at the top does not cover the chain.

The `iteration-log.js` machinery is identical: the heartbeat writes its
tick line first each tick and records new-finding counts via the canonical
resolver chain. The paseo substrate changes **where the tick comes from**,
not what the tick may do.

## Paseo heartbeat bounds convention (catch a silent death — and bound it)

ARIS arms two kinds of heartbeat. They have different jobs and different
authority, but the same bounds:

| Kind         | Config                    | Default          | What it does                                                                                                                       |
| ------------ | ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **driver**   | `heartbeat_cron`          | `off`            | Advances an overnight pipeline: touches `run_state`, writes the iteration log, nudges stalled Type-A sub-phases. Top-level session. |
| **watchdog** | `dispatch_heartbeat_cron` | `*/30 * * * *`   | Does nothing on a healthy run. Exists so an agent that dispatched a child can wake itself if the finish notification never arrives. |

The watchdog is not optional and not a poll. **Any agent that calls
`create_agent` and then ends its turn to wait must arm one before ending that
turn** — see `paseo-subagent-dispatch.md` §"Notification-driven feedback loop"
for the arm/cancel steps and why the notification alone is not enough.

A paseo heartbeat is a persisted schedule, not a subscription in the caller's
process — that is exactly why the watchdog is worth arming: it survives the
daemon restart that erases a finish notification. The flip side is that an
ABANDONED heartbeat keeps waking a dead pipeline until something stops it.
Archiving the target agent is one such stop (paseo completes the schedule
itself when the target is gone), but do not rely on it. Every
`mcp__paseo__create_heartbeat` MUST be bounded:

1. **Name it for upsert idempotence.** Re-arming under the same name replaces,
   not duplicates (`createOrReplace` by `(name, target)`).
   - driver: `name: "monitor-<project>-<exp>"`
   - watchdog: `name: "dispatch-watch-<run_id>-<own_agent_id>"` — **one per
     waiting agent, not one per child.** Same-name re-arm is an overwrite, so a
     per-child name would silently clobber the previous child's watchdog. One
     watchdog per waiting agent also means one id to keep and one to delete.
2. **Bound it at creation.** Even if the terminal branch never runs, the
   heartbeat self-expires.
   - driver: `expiresIn` = the job's `monitor.max_hours`, `maxRuns` =
     ceil(hours×60 / interval minutes).
   - watchdog: `expiresIn` = `dispatch_heartbeat_expires` (default `24h`), and
     **omit `maxRuns`**. A tick that lands while the agent is mid-turn is
     skipped and recorded as a failed run, and failed runs count against
     `maxRuns` — a busy agent would burn its watchdog's budget doing nothing.
3. **Persist the id on disk.** Heartbeats are not listable and
   `delete_heartbeat` is creator-only — the id must live in a file or the
   terminal branch cannot clean up.
   - driver: `handles/<exp>.monitor.json`
   - watchdog: `.aris/runs/<run_id>/handles/dispatch-watch.<agent_id>.json`,
     holding `heartbeat_id`, `agent_id`, `run_id`, `phase`, `armed_at`, and a
     `children` array of `{id, kind, worker_dir, dispatched_at}`. The agent id
     comes from `$PASEO_AGENT_ID`. A tick is a new turn in the agent's
     existing conversation, so the history is still there — but an overnight
     run compacts and a resume may rebuild the agent under a new id, so the
     tick reads this file instead of trusting recall.
4. **Delete on terminal.** The tick that observes the terminal state deletes
   the heartbeat (id from disk) as its last action before stopping. For a
   watchdog, terminal means **no outstanding children left** — not the first
   child finishing.
5. **Write a per-tick state line.** Each healthy tick appends one line to a
   `.aris/runs/<run_id>.monitor.jsonl` — the tick log is the heartbeat's own
   liveness evidence AND the record of machine-checkable facts (suspected
   NaN/divergence markers are recorded here as facts, never judged).

Who arms it: the **agent itself** (create_heartbeat is self-target-only). For
the driver, that is the launching agent as its last action before ending the
turn — `/run-experiment` Step 5.5 per job, `/experiment-queue` Step 3f per
queue. For the watchdog, every dispatching agent at every level.

## Stall detection & forced structural pivot

An overnight loop can spin: each iteration tries a near-variant of the last and gets
diminishing returns. Detect it mechanically and force a _structural_ change — not harder
tuning of the same frame.

- **Count, don't vibe.** Each iteration, record the number of NEW findings (concrete
  added entries — new evidence, a falsified hypothesis, a candidate direction — _not_ a
  subjective "valuable result"). Resolve the helper via the canonical chain
  (integration-contract §2): `.aris/dist/tools/iteration-log.js` → `dist/tools/iteration-log.js`
  (fail if unresolved), then
  `node "$ITER_LOG" note <root> <run_id> <phase> <new_findings> [--direction "..."]`.
  Consecutive zero-finding iterations accumulate a `stale_count` in
  `.aris/runs/<run_id>.iterations.jsonl` — a sidecar that does **not** touch run_state's
  done/accepted state.
- **Forced pivot ladder** (the heartbeat reads the returned `pivot`):
  - `stale_count >= 2` → **pivot structure, not tactics**: change a structural constraint
    (frame / objective / data / representation), not a tactical parameter, and pick a
    direction that differs from every one already tried.
  - `stale_count >= 4` → **escalate to a human** (flag for attention; stop nudging blindly).
- **Direction diversity.** Before a re-generation, read the tried directions (research-wiki
  Failed Ideas + the iteration ledger) and reject a candidate too close to one already tried.

This is a Type-A signal — it counts findings and changes _direction_, it never _judges
quality_ ("keep going / change direction," never "good enough"; quality stays with the
cross-model jury, acceptance-gate.md). Why structure over tactics: when a task stalls
repeatedly inside one frame, the decisive gain comes from correcting the frame itself, not
from tuning parameters harder within it.

## Required components (when you add external cadence to a skill)

1. **Waits on an external fact, not a self-verdict.** State the fact in
   one observable line: "job exit code present," "epoch logged to
   WandB," "PDF exists." If the thing being waited on is a model's
   judgment, cadence is the wrong tool.
2. **No verdict in the loop body.** The scheduled body may _report_
   status and _trigger the next external step_; it may not run a
   verdict-bearing skill (see the fence) as part of deciding whether to
   continue.
3. **Self-judges only machine-checkable completion.** The wake's
   accept/sleep decision must rest on exit code / file existence / count
   — never on quality or correctness (`acceptance-gate.md`).
4. **Does not duplicate an existing internal scheduler.** If the target
   already runs its own loop or server-side poller (auto-review-loop,
   experiment-queue), do not wrap it — use its status output.
5. **Preserves thread continuity for any judgment it precedes.** If the
   external wait ends in a verdict step, that verdict step runs _once_,
   in its own thread, after the wait clears — not re-entered per tick.
6. **No scheduler means cadence is blocked.** Do not replace a missing
   `/loop` / `CronCreate` with a blocking poll, a manual poll command, or a
   hidden re-invocation. The caller must explicitly disable cadence or stop.

## Autonomous-mode discipline (when the human checkpoint is off)

When a skill runs with its human-checkpoint toggle OFF (e.g. `AUTO_PROCEED=true`) or under
an external heartbeat, it must not stall by ending on a question. Resolve a routine
ambiguity yourself, act, and log the decision and its reasoning (a `level=decision` log
line) so the choice is auditable — "ready means execute": finishing preparation and then
asking "should I proceed?" is the stall this rule forbids.

This does **not** override an _explicit_ human gate. A checkpoint the skill declares as
load-bearing — a missing venue/target, a patent/submission step, anything marked as
requiring sign-off — still stops and waits. If you are unsure whether a gate is explicit, treat it as explicit and stop. Autonomy removes _needless_ pauses, not
deliberate ones; and it never lets the loop self-acquit a quality verdict (that stays with
the cross-model jury, see [`acceptance-gate.md`](acceptance-gate.md)).

## Heartbeat idle supervision (notification-driven)

The heartbeat's stall-detection responsibility uses the
**notification-driven** model, not polling:

1. The heartbeat checks child agent status via `get_agent_status` only
   when a child's `notifyOnFinish` notification has **not arrived within
   the expected window** (`max_phase_idle` in CLAUDE.md `## ARIS Paseo`).
   For a dispatch watchdog the tick interval **is** that window: keep
   `dispatch_heartbeat_cron` equal to `max_phase_idle` (defaults: `*/30` and
   `1800`), so a tick landing at all means the window has expired. Ticking
   more often than `max_phase_idle` just burns turns finding "not idle long
   enough yet."
2. It does NOT poll on a fixed sub-interval — it relies on the push
   notification as the primary signal. If no finish notification has
   arrived by the time `max_phase_idle` expires, the heartbeat
   investigates.
3. When checking an agent that appears idle, it follows the decision
   matrix in [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md)
   §"Idle agent supervision" — that matrix is the single owner of the
   per-state action; do not re-derive it here. The heartbeat adds no policy
   of its own, and its writes stay inside the fence above.
4. **The heartbeat never does the child's work.** Continuing a stalled child
   is a prompt to that child. Implementing the child's task inside the tick,
   or spawning a replacement to do it, is not — that is the child's owner's
   decision, and if the matrix says the child is unrecoverable the tick
   reports BLOCKED and escalates.

## Cross-references

- `acceptance-gate.md` — who is allowed to ACCEPT. Cadence drives;
  it does not acquit. The overnight nudge is bound by this rule.
- `fan-out-pattern.md` — fan-out and cadence are explicit runtime choices;
  neither creates a second completion path.
- `reviewer-independence.md` — why wrapping a multi-round review in an
  external timer breaks reviewer thread/memory continuity.
- `experiment-integrity.md` — the executor never judges its own
  experiment; a scheduled poll never upgrades to an integrity verdict.
- `paseo-subagent-dispatch.md` — idle agent supervision decision matrix
  and notification-driven feedback loop. The heartbeat follows these
  rules for stall detection and escalation.
