# Auto Research Loop (ARL)

ARL runs one task on two machines. The worker builds a deliverable; the validation machine owns a frozen benchmark, scores submissions and publishes feedback. Their only application interface is the validation service's `submit` and `query` MCP tools. Planning and implementation belong to the agent; ARL adds no fixed research pipeline.

Use the official Paseo app and CLI on both machines. This archive supplies project skills and the Node runtime helpers; it does not contain or require a custom Paseo build. Official Paseo shows agents and service scripts. It has no custom ARIS knowledge graph tab: read the wiki files or use the `research-wiki` skill.

## Install

You need Bash, Node.js 22.12+, and tar. Install and authenticate Claude Code or Codex, and install the official Paseo CLI with its daemon running (`paseo daemon status`). The validation machine also needs the dependencies required by your benchmark. Windows users can run the Bash installer in Git Bash, with Node on PATH; WSL is a separate Linux environment.

Install from the `arl` branch (the bootstrap downloads and verifies only the standalone archive):

```bash
curl -fsSL "https://raw.githubusercontent.com/justforyou16007/paseo/arl/packages/Auto-claude-code-research-in-sleep/distribution/install-arl.sh" -o /tmp/install-arl.sh
bash /tmp/install-arl.sh --provider claude --project /path/to/project
# Or:
bash /tmp/install-arl.sh --provider codex --project /path/to/project
```

For offline installation, extract the standalone archive outside the target project, then choose one provider per project:

```bash
tar -xzf arl-0.1.0.tar.gz
bash arl/install.sh --provider claude --project /path/to/project
# Or, for a Codex project:
bash arl/install.sh --provider codex --project /path/to/project
```

No npm install, build tools, source checkout, global skill links, or Paseo restart are needed on the target machine. The archive includes compiled helpers, their runtime dependencies and templates. Keep the archive for updates or repairs.

| Provider | Skills | Role instructions | Worker MCP configuration |
| --- | --- | --- | --- |
| Claude | `.claude/skills/` | `CLAUDE.md` | `.mcp.json` |
| Codex | `.agents/skills/` | `AGENTS.md` | `.codex/config.toml` |

Setup writes role instructions and MCP configuration after you confirm the configuration sheet. Existing unrelated instructions and MCP entries are preserved. Codex loads project configuration only for trusted projects: trust this project in Codex, then open a fresh session. Its [MCP configuration](https://developers.openai.com/codex/mcp/) and [skill discovery](https://developers.openai.com/codex/skills/) follow the official OpenAI documentation.

The archive contains five skills: `aris-setup`, `aris-update`, `validation-review`, `research-wiki`, and `experiment-env-configuration`. These existing names and the `.aris/` data directory remain stable. It installs no subagent definitions. Optional literature, GPU platform and notification skills in the source repository are not part of ARL.

Create a separate project on each machine and add each to official Paseo. Never share their disk, repository or synchronized directory. Use the same `task.md` on both machines. In the project `.gitignore`, exclude `.aris/` and the provider MCP configuration because setup stores credentials there.

## Validation machine first

1. Open an agent using the installed provider and ask it to run `aris-setup validation` (Claude slash command `/aris-setup validation`; Codex skill `$aris-setup` with `validation`). If `task.md` is absent, write it with the owner from `.aris/templates/TASK_TEMPLATE.md`.
2. Review the complete configuration sheet. Configure the pinned benchmark source and data revision, split, full sample count, runner argv, metric and target, hidden paths, submission limits and service address. The validation agent provider must match the installed provider. The example in `.aris/templates/tester-benchmark/` uses lm-evaluation-harness.
3. Approve the final configuration digest. Setup runs the benchmark setup, healthcheck and smoke test, freezes the configuration and creates the service token. It writes the `aris-validation` service script into `paseo.json`.
4. Start that script from official Paseo. Check with `node .aris/dist/tools/validation-cli.js status --project .`.
5. Transfer the printed `worker_connection` URL and token privately to the worker machine.

On Windows, use `agent.paseo_command: ["node", "<Paseo install>\\bin\\paseo"]` because Node cannot execute a `.cmd` shim directly. On Linux/macOS the default `["paseo"]` uses the official CLI on PATH.

Once a submission is counted, the benchmark and target are frozen. A changed benchmark needs a new validation project.

## Network

For a private network or VPN, set `service.host` to `0.0.0.0`, `service.port` to a fixed port such as `8790`, and `service.public_url` to `http://<validation-address>:8790`. Allow that port in the validation machine's firewall. The worker must reach `/health`; it should return `{"status":"ok"}`.

If you already operate Paseo's service proxy, use host `127.0.0.1`, leave the port null, and use the script's proxy URL as `public_url`. Paseo supplies the runtime port. This package does not configure DNS or a proxy for you.

## Worker machine

1. Copy the validation machine's `task.md` unchanged to the worker project.
2. Invoke `aris-setup worker`. Fill in `connection.url` and `connection.token`. Leave `environment.prd` null for agent-managed execution, or describe an environment for generated experiment scripts.
3. Approve the reviewed digest. Setup writes the provider's role block and MCP entry. The setup skill initializes `research-wiki/` and invokes environment configuration when requested.
4. Reopen the provider session; for Codex, trust the project. Ask the agent to call `query` and verify the validation service is open.
5. Tell the worker to work on `task.md`. It submits a zip containing `USAGE.md`, uploads to the one-time URL and polls `query`. It stops at `completed` (target met) or `closed` (submission limit reached).

Generated environment operations require POSIX sh and jq, plus the transport/runtime tools specified by your PRD (for example SSH, rsync, Python or a container runtime). These project-specific tools are not bundled.

## Update or repair

Extract the new archive separately and use the same provider and project:

```bash
bash arl/install.sh --provider codex --project /path/to/project --dry-run
bash arl/install.sh --provider codex --project /path/to/project
```

The installer verifies archive hashes and records managed file hashes in `.aris/install.json`. It restores missing files and updates unchanged managed files. A local edit stops the update before writes; save it before choosing `--force`. Updates preserve task.md, setup state, benchmark, submissions, wiki, user skills and generated experiment bundles. Provider changes in an existing installation are refused; use separate projects for different providers.

If setup was applied, rerun `node .aris/dist/tools/setup-cli.js apply --project .` to refresh the role block. An unchanged configuration keeps its confirmation. Reopen the agent session after updates. No daemon restart is required.

Older custom-Paseo installations have no standalone ownership manifest. Back them up and install into fresh projects, or inspect conflicting files and explicitly select `--force`. The installer never deletes user agent definitions or old global skill links.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Skills missing | Installation provider matches the opened agent; reopen the session |
| Codex MCP missing | Project is trusted and `.codex/config.toml` has the ARL block |
| Existing unmanaged aris-validation TOML entry | Move that entry out before applying setup; ARL does not overwrite an unrelated owner-managed table |
| query fails | Service is running; worker reaches /health; URL ends in /mcp; token matches |
| Upload rejected | Zip has USAGE.md at root or in one top-level folder; upload fits limits; URL is single-use |
| Submission failed | Official Paseo CLI/provider is available; inspect validation service logs and review timeout |
| Service refuses after an edit | Restore the pinned benchmark files, or create a new validation project |
