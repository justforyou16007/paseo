---
name: run-experiment
description: Deploy and run ML experiments on local, remote, Vast.ai, or Modal serverless GPU. Use when user says "run experiment", "deploy to server", "跑实验", or needs to launch training jobs.
argument-hint: [experiment-description]
allowed-tools: Bash(*), Read, Grep, Glob, Edit, Write, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__archive_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill; Rule 4: Paseo MCP Only, Strict). Spawn any sub-skill or sub-phase via `mcp__paseo__create_agent` — do **not** use the host `Skill` / `Agent` / `Task` tools.

# Run Experiment

Deploy and run ML experiment: $ARGUMENTS

## Workflow

> **Environment control is delegated to the generated experiment skill's ops** (`.claude/skills/run-<project>-experiment/scripts/ops/`). The agent uses `env-info.sh`, `sync-code.sh`, `build-env.sh`, `launch-job.sh`, `job-status.sh`, `job-logs.sh`, `collect-outputs.sh`, `stop-job.sh`, and `release-resources.sh` — no direct reads of `.aris/experiment-env.json`.
>
> **Op failures route through the generated skill's unified failure contract** (its SKILL.md "Op failure routing" section): the op emits structured error JSON on stderr; write it to `.aris/env-config/$PROJECT/error-reports/<TS>.json`; dispatch `/experiment-env-manager — mode: error-report`; on `fixed` retry the op once, otherwise stop. Never hand-write per-op error handling in this skill.

```bash
# --- resolve the project-level experiment skill ---
PROJECT=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-//; s/-$//')
SKILL_DIR=".claude/skills/run-${PROJECT}-experiment"
OPS="$SKILL_DIR/scripts/ops"
[ -d "$OPS" ] || { echo "ERROR: experiment skill not found at $SKILL_DIR. Run /experiment-env-manager — mode: setup first." >&2; exit 1; }
```

### Step 1: Read Environment Config

Read the environment configuration from the generated experiment skill:

```bash
sh "$OPS/env-info.sh" | jq '.'
```

This returns the env type, backend, connection details, and all configured fields. On failure: follow the unified op-failure routing (blockquote above) with `script: "env-info.sh"`.

### Step 2: Pre-flight Check (sync + build + verify)

```bash
sh "$OPS/sync-code.sh"
sh "$OPS/build-env.sh"
```

`build-env.sh` runs the build (if configured) and the `verify_cmd` gate; its non-zero exit means do not launch. On failure: unified op-failure routing.

### Step 3: Sync Code

Code sync is Step 2's `sync-code.sh`. Honors `preparation.files.transfer` from `env.json` (`rsync` default, or `git` push/pull). Vast always rsyncs to `/workspace/project/`. Modal mounts local code at run time (no pre-sync). Only necessary files are synced — never data/checkpoints.

### Step 3.5: W&B Integration (when `wandb: true` in CLAUDE.md)

**Skip this step entirely if `wandb` is not set or is `false` in CLAUDE.md.** (The `wandb` / `wandb_project` / `wandb_entity` fields are read from the generated experiment skill's `env.json`.)

Before deploying, ensure the experiment scripts have W&B logging:

1. **Check if wandb is already in the script** — look for `import wandb` or `wandb.init`. If present, skip to Step 4.

2. **If not present, add W&B logging** to the training script:

   ```python
   import wandb
   wandb.init(project=WANDB_PROJECT, name=EXP_NAME, config={...hyperparams...})

   # Inside training loop:
   wandb.log({"train/loss": loss, "train/lr": lr, "step": step})

   # After eval:
   wandb.log({"eval/loss": eval_loss, "eval/ppl": ppl, "eval/accuracy": acc})

   # At end:
   wandb.finish()
   ```

3. **Metrics to log** (add whichever apply to the experiment):
   - `train/loss` — training loss per step
   - `train/lr` — learning rate
   - `eval/loss`, `eval/ppl`, `eval/accuracy` — eval metrics per epoch
   - `gpu/memory_used` — GPU memory (via `torch.cuda.max_memory_allocated()`)
   - `speed/samples_per_sec` — throughput
   - Any custom metrics the experiment already computes

4. **Verify wandb login on the target machine:**
   ```bash
   ssh <server> "wandb status"  # should show logged in
   # If not logged in:
   ssh <server> "wandb login <WANDB_API_KEY>"
   ```

> The W&B project name and API key come from `CLAUDE.md` (see example below). The experiment name is auto-generated from the script name + timestamp.

### Step 4: Deploy

Launch the job via the generated experiment skill:

```bash
sh "$OPS/launch-job.sh" "$EXP_NAME" --args "$ARGS"
```

`launch-job.sh` writes the handle to `$SKILL_DIR/handles/<exp>.json` (screen session / modal app / local pid) — the handle is the input for Step 5, the heartbeat, and collection. The backend picks the right launch primitive per env_type:

- **remote**: `ssh <alias> "screen -dmS <exp> bash -c '<conda_hook> && conda activate <env> && CUDA_VISIBLE_DEVICES=<gpu> python <script> <args> 2>&1 | tee <log>"'`
- **vast**: `ssh -p <port> root@<host> "screen -dmS <exp> bash -c 'cd /workspace/project && CUDA_VISIBLE_DEVICES=<gpu> python ... 2>&1 | tee /workspace/<log>'"` (no conda — Docker image is the env)
- **modal**: generates `modal_launcher.py` (Pattern A: `modal.Mount.from_local_dir` + `modal.Volume` + `@app.function(gpu, timeout, secrets)` + `train.remote()`), then `modal run`
- **local**: `CUDA_VISIBLE_DEVICES=<gpu> python <script> <args> 2>&1 | tee <log>` (Mac MPS omits CUDA_VISIBLE_DEVICES)

For local long-running jobs, use `run_in_background: true` to keep the conversation responsive.

### Step 5: Verify Launch

```bash
sh "$OPS/job-status.sh" "$EXP_NAME"
```

Confirm `status == "running"` and the GPU is allocated. On failure: unified op-failure routing.

### Step 5.5: Arm the Monitoring Heartbeat

**This is the liveness guarantee for long jobs** — without it, nothing wakes
anyone when the job finishes. It is this agent's LAST action before ending
its turn.

```bash
MONITOR_CRON=$(jq -r '.monitor.interval_cron' "$SKILL_DIR/env.json")     # default */20 * * * *
MAX_HOURS=$(jq -r '.monitor.max_hours' "$SKILL_DIR/env.json")            # default 48
```

```
mcp__paseo__create_heartbeat:
  name: "monitor-<project>-<EXP_NAME>"          # upsert by name — re-arming is idempotent
  cron: "$MONITOR_CRON"
  expiresIn: "<MAX_HOURS>h"                     # orphan backstop even if delete is never reached
  maxRuns: ceil(MAX_HOURS*60 / interval_minutes)
  prompt: |
    Run the Monitor wake contract from .claude/skills/run-<project>-experiment/SKILL.md
    for experiment <EXP_NAME> (run_id <RUN_ID>). It judges machine-checkable
    facts only; suspected-quality signals are recorded, never judged.
```

Then:
1. Write `handles/<EXP_NAME>.monitor.json`:
   `{ "heartbeat_id": "<id from create_heartbeat>", "heartbeat_name": "monitor-<project>-<EXP_NAME>", "armed_at": "<ISO-8601>", "run_id": "<run_id>" }`
   — **the id is not listable later and delete is creator-only, so it must
   live on disk.**
2. Write receipt `status: "monitoring"` and end the turn. The terminal tick
   (job done/failed/early-stopped) writes the final receipt and deletes the
   heartbeat — your finish notification then re-invokes the parent
   (`/experiment-bridge`), which reads the receipt and advances to Phase 5.

**Degradation:** if this is not an agent-scoped session or
`create_heartbeat` is unavailable, print the poll command
(`sh "$OPS/job-status.sh" "$EXP_NAME"`) and note "monitor manually" in the
receipt — do not block the launch.

### Step 6: Feishu Notification (if configured)

After deployment is verified, check `~/.claude/feishu.json`:

- Send `experiment_done` notification: which experiments launched, which GPUs, estimated time
- If config absent or mode `"off"`: skip entirely (no-op)

### Step 7: Auto-Destroy Vast.ai Instance (when `gpu: vast` and `auto_destroy: true`)

**Skip this step if not using vast.ai or `auto_destroy` is `false`** (the `auto_destroy` default rule: fresh rental → true, reuse → false). After the experiment completes (detected via the heartbeat's terminal tick or Step 5 showing `done`):

```bash
sh "$OPS/collect-outputs.sh" "$EXP_NAME"
sh "$OPS/release-resources.sh"
```

`release-resources.sh` for modal does `modal app stop` + `modal volume rm` (serverless, no instance to destroy); remote/local only stop the job (host retained). Report cost from the `vast-instances.json` record.

> This ensures users are never billed for idle vast.ai instances. When `auto_destroy: true` (the default for fresh rentals), the full lifecycle is automatic: rent → setup → run → collect → destroy.

### Post-run suggestion

After a foreground experiment completes successfully, suggest structured analysis:

```
Experiment complete. For structured comparison and statistical analysis:
/analyze-results — project: <project>
```

For background runs dispatched by `/experiment-bridge` or `/auto-research-loop`,
analysis is handled automatically by the caller's Phase 5.6 / Phase 2.5.

## Key Rules

- ALWAYS check GPU availability first — never blindly assign GPUs (except Modal, which manages allocation automatically)
- Each experiment gets its own screen session + GPU (remote) or background process (local)
- Use `tee` to save logs for later inspection
- Run deployment commands with `run_in_background: true` to keep conversation responsive
- Report back: which GPU, which screen/process, what command, estimated time
- If multiple experiments, launch them in parallel on different GPUs
- **Vast.ai cost awareness**: When using `gpu: vast`, always report the running cost. If `auto_destroy: true`, destroy the instance as soon as all experiments on it complete
- **Modal cost awareness**: Always estimate and display cost before running. Modal auto-scales to zero — no idle billing, no manual cleanup

## CLAUDE.md Example

Users should add their server info to their project's `CLAUDE.md`:

```markdown
## Remote Server

- gpu: remote # use pre-configured SSH server
- SSH: `ssh my-gpu-server`
- GPU: 4x A100 (80GB each)
- Conda: `eval "$(/opt/conda/bin/conda shell.bash hook)" && conda activate research`
- Code dir: `/home/user/experiments/`
- code_sync: rsync # default. Or set to "git" for git push/pull workflow
- wandb: false # set to "true" to auto-add W&B logging to experiment scripts
- wandb_project: my-project # W&B project name (required if wandb: true)
- wandb_entity: my-team # W&B team/user (optional, uses default if omitted)

## Vast.ai

- gpu: vast # rent on-demand GPU from vast.ai
- auto_destroy: true # auto-destroy after experiment completes (default: true)
- max_budget: 5.00 # optional: max total $ to spend per experiment

## Modal

- gpu: modal # serverless GPU via Modal (no SSH, auto scale-to-zero)
- modal_gpu: A100-80GB # optional: override GPU selection (default: auto-select)
- modal_timeout: 21600 # optional: max seconds (default: 6 hours)
- modal_volume: my-results # optional: named volume for results persistence

## Local Environment

- gpu: local # use local GPU
- Mac MPS / Linux CUDA
- Conda env: `ml` (Python 3.10 + PyTorch)
```

> **Vast.ai setup**: Run `pip install vastai && vastai set api-key YOUR_KEY`. Upload your SSH public key at https://cloud.vast.ai/manage-keys/. Set `gpu: vast` in your `CLAUDE.md` — `/run-experiment` will automatically rent an instance, run the experiment, and destroy it when done.

> **Modal setup**: Run `pip install modal && modal setup`. Bind a payment method at https://modal.com/settings (NEVER through CLI) to unlock the full $30/month free tier (without card: $5/month only). Set a workspace spending limit to prevent accidental charges. Set `gpu: modal` in your `CLAUDE.md` — ideal for users without a local GPU who need to debug code or run small-scale tests.

> **W&B setup**: Run `wandb login` on your server once (or set `WANDB_API_KEY` env var). The skill reads project/entity from CLAUDE.md and adds `wandb.init()` + `wandb.log()` to your training scripts automatically. Dashboard: `https://wandb.ai/<entity>/<project>`.
