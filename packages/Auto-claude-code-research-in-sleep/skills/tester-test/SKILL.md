---
name: tester-test
description: "Run a complete benchmark against the facilities created by /aris-setup. Invoke automatically after experiments and before tester-audit and Wiki metric publication; support persistent jobs and recovery."
allowed-tools: Read, Write, Bash(*), mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

> Follow [Paseo dispatch](../shared-references/paseo-subagent-dispatch.md), [reviewer dispatch](../shared-references/paseo-reviewer-dispatch.md) and the [worker manifest](../shared-references/worker-manifest.md). Dispatch each child through Paseo MCP, arm the dispatch watchdog before waiting, and archive it after collecting its receipt. Resolve helpers through [integration-contract.md](../shared-references/integration-contract.md).

**Dispatch watchdog (mandatory).** Follow `shared-references/paseo-subagent-dispatch.md` §"The dispatch watchdog": arm a self-target heartbeat before waiting, poll children on each tick, and delete it after collecting terminal receipts.

# Tester Test

Read the owning run's manifest and `.aris/tester-config.json`. Require a ready setup receipt; do not repeat setup on every iteration. Use the same facilities for root and child runs while binding each result to the run and experiment that produced it.

1. Read `inputs.test_request` from experiment-bridge or the assembled workflow. Require `test_id`, `run_id`, `iteration`, `experiment_id`, `artifact: {ref, sha256}`, `deliverables.output_hashes`, and `mode: full`. Follow the [candidate manifest](../shared-references/tester-facility.md); its files must be the tested revision. Use a separate request for each model/comparison arm. Changed artifacts use a new test id, experiment revision and worker directory.
2. Run `tester-facility-cli.js test --project <root> --input <request.json>`. It starts a persistent worker and returns the job/result path. Use `--wait` only for bounded tests. Query `status --project <root> --test-id <id>`; use the existing external-job heartbeat pattern for long jobs, rather than rerunning the test on a timer.
3. On interruption use `resume --project <root> --test-id <id>`. Completed jobs are reused, active jobs are not duplicated, and changed inputs require a new test id. Runner scripts must resume their own benchmark checkpoints in `ARIS_TEST_DIR` when supported.
4. Collect the complete raw benchmark output, predictions, sample-level scores, configuration and logs. The runner writes the output protocol in [tester-facility.md](../shared-references/tester-facility.md). The helper binds the output to the setup and request and produces `.aris/tester/tests/<test_id>/test-result.json`.
5. Run `precheck --project <root> --result <test-result.json>`. Partial coverage, smoke runs, failed samples, stale evidence, wrong artifact bindings or invalid aggregates are unsuccessful tests. Repair the facilities through env-manager or repair the current implementation, then retry this test; protocol changes require new setup/version and test id.
6. Copy the result into `output_dir` as `primary_output`. Write the normal worker receipt last beside the execution manifest at `$(dirname "$MANIFEST_PATH")/receipt.json`; set `summary.test_result_path` to the canonical result path, `dashboard_patch: {}`, and status `done` only after precheck succeeds. Retry infrastructure failures inside this stage within the frozen `max_repair_attempts`, keeping attempt/log evidence. Emit a terminal failed receipt only after retries are exhausted; the orchestrator records failure and stops publication.

Do not publish metrics or approve your own result. Pass the canonical result path to `/tester-audit`; regression and low benchmark scores are valid measured outcomes.
