## ARIS Paseo

> This section configures the ARIS pipeline's **execution substrate** — the
> paseo parent-child agent layer that dispatches W1–W6 workflows and the
> cross-model reviewer. Paseo MCP is required; an unavailable substrate
> blocks the current phase.
>
> These variables are **orthogonal** to `effort` / `assurance` (which control
> depth + submission gating) and to the existing `— reviewer:` /
> `REVIEWER_DIFFICULTY` / `REVIEWER_BACKEND` directives (which select the
> reviewer backend; the default `codex` now selects a paseo codex agent).
> Paste this block into your project's `CLAUDE.md` and edit the values.

```yaml
# --- Execution substrate (paseo parent-child agents) ---
orchestrator_provider: claude/sonnet-4-6 # the /research-pipeline session itself
executor_provider: claude/sonnet-4-6 # W1–W6 + claude sub-agents
executor_mode: bypassPermissions # bypassPermissions (overnight default) | auto | plan
executor_thinking: # (omit = model default; set "xhigh" only when a skill demands)

# --- Cross-model reviewer (GPT-5.5) ---
reviewer_provider: codex/gpt-5.5 # the codex reviewer sub-agent
reviewer_mode: full-access # full-access | auto | read-only
reviewer_thinking: xhigh # codex reasoning_effort (verify via list_models)

# --- Dispatch / lifecycle ---
notify_on_finish: true # child notifies parent; parent ends turn, notification re-invokes it
subagent_workspace: current # current (shared project dir) | worktree (isolated, for experiment runs)
dispatch_heartbeat_cron: "*/30 * * * *" # self-armed watchdog per dispatch; off = disabled (not recommended)
dispatch_heartbeat_expires: 24h # watchdog self-destruct; no maxRuns — busy ticks would burn it

# --- Overnight heartbeat (Type-A only; see external-cadence.md fence) ---
heartbeat_cron: off # cron e.g. "*/13 * * * *"; off = no heartbeat
heartbeat_max_runs: # (omit = unbounded; paseo 7-day auto-expiry still applies)

# --- Idle supervision ---
max_phase_idle: 1800 # seconds before idle child triggers supervision check (default 30 min)
```

### What each variable does

| Variable                | Default             | Meaning                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrator_provider` | `claude/sonnet-4-6` | The `/research-pipeline` session's provider/model (this is the session you are in).                                                                                                                                                                                                                                                                          |
| `executor_provider`     | `claude/sonnet-4-6` | W1–W6 workflow agents and their claude sub-agents. Same family as the orchestrator by design.                                                                                                                                                                                                                                                                |
| `executor_mode`         | `bypassPermissions` | `bypassPermissions` (overnight, no approval round-trips — the default) · `auto` (workspace-write, on-request approvals) · `plan` (read-only planning, never for a phase that writes artifacts).                                                                                                                                                                            |
| `executor_thinking`     | (model default)     | claude agent `thinkingOptionId`. Omit for the model default; set `xhigh` only when a skill explicitly demands it.                                                                                                                                                                                                                                            |
| `reviewer_provider`     | `codex/gpt-5.5`     | The cross-model reviewer sub-agent. **Must be a different family from the executor** — the cross-model invariant (`reviewer-independence.md`).                                                                                                                                                                                                               |
| `reviewer_mode`         | `full-access`       | codex agent sandbox: `full-access` (autonomous repo read, network on — the default) · `auto` (workspace-write, on-request) · `read-only` (cannot write the verdict file — do not use for reviewers). `auto-review` is Codex's _internal_ guardian, not the ARIS reviewer.                                                                    |
| `reviewer_thinking`     | `xhigh`             | codex `reasoning_effort`. Verify the exact id for `gpt-5.5` via `mcp__paseo__list_models` / `inspect_provider`.                                                                                                                                                                                                                                              |
| `notify_on_finish`      | `true`              | Push model: children notify the parent on completion via `notifyOnFinish`; the parent ends its turn and the notification re-invokes it. Keep `true`.                                                                                                                                                                                                       |
| `subagent_workspace`    | `current`           | `current` = children share the project dir (all artifacts + `.aris/` land together — the default). `worktree` = each child gets an isolated git worktree (use for experiment runs that mutate the repo; the parent merges).                                                                                                                                  |
| `max_phase_idle`        | `1800`              | Seconds before an idle child triggers supervision check (default 30 min). After this timeout, the heartbeat checks the child's status via `get_agent_status` and follows the idle-supervision decision matrix in `paseo-subagent-dispatch.md`. Keep this equal to `dispatch_heartbeat_cron` — they are the same window expressed two ways; change one, change the other.                                                                                                             |
| `dispatch_heartbeat_cron` | `*/30 * * * *`    | The **watchdog**. Every agent that dispatches a child and ends its turn to wait arms one of these on itself first (`create_heartbeat` is self-target-only, so every level arms its own). On a healthy run each tick just confirms the child is still `running` and ends the turn. It exists because the finish notification is an in-memory subscription that a daemon restart erases — without a watchdog, a lost notification freezes that agent and everything above it, indistinguishably from normal waiting. Bounds and arm/cancel steps: `external-cadence.md`. |
| `dispatch_heartbeat_expires` | `24h`            | `expiresIn` for the watchdog, so an abandoned one self-destructs. Deliberately no `maxRuns`: a tick that lands while the agent is mid-turn is skipped and recorded as a failed run, and failed runs count against `maxRuns` — a busy agent would exhaust its own watchdog.                                                                                                                                                                                                          |
| `heartbeat_cron`        | `off`               | The orchestrator self-heartbeat — the overnight **driver**, not the watchdog above. Type-A only: touch `run_state`, `iteration-log.js note`, nudge stalled Type-A sub-phases. **FORBIDDEN** by the fence (`external-cadence.md`): creating/re-creating W2/W3/W5/W6, `send_agent_prompt` to a running verdict agent, calling `accept`, quality verdicts. `off` = no driver; the watchdog is unaffected and stays on. |
| `heartbeat_max_runs`    | (unset)             | Bounds the driver heartbeat (paseo's own 7-day auto-expiry still applies). Omit for unbounded overnight runs.                                                                                                                                                                                                                                                |

### Coexistence with existing CLAUDE.md sections

- Existing `## Pipeline Status`, `## Project Constraints`, and `## Compute Budget`
  sections remain separate from this block.
- `effort` and `assurance` remain independent controls.
- `— reviewer:`, `REVIEWER_DIFFICULTY`, and `REVIEWER_BACKEND` pass through to
  the reviewer routing contract. The default `codex` selects a Paseo codex
  agent; `oracle-pro`, `agy`, and `manual` use their explicit MCP backends.
- Feishu, W&B, and GPU sections remain separate from this block.

### See also

- `skills/shared-references/paseo-subagent-dispatch.md` — executor sub-agent spawn shape, two continuity modes, fanout discipline, lifecycle, provider resolution, idle supervision, notification-driven feedback.
- `skills/shared-references/paseo-reviewer-dispatch.md` — codex reviewer spawn shape, fresh-vs-continuation rule, `save_trace.sh` `--thread-id` contract, reviewer provider resolution, idle supervision.
- `skills/shared-references/external-cadence.md` — the fence, the driver/watchdog heartbeat bounds convention, heartbeat idle supervision rules.
- `docs/PASEO_MIGRATION.md` — current Paseo parent-child runtime contract.
