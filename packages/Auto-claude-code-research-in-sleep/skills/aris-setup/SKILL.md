---
name: aris-setup
description: 'The single human entry point for configuring an ARIS project end to end. Reports which of the five setup stages are done, routes each unfinished one to the skill or command that finishes it, infers the root setup items that existing files already answer, asks for the ones no file contains, and seals the root charter. Use when the user says "配置项目", "setup my project", "aris setup", "全局设置", "初始化整个项目", or when /auto-research-loop stopped because the root charter is missing.'
allowed-tools: Read, Write, Bash(*), AskUserQuestion, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

> **Dispatch watchdog (mandatory).** Every `mcp__paseo__create_agent` in this
> skill is covered by `shared-references/paseo-subagent-dispatch.md`
> §"The dispatch watchdog": arm a self-target watchdog before ending the turn
> to wait, disarm once no awaited child turn remains. The procedure lives
> there, not here.

# ARIS Setup

A formal run needs project basics, a metric target, the experiment environment, reusable tester facilities and a root charter. Configure all five stages; skip stages whose persisted evidence is still ready.

| Stage | Ready when | Owner |
| --- | --- | --- |
| project_basics | CLAUDE.md, RESEARCH_BRIEF.md and research-wiki exist | /research-setup |
| metric_target | Metric Target parses | /research-setup |
| experiment_env | environment manager reports complete and scripts exist | /experiment-env-manager |
| tester_facility | tester-config.json has a matching ready setup receipt and unchanged evidence | /tester-setup |
| root_charter | run.json and charter.json exist | root-setup |

## Resolving the helpers

`project-setup-cli.js`, `tester-facility-cli.js` and
`workflow-tools-cli.js` resolve only through the shared
[integration contract](../shared-references/integration-contract.md)
(`.aris/dist` for installed projects, `dist` for development). A missing or
failed helper is a setup failure. Never hand-write a file a helper produces —
the validation lives in the helper, and a hand-written file skips it.

```bash
SETUP_CLI=".aris/dist/tools/project-setup-cli.js"
[ -f "$SETUP_CLI" ] || SETUP_CLI="dist/tools/project-setup-cli.js"
[ -f "$SETUP_CLI" ] || { echo "ERROR: run /aris-update or build the ARIS runtime." >&2; exit 1; }
```

## Phase 0 — read the state

```bash
node "$SETUP_CLI" status --project "$ROOT" ${RUN_ID:+--run-id "$RUN_ID"}
```

It prints every stage with its evidence, its reason and its `next`, and exits
non-zero while `blocking` is non-empty. **Skip every phase whose stage is
already `ready`** — that is what makes this skill resumable and what keeps it
from re-asking a question the project already answered.

Record progress in `.aris/global-setup-state.json`: `{ "version": 1,
"stages_done": [...], "run_id": "...", "answers": {...} }`. This is deliberately
not `/research-setup`'s `.aris/setup-state.json`. The two have different
lifetimes — one is project initialization, the other is the precondition
contract for a specific run — and sharing a file would let a re-run of
`/research-setup` wipe a sealed run's setup answers.

## Phase 0.5 — install browser-act

Setup is where the external CLI tooling gets installed, while the user is
present to approve a download. Run the ensure helper once, in install mode:

```bash
BROWSER_ACT_ENSURE=".aris/tools/ensure_browser_act.sh"
[ -f "$BROWSER_ACT_ENSURE" ] || BROWSER_ACT_ENSURE="tools/ensure_browser_act.sh"
sh "$BROWSER_ACT_ENSURE"
```

It prints one JSON object and is idempotent — a project that already has the
CLI spends nothing here.

A non-zero exit does not stop setup. `browser-act` is required only by an
experiment environment that declares `browser.required`, and this project has
not answered that question yet (Phase 2 asks it). Print the helper's `hint`,
tell the user it matters only if their experiments read web pages, and go on.
Do not promote this to a gate: the gate belongs where the requirement is known,
which is `/experiment-env-manager` Step 1.3b and Phase 0 step 6. See
[shared-references/browser-act.md](../shared-references/browser-act.md).

## Phase 1 — project basics

Not ready → tell the user to run `/research-setup`, and stop. It is an
interactive wizard with its own state file; by
[Rule 1](../shared-references/paseo-subagent-dispatch.md) a skill does not
invoke another skill in-process, and re-implementing its questions here would
give the project two writers of the same files. When they come back, re-run
Phase 0.

## Phase 2 — experiment environment

Not ready → dispatch it, in the same shape `/research-setup` Phase 7.5 uses:

```
mcp__paseo__create_agent
  title:    "env-manager: setup $PROJECT_SLUG"
  provider: claude
  initialPrompt: "/experiment-env-manager — project: $PROJECT_SLUG — mode: setup"
  notifyOnFinish: true
```

Use the `project_name` from the Phase 0 output as `$PROJECT_SLUG`; it is
computed with the same algorithm `/auto-research-loop` step 0b uses, so a
mismatch here means the loop would not find what the env-manager wrote.

**End the turn after creating the agent.** Resume on the finish notification,
then re-run `status` — env.json is the authority, not the child's report.
Archive the agent afterwards, including when it failed.

## Phase 3 — tester facilities

Dispatch `/tester-setup` through Paseo after Phase 2 finishes. Pass the research brief, metric target, confirmed benchmark/protocol needs and execution resources. An explicit benchmark name is accepted. Use the existing execution account; Docker is optional.

Wait with the dispatch watchdog, collect the setup receipt, archive the worker, then rerun `status`. Require a valid `.aris/tester-config.json`, matching `.setup.json` and verified installation evidence. Failure stops setup at this phase. Do not mark the project ready based on the worker's prose.

On upgrade remove prior ARIS search hooks with `tester-facility-cli.js migrate --project "$ROOT"`; it preserves unrelated hooks. Root setup receives `tester_facility_config` from the installed config. There are no tester deployment/public-key/contract files or search policy stages.

Subsequent iterations dispatch `/tester-test` and `/tester-audit`; they reuse these facilities and never repeat the interactive setup. See [tester-facility.md](../shared-references/tester-facility.md).

## Phase 4 — remaining owner items

```bash
node "$SETUP_CLI" infer --project "$ROOT"
```

Two lists come back and there is no third.

`inferred` — each value carries the file and field it was read from. **Print the
value and its source together** and ask the user to confirm or correct it. A
value whose origin the user cannot see is a value the user cannot check.

`needs_owner` — each entry names an item, a field, and why no file answers it.
Ask every one. In particular: env.json describes how to reach the machine and
start a job, and contains no accelerator model, no memory size, no quota, no
wall-clock ceiling and no egress list. Those are asked, never defaulted — the
frozen inventory is what later separates "the plan asked for hardware that was
never on the list" (a research negative) from "the machine was unreachable" (an
infrastructure fault), and an invented number makes that call wrong silently.

Write every confirmed answer into `.aris/global-setup-state.json` as you go, so
an interrupted questionnaire resumes instead of restarting.

## Phase 5 — assemble and seal

Write the confirmed answers to `.aris/root-setup-answers.json`: the six header
fields (`run_id`, `task_id`, `workflow_id`, `setup_revision`, `problem`,
`expected_output`) plus any item the user confirmed or corrected. Items the user
left as inferred can be omitted — `assemble` merges them in.

The run this hands off to is an Auto Research Loop, so the answers also carry
`mode: "auto_research_loop"`, `max_iterations`, and `max_repair_attempts` /
`max_depth` when the owner sets them. No file answers these: ask the round
limit, never default it. Do not write a `budget`; the loop has none and
`root-setup` refuses one. `assemble` copies these fields through unchanged.

Model usage is not an answer. Ask the owner which models may play which roles
(who generates, who reviews, who may judge whom) and write their reply as prose
under `## Model Usage` in CLAUDE.md, in their words. Every agent in the project
reads CLAUDE.md, and that is the whole mechanism: nothing parses, freezes or
enforces the section. `assemble` refuses a `model_usage_policy` answer so the
rule cannot end up in two places.

```bash
node "$SETUP_CLI" assemble --project "$ROOT" \
  --answers "$ROOT/.aris/root-setup-answers.json" \
  --output  "$ROOT/.aris/root-setup-input.json"
```

`setupRootRun` — the function the sealing command calls — writes nothing until
all six setup items are present:

`tester`, `tester_facility`, `thresholds`, `limits`, `resource`, `baseline`

`collectMissingSetupItems` returns the complete missing list in one response, so
a `SETUP_INCOMPLETE` failure names every gap at once. Go back to Phase 4 for all
of them and re-run; do not fix the first one and try again. An absent key or an
explicit `undefined` counts as missing. An explicit `null` counts as supplied and
is then rejected by the content validator — a different failure with a different
fix, so do not treat one as the other. On re-entry, unchanged confirmation hashes
are reused, so Phase 4 only re-asks about items that were added or changed.

Merge rule: an answer replaces the inferred value key by key, and any array it
supplies replaces that array whole.

Then seal, with the command that has always owned this write:

```bash
node "$WORKFLOW_TOOLS_CLI" root-setup --project "$ROOT" --input "$ROOT/.aris/root-setup-input.json"
```

`assemble` deliberately does not call it. One sealed record, one writer — a
second path into `setupRootRun` would be a second implementation of its
validation.

A sealed root contract is not edited in place. Changing any setup answer changes
the charter digest, and `setupRootRun` refuses the mismatch with
`ROOT_SETUP_SEALED`: the correction goes into a new run, not over the old one.

Re-run `status --run-id "$RUN_ID"` and require `blocking: []`.

## Phase 6 — hand off

Print the five stages with their evidence, and the next command:

```text
/auto-research-loop
```

The handoff reuses the tested facilities. Ordinary runtime repairs do not repeat `/aris-setup`; protocol changes require a new setup version and a new run when its root charter is sealed.
