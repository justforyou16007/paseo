---
name: tester-audit
description: "Audit completed benchmark results after tester-test and before research wiki metric submission. Verify raw evidence and use an independent reviewer to check protocol, scoring, coverage and comparisons."
allowed-tools: Read, Write, Bash(*), mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

> Follow [Paseo dispatch](../shared-references/paseo-subagent-dispatch.md), [reviewer dispatch](../shared-references/paseo-reviewer-dispatch.md) and the [worker manifest](../shared-references/worker-manifest.md). Dispatch each child through Paseo MCP, arm the dispatch watchdog before waiting, and archive it after collecting its receipt. Resolve helpers through [integration-contract.md](../shared-references/integration-contract.md).

**Dispatch watchdog (mandatory).** Follow `shared-references/paseo-subagent-dispatch.md` §"The dispatch watchdog": arm a self-target heartbeat before waiting, poll children on each tick, and delete it after collecting terminal receipts.

# Tester Audit

Run automatically after `/tester-test`, before any formal test metric or claim is written to research wiki. Reuse experiment-integrity checks from `/experiment-audit`; this stage checks the benchmark evidence and does not decide whether the research idea improved.

1. Read `test-result.json`, the pinned setup/config, runner/scoring source, raw results, predictions and per-sample evidence. Run `tester-facility-cli.js precheck --result <path>` first. A deterministic failure stops publication and enters repair.
2. Dispatch an independent reviewer using the project's reviewer settings and [reviewer dispatch](../shared-references/paseo-reviewer-dispatch.md). Supply paths to evidence, the expected dataset/split and coverage, scoring protocol and comparison conditions. The reviewer must read the files, not accept the executor's numerical summary.
3. Require a structured review file with `schema_version: 1`, `result_sha256` (the SHA-256 of the exact result file), `reviewer_id`, `status: pass|warn|fail`, `checks: {protocol, scoring, coverage, comparability}` (booleans), and `findings` (strings). Check model/artifact identity, fake ground truth, selective sample dropping, post-hoc normalization, repeat/seed handling, baseline comparability and benchmark-specific aggregation. A single-model result can pass comparability when its scope is explicitly single-model; do not invent a baseline claim.
4. Run `tester-facility-cli.js audit --result <path> --review <review.json>`. It verifies current raw evidence and review binding and produces `test-audit.json`. `warn`/`fail` retains diagnostic output and returns failure; only `pass` with all four checks true is publishable.
5. Write the worker receipt last: copy audit as `primary_output`, set `summary.test_result_path` and `summary.test_audit_path`, `dashboard_patch: {}`, status `done` for pass and `failed` otherwise. Bind to the owning run and iteration.
6. Hand both canonical paths to result-to-claim. If any evidence or result changes, run testing/audit again. A performance regression can pass integrity audit and must remain publishable as a negative finding.

The tester executor must not write a passing reviewer judgment on behalf of the reviewer. Keep review evidence visible in the project; no isolation or signing machinery is required.

Before merging a terminal failed receipt, the orchestrator may repair the reported issue and redispatch tester-test → tester-audit within its frozen retry limit. Keep each corrected artifact/protocol under a new test id. Merge failure only when that limit is exhausted; never override warn/fail with an executor-authored pass.
