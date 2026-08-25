# Review Tracing Protocol

## Purpose

Save full prompt/response pairs for every cross-model reviewer call, enabling:

- **Reviewer-independence audit**: verify the executor only passed file paths, not summaries
- **Reproducibility**: threadId preservation allows conversation continuation
- **Meta-optimize input**: richer data for harness improvement analysis

## When to Trace

After **every** cross-model reviewer call that serves a reviewer/critique function — the reviewer is a **paseo codex sub-agent** (`create_agent` fresh / `send_agent_prompt` continuation, per [`paseo-reviewer-dispatch.md`](paseo-reviewer-dispatch.md)). This includes review scoring, experiment auditing, claim verification, idea critique, and patch gating.

Do NOT trace purely informational model calls that do not produce a review or
quality verdict.

> **Paseo note.** `--thread-id` holds the **paseo codex agent-id** returned by
> `create_agent` or stored in `REVIEW_STATE.json`'s `threadId` field. The
> trace's `request.json` `tool` field is `paseo:create_agent`
> (fresh) or `paseo:send_agent_prompt` (continuation). `save_trace.sh` treats
> `--thread-id` as an opaque string, so the helper needs no change.

## Trace Directory

```
.aris/traces/<skill-name>/<YYYY-MM-DD>_run<NN>/
  ├── run.meta.json                      # Run-level metadata
  ├── 001-<purpose>.request.json         # Request snapshot
  ├── 001-<purpose>.response.md          # Full response text
  ├── 001-<purpose>.meta.json            # Response metadata
  ├── 002-<purpose>.request.json         # Second call (e.g., reply)
  └── ...
```

- `<skill-name>`: the ARIS skill that triggered this call (e.g., `auto-review-loop`)
- `<YYYY-MM-DD>_run<NN>`: date + sequential run number (start from `01`)
- `<purpose>`: short kebab-case label (e.g., `round-1-review`, `critique`, `ideation`, `audit`, `patch-gate`)

## How to Trace

After each reviewer MCP call, save the trace using `save_trace.sh`, resolved
through the canonical helper chain in `integration-contract.md` §2. The
helper is required whenever tracing is enabled. If it is missing or fails,
stop the review gate; do not create a second writer or silently continue.
The full invocation:

```bash
# Resolve $TRACE_HELPER (canonical strict-safe chain; see integration-contract.md §2).
_pr=$(git rev-parse --show-toplevel 2>/dev/null) || { _d=$(pwd); while [ "$_d" != "/" ]; do [ -f "$_d/.aris/installed-skills.txt" ] && { _pr=$_d; break; }; _d=$(dirname "$_d"); done; }
cd "${_pr:-$(pwd)}" || exit 1
TRACE_HELPER=".aris/tools/save_trace.sh"
[ -f "$TRACE_HELPER" ] || TRACE_HELPER="tools/save_trace.sh"
[ -f "$TRACE_HELPER" ] || {
  echo "ERROR: save_trace.sh is required for reviewer tracing" >&2
  exit 1
}
bash "$TRACE_HELPER" \
  --skill "<skill-name>" \
  --purpose "<purpose>" \
  --model "<model>" \
  --thread-id "<threadId from response>" \
  --prompt "<full prompt as sent>" \
  --response "<full response content>" || {
    echo "ERROR: save_trace.sh failed; trace was not saved." >&2
    exit 1
  }
```

The helper handles directory creation, run numbering, and file writing. A
missing helper or non-zero exit is a trace failure and stops the gate.

## File Schemas

### `run.meta.json`

```json
{
  "skill": "auto-review-loop",
  "run_id": "2026-04-15_run01",
  "started_at": "2026-04-15T14:30:00+08:00",
  "executor": "claude-code",
  "project_dir": "/path/to/project"
}
```

### `NNN-<purpose>.request.json`

```json
{
  "call_number": 1,
  "purpose": "round-1-review",
  "timestamp": "2026-04-15T14:31:00+08:00",
  "tool": "paseo:create_agent",
  "model": "gpt-5.5",
  "config": { "model_reasoning_effort": "xhigh" },
  "files_referenced": ["paper/sections/3_method.tex", "results/table1.csv"],
  "prompt": "<full prompt text>"
}
```

### `NNN-<purpose>.response.md`

The reviewer's full response, verbatim. No truncation, no summarization.

### `NNN-<purpose>.meta.json`

```json
{
  "call_number": 1,
  "purpose": "round-1-review",
  "timestamp": "2026-04-15T14:33:00+08:00",
  "thread_id": "019d8fe0-b25d-...",
  "model": "gpt-5.5",
  "duration_ms": 142000,
  "status": "ok"
}
```

## Configuration

Tracing respects three modes, set via inline parameter `--- trace: off | meta | full`:

- **`full`** (default): save full prompt + full response
- **`meta`**: save metadata only (no prompt/response text), useful for sensitive projects
- **`off`**: disable tracing entirely

## Integration with events.jsonl

After writing a trace, append a compact summary event to `.aris/meta/events.jsonl`:

```json
{
  "event": "review_trace",
  "skill": "auto-review-loop",
  "purpose": "round-1-review",
  "thread_id": "...",
  "trace_path": ".aris/traces/auto-review-loop/2026-04-15_run01/",
  "status": "ok"
}
```

This allows `/meta-optimize` to discover traces without reading the full trace files.

## Privacy

- `.aris/traces/` should be in `.gitignore` — traces are project-local, never committed
- Traces may contain sensitive research content; treat them as confidential
- Use `--- trace: off` for projects with strict confidentiality requirements
