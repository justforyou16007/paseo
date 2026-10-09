---
name: aris-setup
description: 'Configure the ARL worker or validation role and generate a verified environment usage skill through experiment-env-configuration from the reviewed environment PRD. Use for "/aris-setup worker", "/aris-setup validation", aris setup or 配置项目.'
argument-hint: worker | validation
allowed-tools: Read, Write, Edit, Bash(*), AskUserQuestion
---

# ARIS Setup

ARIS runs one task on two machines. The **worker** builds a deliverable; the **validation** side owns a frozen benchmark, scores each submission and decides when the task is done. The two talk only through the validation service's MCP tools. Install the standalone ARL archive first (`bash install.sh --provider claude|codex --project PATH`). Each machine runs official Paseo, so the owner sees both sides' agents.

The helper is `node .aris/dist/tools/setup-cli.js` (see [integration-contract.md](../shared-references/integration-contract.md)). It owns the draft, the review sheet and the confirmed digest; never edit `.aris/setup-state.json` by hand.

## 1. Task

Both machines need the same `task.md` at the project root. If it is missing, write it with the owner from `.aris/templates/TASK_TEMPLATE.md`. The validation side writes it first; the owner copies it to the worker.

## 2. Review

```bash
node .aris/dist/tools/setup-cli.js review --project . --role <worker|validation>
```

Show the owner `.aris/setup-review.md` in full: every module, field, option, recommendation and open issue at once, in the project language. Do not interview field by field.

The owner answers with several changes in one reply, or edits `.aris/setup-draft.json` directly. Put their changes in a JSON patch (objects merge, lists replace, `null` clears) and refresh:

```bash
node .aris/dist/tools/setup-cli.js review --project . --input patch.json
```

Show the whole sheet again after each refresh. A recommendation becomes a value only when the owner accepts it.

### Worker modules

- `connection.url` and `connection.token`: printed by `/aris-setup validation` on the other machine.
- `environment.prd`: `null` when the owner chooses agent-managed execution; otherwise the environment specification used by setup's `experiment-env-configuration` step to generate a project-local environment usage skill. Review environment requirements in this same sheet, not in a separate interview.

### Validation modules

- `validation.benchmark`: the frozen benchmark. Build it with the owner from `.aris/templates/TESTER_FACILITY_CONFIG_TEMPLATE.json` and the runner protocol in `.aris/templates/README.md`; `.aris/templates/tester-benchmark/` is a worked lm-evaluation-harness example. Pin the benchmark source, dataset revision, split and full sample count. The runner must not import anything from a deliverable; it calls the deliverable only through the adapter a validation agent writes under `ARIS_ADAPTER_DIR`.
- `validation.metric`: one benchmark metric and the target that ends the task.
- `validation.leak_check.hidden_paths`: absolute paths of the hidden samples, labels and references. Feedback that quotes them is held back.
- `validation.limits`: maximum counted submissions, concurrency, upload size and review timeout.
- `validation.agent`: provider, model, mode and thinking for the per-submission validation agent. The provider must match this project installation. On Windows set `paseo_command` to `["node", "<Paseo install>\\bin\\paseo"]`.
- `validation.service`: how the worker reaches the service.
  - Through the Paseo service proxy: keep `host` at `127.0.0.1`, leave `port` null, and set `public_url` to the proxy URL of the `aris-validation` script.
  - Directly on a private network: set `host` to `0.0.0.0`, a fixed `port`, and `public_url` to `http://<this machine's address>:<port>`. On Windows, allow that port through the firewall: `netsh advfirewall firewall add rule name="ARIS validation" dir=in action=allow protocol=TCP localport=<port>`.

Once a submission has been counted, the benchmark and metric are frozen and the helper reports any change as an issue. Changing them means a new validation project.

## 3. Confirm

When the sheet has no issues, show the final `configuration_sha256` and ask the owner to approve that version. Then:

```bash
node .aris/dist/tools/setup-cli.js confirm --project . --digest <configuration_sha256>
```

Any later edit, including to `task.md`, invalidates the confirmation. A request to change something is not approval.

## 4. Apply

```bash
node .aris/dist/tools/setup-cli.js apply --project .
```

Apply writes the role block into `CLAUDE.md` for Claude or `AGENTS.md` for Codex between the `ARIS ROLE` markers and leaves the rest of the file alone.

**Worker.** Apply adds the `aris-validation` server to `.mcp.json` for Claude or `.codex/config.toml` for Codex. The installer records the provider in `.aris/install.json`. Keep the provider MCP config and `.aris/` out of git because they hold credentials. Then:

Create the wiki if `research-wiki/` is absent: `node .aris/dist/tools/research-wiki.js init research-wiki/`. The generated role block lists the worker's validation tools, `research-wiki`, `browser-act`, `experiment-queue` and environment skills. Continue with the environment step below before reporting setup complete.

**Validation.** Apply installs the benchmark (setup, healthcheck and smoke must pass), freezes `.aris/validation/config.json`, creates the service token and adds the `aris-validation` service script to `paseo.json`. Then:

1. Give the owner the printed `worker_connection` URL and token for the worker's setup. Send the token over a private channel.
2. Have the owner start the `aris-validation` script from the Paseo workspace.
3. Check it: `node .aris/dist/tools/validation-cli.js status --project .`.

## 5. Generate the environment usage skill

For either role, if apply reports `environment_prd: true`, invoke the installed `experiment-env-configuration` skill with `.aris/environment-prd.json` as part of this setup invocation. It uses the already confirmed requirements; do not send the owner away to run a second setup command.

When the PRD requires a browser, first run `node .aris/dist/tools/ensure-browser-act.js` and stop on failure. Browser IDs and authenticated profiles needed by the PRD must already be established with the owner during review.

The output is the **environment usage skill** in apply's `environment_skill_dir`: `run-<project>-experiment/SKILL.md`, verified configuration and its operation scripts. Scripts alone or the PRD file are not a completed environment setup. Check that the published skill exists and `env.json` has `status: "complete"`, and report its path and real verification results. The worker uses this skill for individual experiments; `experiment-queue` uses its operation interface for batches.

If environment generation or verification fails, report that setup's environment step is incomplete and the error. Do not claim the environment is ready. With `environment.prd: null`, explicitly report agent-managed execution and skip generation.

## 6. Reload skills

After all requested setup steps pass, list the available skills and any newly generated environment usage skill. Tell the owner to run **`reload-skills`** in their client to load new or changed skills before starting work. If the client has no skill reload action, open a fresh provider session. The worker's changed MCP configuration also needs a fresh provider session; Codex must trust the project. Then check that `query` answers.

Finish setup at this handoff. Start research only when the owner requests it.

A failed apply step with an unchanged configuration can be retried as is. A fix that changes the configuration goes back through review and confirm.
