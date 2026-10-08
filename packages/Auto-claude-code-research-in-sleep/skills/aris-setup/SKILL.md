---
name: aris-setup
description: 'Set this machine up as the ARIS worker or the validation side through one editable configuration review. Use for "/aris-setup worker", "/aris-setup validation", aris setup or 配置项目.'
argument-hint: worker | validation
allowed-tools: Read, Write, Edit, Bash(*), AskUserQuestion
---

# ARIS Setup

ARIS runs one task on two machines. The **worker** builds a deliverable; the **validation** side owns a frozen benchmark, scores each submission and decides when the task is done. The two talk only through the validation service's MCP tools. Each machine runs Paseo, so the owner sees both sides' agents.

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
- `environment.prd`: `null` when you manage the environment yourself; a PRD when `/experiment-env-configuration` should generate run scripts.

### Validation modules

- `validation.benchmark`: the frozen benchmark. Build it with the owner from `.aris/templates/TESTER_FACILITY_CONFIG_TEMPLATE.json` and the runner protocol in `.aris/templates/README.md`; `.aris/templates/tester-benchmark/` is a worked lm-evaluation-harness example. Pin the benchmark source, dataset revision, split and full sample count. The runner must not import anything from a deliverable; it calls the deliverable only through the adapter a validation agent writes under `ARIS_ADAPTER_DIR`.
- `validation.metric`: one benchmark metric and the target that ends the task.
- `validation.leak_check.hidden_paths`: absolute paths of the hidden samples, labels and references. Feedback that quotes them is held back.
- `validation.limits`: maximum counted submissions, concurrency, upload size and review timeout.
- `validation.agent`: provider, model, mode and thinking for the per-submission validation agent. On Windows set `paseo_command` to `["node", "<Paseo install>\\bin\\paseo"]`.
- `validation.service.public_url`: the address the worker reaches. Use the Paseo service proxy alias for the `aris-validation` script, or `http://<host>:<port>` on a private network.

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

Apply writes the role block into `CLAUDE.md` between the `ARIS ROLE` markers and leaves the rest of the file alone.

**Worker.** Apply adds the `aris-validation` server to `.mcp.json`. That file holds the token: make sure `.gitignore` excludes it. Then:

1. Create the wiki if `research-wiki/` is absent: `node .aris/dist/tools/research-wiki.js init research-wiki/`.
2. If the PRD is set, run `/experiment-env-configuration` with `.aris/environment-prd.json`.
3. Tell the owner to restart the Claude Code session so the MCP server loads, then check that `query` answers.

**Validation.** Apply installs the benchmark (setup, healthcheck and smoke must pass), freezes `.aris/validation/config.json`, creates the service token and adds the `aris-validation` service script to `paseo.json`. Then:

1. Give the owner the printed `worker_connection` URL and token for the worker's setup. Send the token over a private channel.
2. Have the owner start the `aris-validation` script from the Paseo workspace.
3. Check it: `node .aris/dist/tools/validation-cli.js status --project .`.
4. If the PRD is set, run `/experiment-env-configuration` with `.aris/environment-prd.json`.

A failed apply step with an unchanged configuration can be retried as is. A fix that changes the configuration goes back through review and confirm.
