---
name: aris-setup
description: 'Configure research context, metrics, experiment environment, benchmark facilities, model roles and root run in one editable configuration review. Show current values by module with options and recommendations, refresh grouped edits, ask for one final confirmation, then execute setup. Use for "aris setup", "research setup", "tester setup", "配置项目" or a missing root charter.'
allowed-tools: Read, Write, Bash(*), AskUserQuestion, mcp__paseo__list_models, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

> **Dispatch watchdog (mandatory).** Every child dispatch follows
> `shared-references/paseo-subagent-dispatch.md` §"The dispatch watchdog":
> arm before waiting and disarm after collecting terminal receipts.

# Unified ARIS Setup

`/aris-setup`, `/research-setup` and `/tester-setup` name this same procedure.
Research and tester setup are modules, not additional conversations or workers.
The result is project documents, an audited execution environment, reusable
tester facilities and a sealed root charter for `/auto-research-loop`.

**Interaction contract:** show the complete configuration first; accept edits
to any number of fields together; refresh the whole sheet; finally ask the
owner to confirm the latest complete configuration. Never interview the owner
field by field or module by module. `quick` and `full` legacy arguments use
this same interaction. Read [the configuration and artifact guide](../shared-references/unified-setup.md)
before generating a draft or applying confirmed configuration.

## 1. Discover and show the configuration

Resolve helpers through [integration-contract.md](../shared-references/integration-contract.md):
define its `_find_project_root` resolver, then use installed `.aris/dist` or
development `dist`. Do not hand-write helper-owned receipts, setup state,
environment metadata or root records.

```bash
ROOT="$(_find_project_root)" || exit 1
cd "$ROOT" || exit 1
SETUP_CLI=".aris/dist/tools/project-setup-cli.js"
[ -f "$SETUP_CLI" ] || SETUP_CLI="dist/tools/project-setup-cli.js"
[ -f "$SETUP_CLI" ] || { echo "ERROR: run /aris-update or build the ARIS runtime." >&2; exit 1; }
node "$SETUP_CLI" review --project "$ROOT"
```

The helper seeds `.aris/setup-draft.json` from current project files and prior
answers, writes `.aris/setup-review.md`, and returns modules, field sources,
options, recommendations, all validation issues and execution readiness.
Existing drafts resume unchanged; old `.aris/setup-state.json` is only a
migration source. `.aris/global-setup-state.json` is the single review state.

Present the **entire** review in the project's language, grouped into:

| Module | Content |
| --- | --- |
| Project | Name, language, constraints, non-goals |
| Research | Field, problem, work type, venue, prior work, references, budget and timeline |
| Metric | Primary name, target, direction, tolerance, constraints |
| Baseline | Method, code/run location, expected reading, tolerance |
| Execution | Backend, files, dependencies, browser, resources, commands, feedback, monitoring |
| Tester | Pinned benchmark/data, scoring, execution, setup, healthcheck, smoke, full test and evidence |
| Models | Available providers, execution/reviewer settings, model usage prose and lifecycle |
| Run | Run/task/workflow IDs, revision, outputs, round/depth/repair limits, inventory and W_0 scope |

For every choice field show **current value, source, all options and a
recommendation**. For text/JSON fields show **current value, source and a
concrete suggested description or shape**. Use the guide to replace generic
recommendations with project-specific suggestions, and show unset values as
`待填写 / unset`. Include all missing fields and conflicts in one list.

Read-only discovery may add concrete observations or proposed commands to
the draft, then refresh before displaying it. Mark proposals as proposals.
Model choices come from the available provider/model catalogue; list valid
options and recommend an independent reviewer family. If the catalogue cannot
be read or selected settings are unavailable, show these conflicts on the same
sheet and resolve them before confirmation. The helper's structural readiness
does not verify live model availability. Never invent hardware,
quota, benchmark revisions, full sample counts or measurements. No installation,
downloads, dispatch, generated project files or sealing happen during review.

Finish with one editing invitation: the owner can describe multiple edits in
one reply, edit the JSON draft directly, or accept the displayed suggestions.
Do not replace the sheet with a series of multiple-choice questions.

## 2. Apply grouped edits and refresh

Translate the owner's changes into a JSON patch using module paths. Plain
objects merge, arrays replace the whole list, and `null` clears a value.

```bash
node "$SETUP_CLI" refresh --project "$ROOT" --input "$PATCH_JSON"
# If the owner edited setup-draft.json directly:
node "$SETUP_CLI" refresh --project "$ROOT"
```

Reprint all modules with their refreshed values, options and recommendations.
Summarize changed fields, then show **all** remaining missing fields or
conflicts together. Continue this edit/refresh loop in any order the owner
chooses. Do not ask the original per-field questions after an edit. Recommendations
become draft values only when accepted, and are reviewed again before execution.

`ready_to_confirm: false` means more grouped edits are needed. A successful
review command only means the sheet was generated; it does not mean runtime
setup is ready. Any draft change invalidates a prior confirmation.

## 3. Confirm the whole configuration once

When `ready_to_confirm: true`, show the full latest sheet and its digest,
plus the installation/healthcheck/smoke/sealing actions it authorizes. Ask one
final confirmation: “确认以上整份配置并执行设置，或一次性列出需要修改的项。”
The only decision here is confirm or continue editing; do not launch a new
questionnaire. A request to edit is not confirmation. If the configuration
changed since the owner saw it, refresh, display it and obtain confirmation
of that new version.

After explicit confirmation of the displayed configuration:

```bash
node "$SETUP_CLI" confirm --project "$ROOT" --digest "$REVIEWED_DIGEST"
node "$SETUP_CLI" prepare --project "$ROOT"
RUN_ID=$(jq -er '.configuration.run.run_id' "$ROOT/.aris/setup-inputs/configuration.json") || exit 1
```

`prepare` verifies the current confirmation and writes immutable-for-this-attempt
inputs under `.aris/setup-inputs/` plus `.aris/root-setup-answers.json`. It
does not deploy facilities or seal the root. Do not treat a suggestion, a
legacy checklist confirmation, or an old digest as current approval.

## 4. Execute the confirmed configuration

Follow [unified-setup.md](../shared-references/unified-setup.md) for artifact
mapping, the complete environment PRD and benchmark runner requirements.

1. Generate or merge `CLAUDE.md`, `RESEARCH_BRIEF.md`, `.gitignore` and the
   Wiki from the confirmed `configuration.json`. Preserve unrelated notes and
   existing Wiki history. Setup describes baseline reproduction; iteration 1
   executes it. Do not publish metrics from setup or smoke.
2. Reuse an execution environment only when its effective PRD, backend and
   audit evidence match the confirmed configuration. Otherwise render Paseo
   settings from the confirmed CLAUDE.md block and dispatch one worker:

   ```text
   /experiment-env-manager — project: <discovered project slug> — mode: setup
     — prd: <absolute setup-inputs/environment-prd.json>
     — confirmed-setup: <absolute setup-inputs/configuration.json>
     — run-id: <setup attempt id> — paseo-config: <resolved config path>
   ```

   The worker uses the confirmed PRD and **does not ask setup questions**.
   Follow [Paseo dispatch](../shared-references/paseo-subagent-dispatch.md)
   and its mandatory **dispatch watchdog** before waiting, collect the receipt,
   check actual env.json/audit evidence, then archive the worker. Failure or
   missing requirements returns all defects to this configuration sheet;
   there is no automatic `user_override` or second setup interview.
3. Prepare the declared benchmark runner/data/service files. Resolve
   `tester-facility-cli.js`, then execute the confirmed facility input directly:

   ```bash
   TESTER_CLI=".aris/dist/tools/tester-facility-cli.js"
   [ -f "$TESTER_CLI" ] || TESTER_CLI="dist/tools/tester-facility-cli.js"
   [ -f "$TESTER_CLI" ] || { echo "ERROR: missing tester-facility-cli.js" >&2; exit 1; }
   node "$TESTER_CLI" migrate --project "$ROOT"
   node "$TESTER_CLI" setup --project "$ROOT" --input "$ROOT/.aris/setup-inputs/tester-facility.json"
   ```

   `migrate` removes prior ARIS tester/search hooks and preserves unrelated
   hooks. `setup` owns installation commands, healthcheck, smoke, config and
   setup receipt; unchanged ready facilities can be reused. Require the matching
   receipt and unchanged installation evidence. Do not dispatch `/tester-setup`.
   Use the existing execution account and shared tester facilities. Docker is
   an optional dependency environment. No private store, separate user, signing
   keys, search exclusions or exposure limits are introduced.
4. Assemble and seal using the established helpers:

   ```bash
   WORKFLOW_TOOLS_CLI=".aris/dist/tools/workflow-tools-cli.js"
   [ -f "$WORKFLOW_TOOLS_CLI" ] || WORKFLOW_TOOLS_CLI="dist/tools/workflow-tools-cli.js"
   [ -f "$WORKFLOW_TOOLS_CLI" ] || { echo "ERROR: missing workflow-tools-cli.js" >&2; exit 1; }
   node "$SETUP_CLI" assemble --project "$ROOT" \
     --answers "$ROOT/.aris/root-setup-answers.json" --output "$ROOT/.aris/root-setup-input.json"
   node "$WORKFLOW_TOOLS_CLI" root-setup --project "$ROOT" --input "$ROOT/.aris/root-setup-input.json"
   node "$SETUP_CLI" status --project "$ROOT" --run-id "$RUN_ID"
   ```

   `root-setup` is the sole root writer and requires all six setup items:

   `tester`, `tester_facility`, `thresholds`, `limits`, `resource`, `baseline`

   No loop `budget` or structured `model_usage_policy` is written; model rules are
   CLAUDE.md prose. Require all five readiness stages with `blocking: []`.

Any configuration change needed during execution goes back to grouped edits,
full refresh and final confirmation of the changed version. Retry technical
failures under the unchanged confirmed configuration without repeating the
interview. Never edit a sealed root contract: changed protocol/answers require
a new run ID and revision, which appear in the same review sheet.

## 5. Hand off

Report artifacts and the five stages with evidence. Then show
`/auto-research-loop`. Subsequent evaluations use `/tester-test` followed by
`/tester-audit` before Wiki publication; they reuse the configured facilities
and never invoke setup as an iteration step. See
[tester-facility.md](../shared-references/tester-facility.md).
