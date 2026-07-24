## ARIS Paseo

> This section configures the ARIS pipeline's **execution substrate** — the
> paseo parent-child agent layer that dispatches W1–W6 workflows and the
> cross-model reviewer. It is **optional**: if absent, the pipeline falls
> back to in-process `Skill`-tool dispatch only (no cross-model codex
> reviewer) with no change to the verdict, audit chain, or acceptance gate
> (`paseo-subagent-dispatch.md` §"Auto-skip-if-unconfigured").
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
reviewer_mode: full-access # full-access (codex exec analog) | auto | read-only
reviewer_thinking: xhigh # codex reasoning_effort (verify via list_models)

# --- Dispatch / lifecycle ---
notify_on_finish: true # child notifies parent; parent calls wait_for_agent
fanout_subagents: true # true = sub-skills → paseo sub-agents; false = in-process fallback
subagent_workspace: current # current (shared project dir) | worktree (isolated, for experiment runs)

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
| `reviewer_mode`         | `full-access`       | codex agent sandbox: `full-access` (autonomous repo read, network on, `codex exec` analog — the default) · `auto` (workspace-write, on-request) · `read-only` (cannot write the verdict file — do not use for reviewers). `auto-review` is Codex's _internal_ guardian, NOT our reviewer.                                                                    |
| `reviewer_thinking`     | `xhigh`             | codex `reasoning_effort`. Verify the exact id for `gpt-5.5` via `mcp__paseo__list_models` / `inspect_provider`.                                                                                                                                                                                                                                              |
| `notify_on_finish`      | `true`              | Push model: children notify the parent on completion via `notifyOnFinish`; the parent calls `wait_for_agent` to receive the notification. Keep `true`.                                                                                                                                                                                                       |
| `fanout_subagents`      | `true`              | `true` = sub-skills dispatch as paseo sub-agents (the migrated behavior). `false` = in-process `Skill`-tool fallback (today's behavior). Set `false` only when the paseo MCP server is unavailable.                                                                                                                                                          |
| `subagent_workspace`    | `current`           | `current` = children share the project dir (all artifacts + `.aris/` land together — the default). `worktree` = each child gets an isolated git worktree (use for experiment runs that mutate the repo; the parent merges).                                                                                                                                  |
| `max_phase_idle`        | `1800`              | Seconds before an idle child triggers supervision check (default 30 min). After this timeout, the heartbeat checks the child's status via `get_agent_status` and follows the idle-supervision decision matrix in `paseo-subagent-dispatch.md`.                                                                                                               |
| `heartbeat_cron`        | `off`               | The orchestrator self-heartbeat (`create_heartbeat`, self-target). Type-A only: touch `run_state`, `iteration_log.py note`, nudge stalled Type-A sub-phases. **FORBIDDEN** by the fence (`external-cadence.md`): creating/re-creating W2/W3/W5/W6, `send_agent_prompt` to a running verdict agent, calling `accept`, quality verdicts. `off` = no heartbeat. |
| `heartbeat_max_runs`    | (unset)             | Bounds the heartbeat (paseo's own 7-day auto-expiry still applies). Omit for unbounded overnight runs.                                                                                                                                                                                                                                                       |

### Coexistence with existing CLAUDE.md sections

- **`## Pipeline Status` / `## Project Constraints` / `## Compute Budget`** — unchanged.
- **`effort` / `assurance`** — unchanged; orthogonal to this block.
- **`— reviewer:` / `REVIEWER_DIFFICULTY` / `REVIEWER_BACKEND`** — pass through unchanged. The default `codex` now selects a paseo codex agent (this block's `reviewer_*`); `oracle-pro` / `agy` / `manual` stay MCP (`reviewer-routing.md`).
- **Feishu / WandB / GPU sections** — unchanged.

### See also

- `skills/shared-references/paseo-subagent-dispatch.md` — executor sub-agent spawn shape, two continuity modes, fanout discipline, lifecycle, provider resolution, idle supervision, notification-driven feedback.
- `skills/shared-references/paseo-reviewer-dispatch.md` — codex reviewer spawn shape, fresh-vs-continuation rule, `save_trace.sh` `--thread-id` contract, reviewer provider resolution, idle supervision.
- `skills/shared-references/external-cadence.md` — the fence, heartbeat idle supervision rules.
- `docs/PASEO_MIGRATION.md` — full mapping from the codex-MCP-and-paseo-MCP fusion to unified paseo parent-child agents.
