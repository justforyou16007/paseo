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
  across rounds in the reviewer's own thread: `codex-reply` reuses the
  round-1 `threadId` and the accumulated `REVIEWER_MEMORY` so the
  reviewer can check resolution against its _own_ prior critique
  (`reviewer-independence.md`, Exception). An external `/loop` re-enters
  the skill from the top each tick, starting a _fresh_ `threadId`. The
  reviewer loses its memory of what it already flagged; "did you fix
  round 1's gap?" becomes unanswerable.
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

- **GPU / experiment job completion polling.**
  `/monitor-experiment` + `/check-gpu` on a cadence: "is the job done?
  are the GPUs still busy?" The agent wakes, reads status, and either
  reports done or sleeps again. The thing it waits on (job exit, GPU
  free) is external and machine-checkable.
- **WandB anomaly checks.** `/training-check` is _already_ cron-wired:
  its SKILL.md sets itself up via `CronCreate` ("do not ask the user
  whether to set it up — just set it") to read WandB metrics every N
  minutes and catch NaN / divergence / idle GPUs early. The cadence
  exists so the agent does not have to hold a session open for the whole
  training run.
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

ARIS's own `tools/watchdog.py` makes the additive shape explicit: it
aggregates per-task status into a `summary.txt` whose header documents
it as a "one-line-per-task summary for CronCreate polling." The
artifact is built _so that_ an external low-frequency poller can read
completion state cheaply, without holding a session open.

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
  round-to-round memory in one `threadId` (`codex-reply`)
- `/auto-review-loop-llm`, `/auto-review-loop-minimax` — same loop, alternate
  reviewer backend; same internal round cadence (each round's prior-round
  summary is fed into the next prompt — a stateless per-round API call, not a
  shared thread, but still verdict-bearing and self-iterating)
- `/auto-paper-improvement-loop` — review → fix → recompile loop with its own
  round structure and a fresh-reviewer bias guard each round (no `codex-reply`)
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

- `/monitor-experiment` — poll for job completion / progress
- `/check-gpu` — poll for GPU availability and running processes
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
the orchestrator session's self-target `create_heartbeat`. The **doctrine
above is unchanged** — only the mechanism that delivers the tick is paseo's,
not `/loop` / `CronCreate`.

> The Paseo MCP substrate is **mandatory** for any scheduled run per
> Global Rule 4 in
> [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md) and
> [`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md). If
> `mcp__paseo__create_heartbeat` is unavailable, the schedule MUST
> emit `BLOCKED` and the user must start the agent manually — there
> is no fallback to `/loop` / `CronCreate` for ARIS work.

Two paseo-specific constraints follow directly from
the existing fence and are restated here so a paseo driver author does not
re-derive them:

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

The watchdog + `iteration_log.py` machinery is identical: the heartbeat
writes its state file first each tick, registers with the watchdog, and
records new-finding counts via the canonical resolver chain. The paseo
substrate changes **where the tick comes from**, not what the tick may do.

## Loop self-heartbeat + watchdog liveness (catch a silent death)

A `/loop` or `CronCreate` heartbeat is parasitic on a living session; if it dies
(context compaction, session close) nothing notices. Two-part convention:

1. **Write a heartbeat first.** As the FIRST action of every iteration, rewrite
   (or `touch`) the loop's state file (`*_STATE.json` / `run_state.json` / a tiny
   `last_seen` file) so its mtime advances each tick _before_ any work that might hang.
2. **Register it with the watchdog** at startup, and **unregister on completion**:
   ```bash
   node "$WATCHDOG" --register      '{"name":"<run_id>","type":"loop","state_file":"<the heartbeat file>","stale_after_seconds":21600}'
   # on completion: node "$WATCHDOG" --unregister "<run_id>"
   ```
   where `WATCHDOG` resolves through the canonical chain (integration-contract §2):
   `[ -f "$WATCHDOG" ] || WATCHDOG="dist/tools/watchdog.js"`
   `[ -f "$WATCHDOG" ] || WATCHDOG="${ARIS_REPO:-}/dist/tools/watchdog.js"`.
   `stale_after_seconds` is the loop's OWN tolerance — set it to **comfortably exceed
   the longest single iteration/operation** (≈ a few × the tick interval), **never** the
   watchdog poll interval. The watchdog writes **STALE** to `summary.txt` + `alerts.log`
   (which your poll already reads) when the file's mtime is older than that; a finished
   loop shows **COMPLETED** (if its state carries a terminal `status`) or should be
   unregistered. **It only DETECTS** — it never restarts the loop or re-runs a
   verdict-bearing skill; recovery stays a human/cron decision, per the fence above.

## Stall detection & forced structural pivot

An overnight loop can spin: each iteration tries a near-variant of the last and gets
diminishing returns. Detect it mechanically and force a _structural_ change — not harder
tuning of the same frame.

- **Count, don't vibe.** Each iteration, record the number of NEW findings (concrete
  added entries — new evidence, a falsified hypothesis, a candidate direction — _not_ a
  subjective "valuable result"). Resolve the helper via the canonical chain
  (integration-contract §2): `.aris/tools/iteration_log.py` → `tools/iteration_log.py` →
  `$ARIS_REPO/tools/iteration_log.py` (warn-and-skip if unresolved), then
  `python3 "$ITER_LOG" note <root> <run_id> <phase> <new_findings> [--direction "..."]`.
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
6. **Degrades gracefully when no scheduler exists.** External cadence is
   additive runtime sugar, never load-bearing. On a runtime with no
   `/loop` / `CronCreate`, the same work still terminates correctly via
   a blocking poll or a manual re-invocation; the cross-model jury at
   the end is identical either way (`fan-out-pattern.md`).

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
   the expected window** (configurable via `max_phase_idle` in CLAUDE.md
   `## ARIS Paseo`).
2. It does NOT poll on a fixed sub-interval — it relies on the push
   notification as the primary signal. If `wait_for_agent` has not
   returned by the time `max_phase_idle` expires, the heartbeat
   investigates.
3. When checking an agent that appears idle, it follows the decision
   matrix in [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md)
   §"Idle agent supervision":
   - Child waiting for its own sub-agent → do nothing.
   - Child stalled with no sub-agents → send continuation prompt.
   - Child errored → report BLOCKED.
4. **The heartbeat never does the child's work.** If a child is stalled,
   the heartbeat continues it or escalates — it never implements the
   stalled task itself.

## Cross-references

- `acceptance-gate.md` — who is allowed to ACCEPT. Cadence drives;
  it does not acquit. The overnight nudge is bound by this rule.
- `fan-out-pattern.md` — fan-out (and cadence) are runtime accelerants
  for a prompt-level pattern; both must degrade gracefully and always
  terminate in the identical cross-model jury.
- `reviewer-independence.md` — why wrapping a multi-round review in an
  external timer breaks reviewer thread/memory continuity.
- `experiment-integrity.md` — the executor never judges its own
  experiment; a scheduled poll never upgrades to an integrity verdict.
- `paseo-subagent-dispatch.md` — idle agent supervision decision matrix
  and notification-driven feedback loop. The heartbeat follows these
  rules for stall detection and escalation.
