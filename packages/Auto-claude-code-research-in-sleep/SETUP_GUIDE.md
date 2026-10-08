# ARIS Setup Guide

ARIS runs one task on two machines: a **worker** that builds a deliverable and a **validation** machine that scores it against a benchmark the worker never sees. This guide sets up both, with Windows as the default. Why it is split this way: [ARIS_ARCHITECTURE_GUIDE.md](ARIS_ARCHITECTURE_GUIDE.md) (Chinese).

English | [中文版](SETUP_GUIDE_CN.md)

## 1. Install on both machines

1. **Node.js 20+** and **Git**. On Windows: `winget install OpenJS.NodeJS.LTS Git.Git`.
2. **Claude Code**: see the [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code). Check with `claude --version`.
3. **Paseo** with its daemon running: `paseo daemon status`. Paseo copies the ARIS skills and the compiled helpers into every project you add; see [ARIS auto-install](../../docs/aris-auto-install.md). A packaged Paseo (desktop app, global npm install) needs a built ARIS checkout:

   ```powershell
   git clone <aris-repo> $HOME\.paseo\aris
   cd $HOME\.paseo\aris; npm install; npm run build
   ```

4. **Validation machine only:** whatever the benchmark needs, usually Python. Benchmark commands call `python`, not `python3`, so one config runs on Windows and Linux.

`curl.exe` and `tar` ship with Windows 10 and later; the worker needs nothing else to upload.

## 2. Create the project on each machine

Make an empty directory with `git init`, add it to Paseo, and check that `.claude\skills\aris-setup\` and `.aris\dist\` appeared. The two projects are separate: never share a disk, a repository or a synced folder between them.

## 3. Validation machine

Set this side up first; the worker needs its address and token.

1. Write `task.md` with the owner. Open Claude Code in the project and run `/aris-setup validation`. If `task.md` is missing, setup drafts it from the template with you.
2. Setup shows one review sheet with every field. Answer with all your changes at once. The fields that need decisions:
   - **Benchmark**: source, pinned dataset revision, split, full sample count, and the runner commands. `.aris\templates\tester-benchmark\` is a worked lm-evaluation-harness example.
   - **Metric and target**: the score that ends the task.
   - **Hidden paths**: the hidden samples, labels and references. Feedback that quotes them is held back.
   - **Limits**: maximum counted submissions, concurrent reviews, upload size, review timeout.
   - **Validation agent**: provider and model for the agent that reviews each submission. On Windows set `paseo_command` to `["node", "<Paseo install>\\bin\\paseo"]`, because Node cannot start `paseo.cmd` without a shell.
   - **Service address**: see [Network](#network).
3. Approve the final configuration digest. Setup installs the benchmark, runs its healthcheck and smoke test, freezes it, creates the service token and adds the `aris-validation` script to `paseo.json`.
4. Start the `aris-validation` script from the workspace in the Paseo app.
5. Check it: `node .aris\dist\tools\validation-cli.js status --project .`
6. Note the printed `worker_connection`: a URL ending in `/mcp` and a token. Send the token to the worker machine over a private channel.

Once a submission has been counted, the benchmark and target cannot change. A new benchmark means a new validation project.

### Network

The worker must reach the validation service over HTTP. Pick one:

**Direct, on a private network or VPN** (simplest):

- `service.host`: `0.0.0.0`
- `service.port`: a fixed port, for example `8790`
- `service.public_url`: `http://<validation machine address>:8790`

Allow the port through Windows Firewall in an administrator PowerShell:

```powershell
netsh advfirewall firewall add rule name="ARIS validation" dir=in action=allow protocol=TCP localport=8790
```

**Through the Paseo service proxy** (when you already expose Paseo services under a domain): keep `host` at `127.0.0.1`, leave `port` empty, and set `public_url` to the proxy URL of the `aris-validation` script. Proxy setup: [service-proxy.md](../../docs/service-proxy.md).

From the worker machine, `curl.exe http://<address>:8790/health` should print `{"status":"ok"}`. Every other request needs the token.

## 4. Worker machine

1. Copy `task.md` from the validation machine to the project root, unchanged.
2. Run `/aris-setup worker`. Fill `connection.url` and `connection.token` with the values from step 3.6. Leave `environment.prd` empty to let the agent manage its environment, or describe it to have `/experiment-env-configuration` generate run scripts.
3. Approve the digest. Setup writes the `aris-validation` server into `.mcp.json` and the worker role into `CLAUDE.md`, and creates `research-wiki\`.
4. `.mcp.json` holds the token. Add it to `.gitignore`.
5. Restart Claude Code in the project so it loads the MCP server, then ask it to call `query`. It should report the service as `open` with all submissions left.

## 5. Run

Start an agent in the worker project in Paseo and tell it to work on `task.md`. Its role block already says how to submit and when to stop. For every submission, a validation agent appears in the validation machine's Paseo app. The run ends when a valid submission meets the target (`completed`) or the submissions run out (`closed`).

Both machines show their research wiki as a knowledge graph in the ARIS tab of the workspace.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `query` fails on the worker | The `aris-validation` script is running; `/health` answers from the worker; URL ends in `/mcp`; token matches |
| Upload hangs or is refused | Firewall rule and port; upload size limit; the upload URL is single-use and expires, so call `submit` again |
| Submission `invalid` | The zip is malformed or has no `USAGE.md` at its root or in its single top-level folder. Not counted. |
| Submission `failed` | The validation side could not start an agent or the review timed out. Not counted. Check `paseo_command` and the agent provider. |
| Service stopped after an edit | A file the benchmark pins changed. Restore it, or start a new validation project. |
