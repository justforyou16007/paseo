---
name: tester-setup
description: "Prepare reusable benchmark facilities during /aris-setup. Install evaluation tools and data, configure model services, and verify health and smoke tests before a formal run."
allowed-tools: Read, Write, Bash(*), mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

> Follow [Paseo dispatch](../shared-references/paseo-subagent-dispatch.md), [reviewer dispatch](../shared-references/paseo-reviewer-dispatch.md) and the [worker manifest](../shared-references/worker-manifest.md). Dispatch each child through Paseo MCP, arm the dispatch watchdog before waiting, and archive it after collecting its receipt. Resolve helpers through [integration-contract.md](../shared-references/integration-contract.md).

**Dispatch watchdog (mandatory).** Follow `shared-references/paseo-subagent-dispatch.md` §"The dispatch watchdog": arm a self-target heartbeat before waiting, poll children on each tick, and delete it after collecting terminal receipts.

# Tester Setup

Run as the tester facility stage of `/aris-setup`, after research requirements and execution resources are known. Prepare facilities once; subsequent iterations invoke `/tester-test` and `/tester-audit`. Re-run setup only when the benchmark, protocol, runner or environment changes.

1. Read the research brief, metric target, resources and environment-manager receipt. Accept an explicitly named benchmark. If none was specified, select an established benchmark suited to the task and document the choice.
2. Pin the benchmark repository revision, dataset revision and split, full expected sample count, metrics and scoring protocol. Declare whether each metric uses mean, sum or an external benchmark-specific aggregator. Document failure handling, repeats, seeds, prompts, judge and baseline comparison conditions.
3. Prepare local or SSH execution. Reuse `/experiment-env-manager` for installation and repair. Docker is an optional dependency environment; run tests under the existing account. Prepare data downloads, GPU/model-service launch and health checks where needed. Use idempotent scripts and existing endpoints when available.
4. Write a facility input using `templates/TESTER_FACILITY_CONFIG_TEMPLATE.json`. Commands are explicit argv arrays with timeouts. Pin runner, scoring/configuration and data-manifest files in `evidence_files`. Use inherited process environment or existing remote service credentials. `execution.env` contains only nonsecret settings because it is recorded in jobs and results. The runner protocol is in [tester-facility.md](../shared-references/tester-facility.md).
5. Run `tester-facility-cli.js setup --project <root> --input <facility-input.json>`. The helper runs setup commands, healthcheck and smoke, captures evidence, and writes `.aris/tester-config.json` plus `.aris/tester-config.json.setup.json` only on success. A matching ready setup can be reused. A smoke measurement is not a publishable benchmark score.
6. Hand the config and setup receipt back to `/aris-setup`; root setup takes `tester_facility_config`. Do not mark setup ready after an installation or smoke failure. Remove prior ARIS search hooks through `tester-facility-cli.js migrate --project <root>` when upgrading; preserve unrelated hooks.

Benchmark source, cases, per-sample outputs, model identities and logs are available to the research workflow. No signing keys, separate users, private stores, search exclusions or exposure limits are part of this setup.

Setup is project-level initialization before the root charter exists. Use the project/global setup context and setup receipt; a run Wiki manifest or dashboard receipt is not a prerequisite.

For a concrete framework deployment, adapt `templates/tester-benchmark/lm-eval-adapter.py` and its pinned profile. It installs lm-eval, prepares local benchmark data and emits the full runner protocol. See the accompanying README.
