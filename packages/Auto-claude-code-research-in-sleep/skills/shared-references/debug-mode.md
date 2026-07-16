# Debug Mode Protocol

When `— debug: true` (or `--debug`) is passed in `$ARGUMENTS`, the
skill runs in **debug mode** — every helper failure pauses execution
and waits for the developer to fix the issue before continuing.

This is designed for end-to-end testing: the developer walks the full
pipeline interactively, fixing each failure as it surfaces, instead of
discovering broken steps hours later.

## Detecting debug mode

At the top of the skill, before any helper resolution:

```bash
DEBUG_MODE=false
case "$ARGUMENTS" in
  *debug:\ true*|*debug:true*|*--debug*) DEBUG_MODE=true ;;
esac
```

## Behavior on helper failure

When **any** of the following occurs and `DEBUG_MODE=true`:

- A resolved helper (`node "$HELPER" ...` / `bash "$SCRIPT" ...`)
  exits non-zero
- A helper is unresolved (empty `$HELPER` after the resolver chain)
- An API call fails after retries
- A file or artifact expected by a step is missing

The executor MUST:

### Step 1 — Write `.aris/debug-halt.json`

```json
{
  "ts": "2026-07-16T12:00:00Z",
  "skill": "idea-creator",
  "phase": "wiki-ingest",
  "error": "research-wiki.js exited with code 1: ENOENT ...",
  "command": "node dist/tools/research-wiki.js ingest_paper ...",
  "exit_code": 1,
  "cwd": "/home/user/project",
  "context": "Ingesting discovered paper into research-wiki",
  "resume_hint": "Check that research-wiki/ exists and dist/tools/research-wiki.js is built"
}
```

### Step 2 — Print the halt message

```
🔴 DEBUG HALT — helper failed, waiting for developer fix.
   Skill:    idea-creator
   Phase:    wiki-ingest
   Command:  node dist/tools/research-wiki.js ingest_paper ...
   Exit:     1
   Error:    ENOENT: no such file or directory ...

   Fix the issue, then send a message to this agent to resume.
   Send "skip" to skip this step and continue.
   Send "abort" to stop the skill entirely.
```

### Step 3 — Stop and wait

Do NOT continue to the next step. Do NOT retry automatically. The
agent stops working and goes idle, waiting for the developer to send
a message via Paseo `send_agent_prompt` (or directly in the agent
window).

### Step 4 — On developer message

| Message     | Action                                                                                |
| ----------- | ------------------------------------------------------------------------------------- |
| *(any text)* | Re-run the failed command. If it succeeds, continue. If it fails again, re-halt.     |
| `skip`      | Skip this helper call entirely. Use the normal failure-policy fallback (Policy B →    |
|             | warn-and-skip; Policy C → write artifacts inline; Policy D → cascade to next source). |
| `abort`     | Print `⛔ Aborted by developer in debug mode.` and stop the skill.                   |

### Step 5 — Clean up on resume

After the failed command succeeds (or "skip"), delete
`.aris/debug-halt.json` before continuing.

## When debug mode is OFF (default)

Helpers follow their normal failure policy (A/B/C/D/E per
[`integration-contract.md`](integration-contract.md) §2). No pause,
no halt file, no waiting.

## Scope

Debug mode overrides **all** failure policies (A through E) when
active. The developer has final say:

- **Fix and resume** = retry the original command
- **Skip** = fall through to the policy's normal non-debug behavior
- **Abort** = stop entirely

The override applies to:
- Unresolved helpers (empty `$HELPER`)
- Resolved helpers that exit non-zero
- API calls that fail after retries
- Missing expected artifacts

It does NOT apply to:
- Successful helper executions
- Informational warnings (`console.error("Warning: ...")` that don't
  indicate failure)

## Orchestrator (research-pipeline) debug mode

When the **orchestrator** runs with `— debug: true` and a W-agent
fails (phase enters `failed` status), the orchestrator:

1. Prints the debug halt message with the W-agent's error details
2. Waits for the developer to fix the underlying issue
3. On developer message: re-dispatches the failed W-agent (fresh
   `create_agent` with the same prompt)
4. On "skip": marks the phase `skipped` and continues to the next
5. On "abort": stops the pipeline

This is distinct from the `HUMAN_CHECKPOINT` constant (which pauses
for review-quality decisions). Debug mode pauses on **failures**, not
on success.

## See also

- [`integration-contract.md`](integration-contract.md) §2 — failure
  policies A–E that debug mode overrides
- [`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md) — idle
  supervision matrix (related but distinct: idle detection checks
  whether a child is stuck; debug mode makes the parent itself pause)
- [`resumable-runs.md`](resumable-runs.md) — run-state tracks
  phase-level status; debug halts are within a phase, not between
