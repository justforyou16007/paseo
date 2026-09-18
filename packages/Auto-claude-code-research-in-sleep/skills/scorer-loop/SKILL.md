---
name: scorer-loop
description: Revise a module scorer in a dedicated outer wave using a sealed parent comparison, fixed coverage and an independent evidence review. Use when workflow diagnosis selects scorer revision rather than an ordinary model experiment.
allowed-tools: Read, Write, Bash(*), mcp__paseo__create_agent, mcp__paseo__send_agent_prompt
---

# Scorer revision loop

Follow [the Paseo dispatch contract](../shared-references/paseo-subagent-dispatch.md) for manifest-based child dispatch and receipts.

Read the sealed worker manifest and frozen scorer update plan. Follow [the worker read boundary](../shared-references/worker-manifest.md#worker-behavior-on-startup): query with `--manifest`, requester `scorer-loop`, and exactly its scorer scope. Missing bindings stop the phase; do not query module or parent heads. Work only inside the owning outer run's scorer wave. Preserve the task's model-use policy and the user's selected agent settings. A scorer change does not authorize changing the private fixed tester or its test cases.

Resolve `workflow-tools-cli.js` through [the integration contract](../shared-references/integration-contract.md). First register the frozen scorer wave with `scorer-register --project <project> --run <outer-run> --input <registration-input>`; the input must include the outer execution root and the complete `start` record. Then create the run using `scorer-create --input <frozen-input>` and register that child and its budget with the outer runtime. Inspect `scorer-status --project <project> --run <run>` before every resumed action.

Use `scorer-parent-start` before executing the frozen parent coverage, then `scorer-parent-seal` after its required evidence is stored. Keep the parent artifact, case coverage, judge assignment and comparison bindings fixed. Execute the proposed scorer revision against that same coverage and use `scorer-candidate-seal` to seal its evidence. Do not replace missing coverage with an aggregate score.

Dispatch an independent reviewer for the assigned scorer bundle under [the independent review contract](../shared-references/worker-manifest.md#independent-review). The reviewer may inspect that bundle and submit its receipt, but cannot change experiments or activate a revision. Record its stored receipt with `scorer-review --input <receipt>`. Only the validated approved receipt can be passed to `scorer-activate --input <receipt>`. Use `scorer-reject` for a rejected proposal; preserve the active parent.

Each named scorer lifecycle command takes `--project <project> --run <run>`. Use `scorer-recover` after interruption to reconcile stored evidence before repeating execution. Report the actual terminal state and evidence references to the outer scheduler, which settles the child budget and decides what wave follows. Never mix results from before and after activation into one ordinary comparison.
