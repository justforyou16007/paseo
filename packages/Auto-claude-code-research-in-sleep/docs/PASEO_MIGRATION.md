# ARIS Current Paseo Runtime

This document describes the current ARIS runtime. Use it together with the
active skills and shared contracts. It contains no alternate runtime or
retired feature instructions.

## Runtime model

The user's session is the orchestrator. It owns the run id, phase order,
acceptance decisions, and final handoff. Work executes through Paseo
parent-child agents:

| Responsibility | Current owner |
| --- | --- |
| Stage orchestration | The user's session plus `run-state.js` |
| Research worker | A Paseo Claude child created for the stage |
| Cross-model review | A Paseo Codex child selected by the review contract |
| Deterministic gate | The named helper and its receipt |
| Heartbeat | Type-A liveness checks only; it does not create quality verdicts |

All children use the current workspace and write into the same project
artifacts. A parent waits for the child notification, reads the receipt, runs
the gate, and then accepts or blocks the phase.

## Current dispatch rules

Use the Paseo agent tools for every worker and reviewer dispatch:

```text
mcp__paseo__create_agent
mcp__paseo__send_agent_prompt
mcp__paseo__get_agent_status
mcp__paseo__archive_agent
```

Create a new child for an independent task. Continue the same child only when
the active skill explicitly requires reviewer memory across rounds. A running
quality reviewer is not interrupted by a heartbeat.

The default cross-model reviewer is the Paseo Codex child. Oracle, Gemini,
Antigravity, or Manual Review are explicit reviewer choices. The selected
reviewer is never replaced automatically when it is unavailable or fails.

Every reviewer call records its model, agent id, prompt, response, and verdict
trace. A missing trace or missing verdict blocks the review phase.

## Worker manifest

Every orchestrated worker receives one `input-manifest.json`. The manifest is
the complete input authority for that worker:

```json
{
  "worker": "<skill-name>",
  "iteration": 1,
  "run_id": "<run-id>",
  "inputs": {},
  "context": {},
  "output_dir": ".aris/runs/<run-id>/workers/<worker>/outputs"
}
```

The worker must:

1. read only the paths declared by the manifest;
2. write declared artifacts under `output_dir`;
3. write exactly one `receipt.json` beside the manifest;
4. report `status: done` only when its artifact and checks exist;
5. report `status: failed` with the action and reason when any required step fails.

The orchestrator accepts a phase only after the receipt identity, artifact
paths, verdict fields, and dashboard patch pass `dashboard-merge.js`.

## State and output paths

Run state lives under:

```text
.aris/runs/<run-id>/run-state.json
.aris/runs/<run-id>/dashboard.json
.aris/runs/<run-id>/workers/<iteration>-<worker>/input-manifest.json
.aris/runs/<run-id>/workers/<iteration>-<worker>/receipt.json
.aris/runs/<run-id>/workers/<iteration>-<worker>/outputs/
.aris/traces/<skill>/<run>/
```

Workers use the current manifest-bound output directory. They do not scan the
project root for a similarly named result, copy an earlier stage's artifact,
or reset missing state without an explicit `fresh` request.

`resume` continues at the first non-terminal phase. A completed but unaccepted
phase is validated again. `skipped` is used only for an explicit configuration
decision, such as `AUTO_WRITE=false`; it is never used to hide a failed phase.

## Failure contract

For an enabled integration, the named helper and artifact are required. A
missing helper, non-zero helper exit, malformed input, unreadable evidence, or
failed gate stops the current phase and writes a failed receipt.

The current runtime does not:

- switch to another model, provider, source, CLI, transport, or directory;
- recreate an artifact inline when its helper failed;
- turn an incomplete result into a successful partial report;
- read project-root results when the manifest is incomplete;
- silently reset stale state or claim that a skipped check passed.

Three bounded behaviors remain part of the current contract:

1. `/experiment-env-manager` may diagnose an experiment failure, repair the
   configured environment, and retry the same operation according to its
   repair rules. The OOM retry in `/experiment-queue` belongs to this contract.
2. Environment management may inspect approved local, remote, Docker, Vast,
   Modal, GPU, and screen signals to detect an available external target. The
   detector reports what it found; it does not silently change the requested
   research stage into another execution plan.
3. Feishu notification timeout or delivery failure may let the research stage
   continue according to `skills/feishu-notify/SKILL.md`. Notification status
   remains visible in the log.

All other failure paths stop and wait for a new user-directed invocation after
the dependency or input is fixed.

## Phase order

The main research path is:

```text
research-setup
  → idea-discovery
  → experiment-bridge
  → auto-review-loop
  → summary
  → paper-writing (only when AUTO_WRITE=true)
```

Each phase has one worker contract, one receipt, and one acceptance boundary.
Nested skills run inside the phase worker and write only to the worker's
manifest-bound directory.

## Current setup

1. Start the Paseo daemon for the workspace.
2. Run `/aris-update` or build ARIS so `.aris/dist/` or `dist/` contains the
   compiled helpers.
3. Start a research run with `/research-pipeline`.
4. Use `run-state.js status` and the worker receipts to inspect progress.
5. Use `/research-pipeline — resume <run-id>` only after checking the current
   receipt and child status.

The canonical helper lookup is:

```text
.aris/dist/<helper> → dist/<helper>
.aris/tools/<helper> → tools/<helper>
```

This is an installation-location distinction. Once a helper resolves, the
skill uses that helper only.

## Verification checklist

Before accepting a phase, confirm:

- the worker receipt has the matching `worker`, `iteration`, and `run_id`;
- the declared primary artifact exists under the worker output directory;
- the required deterministic gate has passed;
- the reviewer trace and model identity are present when review is enabled;
- the dashboard patch contains only fields allowed for that worker;
- no required source, evidence, experiment, or audit was silently omitted.

The source of truth for helper behavior is
[`skills/shared-references/integration-contract.md`](../skills/shared-references/integration-contract.md).
The source of truth for worker receipts is
[`skills/shared-references/worker-manifest.md`](../skills/shared-references/worker-manifest.md).
