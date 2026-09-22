---
name: aris-setup
description: 'The single human entry point for configuring an ARIS project end to end. Reports which of the six setup stages are done, routes each unfinished one to the skill or command that finishes it, infers the root setup items that existing files already answer, asks for the ones no file contains, and seals the root charter. Use when the user says "配置项目", "setup my project", "aris setup", "全局设置", "初始化整个项目", or when /auto-research-loop stopped because the root charter is missing.'
allowed-tools: Read, Write, Bash(*), AskUserQuestion, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

> **Dispatch watchdog (mandatory).** Every `mcp__paseo__create_agent` in this
> skill is covered by `shared-references/paseo-subagent-dispatch.md`
> §"The dispatch watchdog": arm a self-target watchdog before ending the turn
> to wait, disarm once no awaited child turn remains. The procedure lives
> there, not here.

# ARIS Setup

A project is ready for a formal run when six things exist. `/research-setup`
builds the first two and delegates the third. The last three — the tester agent
on its own machine, the search guard compiled from its contract, and the root
charter — had no entry point at all: nothing outside `skills/tester-setup/`
referenced them, so `/auto-research-loop` stopped on a missing charter with no
instruction on how to produce one. This skill is that instruction.

It owns three things and nothing else: **the order**, **the confirmation of
inferred values**, and **where to go when a stage is not ready**. Every
procedure it points at stays where it already lives; this file never restates
one.

| Stage | Ready when | Who makes it ready |
| --- | --- | --- |
| `project_basics` | CLAUDE.md, RESEARCH_BRIEF.md and a non-empty `research-wiki/` | [`/research-setup`](../research-setup/SKILL.md) |
| `metric_target` | CLAUDE.md's `## Metric Target` parses | `/research-setup`, or the block in `templates/CLAUDE_MD_TEMPLATE.md` |
| `experiment_env` | `env.json` says `complete` **and** `scripts/` exists | [`/experiment-env-manager`](../experiment-env-manager/SKILL.md) |
| `tester_agent` | a valid `.aris/tester-agent-config.json` | [`/tester-setup`](../tester-setup/SKILL.md) steps 1-8 |
| `search_guard` | a policy file **and** a ledger whose chain verifies | `search-audit-cli.js emit-policy` then `install-guard` |
| `root_charter` | the run has a `run.json` and a `charter.json` | `workflow-tools-cli.js root-setup` |

Every project that goes through this skill configures all six. There is no
branch that skips the tester: a run whose acceptance is judged by the thing
being judged is not a formal run, so a project with no second machine fails at
Phase 3 rather than getting a downgraded configuration.

## Resolving the helpers

`project-setup-cli.js`, `tester-agent-cli.js`, `search-audit-cli.js` and
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

## Phase 3 — tester and the search gate

This is where the second machine is required. Collect the site facts with
`AskUserQuestion` (one question per fact, no guessing):

| Answer | Used by |
| --- | --- |
| ssh target (`user@host`) and daemon port | probe, deploy |
| remote home / work directory | deploy |
| provider and model for the remote tester agent | deploy |
| local bundle directory to stage the tester's manual in | prepare-bundle |
| **the domain / task description in prose** | declare |

The last one decides what the tester will measure, and it is the one place a
mistake is invisible later. Write a description of the *domain and the task*,
never a benchmark name: what the tester evaluates on is the tester's own
research decision. Naming a benchmark here is handing the exam paper to the
person being examined.

Then run the eight steps of [`/tester-setup`](../tester-setup/SKILL.md) in
order. They are not repeated here. Two conventions this skill pins, because
`emit-config` takes an arbitrary `--output` and the detector has to know where
to look:

```text
--output for deploy       .aris/tester-deployment.json
--output for declare      .aris/tester-submission-contract.json
--output for emit-config  .aris/tester-agent-config.json
```

Step 8's `root-setup` handoff happens in Phase 5 of this skill, not here — by
then the other six items exist.

### What the tester may send back

The response schema exposes coarse `error_analysis`, a signed conclusion, a
signed feedback envelope, and the aggregate value of each metric named in the
frozen `gate.primaries`. It has no defect-list field; do not promise that output
until its producer and validator exist. Declared metrics and fixed coarse
feedback are not experiment evidence and cannot be fed into analysis, evidence
review or a research claim.

That boundary is not enforced by prose. It is two functions, and a response they
did not pass never reaches disk:

`validateTesterAgentResponse` in `src/tools/tester-agent.ts` and
`sanitizeTesterFeedback` in `src/tools/tester-feedback.ts`.

What they refuse — case content, answers, prompts, per-case output and scores,
private observations, fine-grained categories, private URIs — is listed in
[`/tester-setup`](../tester-setup/SKILL.md) under "What comes back". It is not
repeated here.

**Never print the blocklist.** `emit-policy` reports counts and a digest;
`status` reports counts and a digest. Do not read `.aris/search-policy.json`
into the conversation, do not summarize it, do not name an entry in a report.
The only moment a model is meant to see one of those terms is after it has
already typed it and been refused — at which point knowing it adds nothing.

## Phase 4 — the five owner items

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

```bash
node "$SETUP_CLI" assemble --project "$ROOT" \
  --answers "$ROOT/.aris/root-setup-answers.json" \
  --output  "$ROOT/.aris/root-setup-input.json"
```

`setupRootRun` — the function the sealing command calls — writes nothing until
all seven setup items are present:

`tester`, `tester_agent`, `thresholds`, `exposure`, `limits`, `resource`, `baseline`

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

Print the six stages with their evidence, and the next command:

```text
/auto-research-loop
```

Do not print the blocklist, its size, or any term in it. Counts and the policy
digest are the whole public surface.

## What this does not do

- It does not reproduce the baseline. `/auto-research-loop` iteration 1 does
  that through the normal pipeline.
- It does not decide what the tester measures. That is researched on the tester
  machine, from `templates/tester-agent-bundle/TESTER_AGENT.md`.
- It does not seal anything itself. `root-setup` writes the setup record;
  `emit-policy` and `install-guard` write the search gate; this skill only
  orders them and carries the owner's answers between them.
- It does not seal the model role policy. The role table, the separation of
  judge from judged (a workflow-produced judge must come from an earlier
  promoted generation, and an external judge must be independent of current
  workflow output), and the numbers in
  `templates/WORKFLOW_RESEARCH_SPEC_TEMPLATE.json` (examples, never defaults)
  all live in the frozen workflow spec that `workflow-cli.js start --freeze`
  consumes. Nothing in `skills/` describes how that input is produced. That is a
  known gap, not a stage of this skill — do not improvise one here.
