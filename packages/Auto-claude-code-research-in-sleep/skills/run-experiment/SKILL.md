---
name: run-experiment
description: Deploy and run ML experiments on local, remote, Vast.ai, or Modal serverless GPU. Use when user says "run experiment", "deploy to server", "跑实验", or needs to launch training jobs.
argument-hint: [experiment-description]
allowed-tools: Bash(*), Read, Grep, Glob, Edit, Write, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__wait_for_agent, mcp__paseo__archive_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission
---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill; Rule 4: Paseo MCP Only, Strict). Spawn any sub-skill or sub-phase via `mcp__paseo__create_agent` — do **not** use the host `Skill` / `Agent` / `Task` tools.

# Run Experiment

Deploy and run ML experiment: $ARGUMENTS

## Workflow

> **Environment control is delegated to the `experiment_env` helper** (`tools/experiment_env/env_helper.py`). Resolve it once via the Layer 0-3 chain, then every step calls a subcommand. The agent reads `CLAUDE.md` (or `AGENTS.md` in codex mode) and translates the env section into a candidate JSON; `env_helper.py parse` validates + writes `.aris/experiment-env.json`. See `tools/experiment_env/README.md` for the translation guide.

```bash
# --- resolve experiment_env helper (multi-owner, Layer 2 canonical) ---
ENV_HELPER=""
if [ -z "${ARIS_REPO:-}" ] && [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi
ENV_HELPER=".aris/tools/experiment_env/env_helper.py"
[ -f "$ENV_HELPER" ] || ENV_HELPER="tools/experiment_env/env_helper.py"
[ -f "$ENV_HELPER" ] || { [ -n "${ARIS_REPO:-}" ] && ENV_HELPER="$ARIS_REPO/tools/experiment_env/env_helper.py"; }
[ -f "$ENV_HELPER" ] || ENV_HELPER=""
[ -z "$ENV_HELPER" ] && { echo "ERROR: experiment_env helper not found (Layer 1-3)" >&2; exit 1; }
ENV_CONFIG=".aris/experiment-env.json"
```

### Step 1: Parse Environment Config

Read the project's `CLAUDE.md` (or `AGENTS.md` if no `CLAUDE.md`), find the `## Remote Server` / `## Vast.ai` / `## Modal` / `## Local Environment` section, and translate it into a **canonical candidate JSON** (field names: `env_type`, `ssh_alias`, `conda_hook`, `conda_env`, `code_dir`, `code_sync`, `instance_id`, `auto_destroy`, `image`, `modal_gpu`, `modal_timeout`, `modal_volume`, `modal_app_file`, `modal_secrets`, … — see `tools/experiment_env/README.md` for the alias→canonical table). Then validate + write it:

```bash
echo '<candidate-json>' | python3 "$ENV_HELPER" parse --json - --source CLAUDE.md
# reads env_type + fields from $ENV_CONFIG thereafter
```

The four env types map to: `gpu: local` → local, `gpu: remote` → remote, `gpu: vast` → vast (reuse `instance_id` if a running instance exists in `vast-instances.json`, else fresh rental in Step 4), `gpu: modal` → modal (serverless, no SSH/screen).

### Step 2: Pre-flight Check

```bash
python3 "$ENV_HELPER" preflight --env-config "$ENV_CONFIG" --dry-run   # inspect first
python3 "$ENV_HELPER" preflight --env-config "$ENV_CONFIG"            # actually run
```

Returns `{ok, checks[], gpu_free_mib, ...}`. Free GPU = `memory.used < 500 MiB`. Pick a free GPU index from `gpu_free_mib` for Step 4. Modal skips GPU preflight (it manages allocation automatically).

### Step 3: Sync Code

```bash
python3 "$ENV_HELPER" sync --env-config "$ENV_CONFIG" --src ./src --dry-run
python3 "$ENV_HELPER" sync --env-config "$ENV_CONFIG" --src ./src
```

Honors `code_sync` from config (`rsync` default, or `git` push/pull). Vast always rsyncs to `/workspace/project/`. Modal mounts local code at run time (no pre-sync). Only necessary files are synced — never data/checkpoints.

### Step 3.5: W&B Integration (when `wandb: true` in CLAUDE.md)

**Skip this step entirely if `wandb` is not set or is `false` in CLAUDE.md.** (The `wandb` / `wandb_project` / `wandb_entity` fields are read from `$ENV_CONFIG` by the backend.)

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

Provision the environment first (vast: rent/reuse instance; remote/local/modal: verify), then launch the job. Build a `run_spec` JSON (`{script, args, gpu_id, exp_name, log_file, env_vars?}`) and deploy:

```bash
# Provision (vast: rent or reuse instance_id; remote/modal/local: verify connectivity)
python3 "$ENV_HELPER" provision --env-config "$ENV_CONFIG" --dry-run
python3 "$ENV_HELPER" provision --env-config "$ENV_CONFIG"

# Deploy one job
echo '<run_spec-json>' > /tmp/run_spec.json
python3 "$ENV_HELPER" deploy --env-config "$ENV_CONFIG" --run-spec /tmp/run_spec.json --dry-run
python3 "$ENV_HELPER" deploy --env-config "$ENV_CONFIG" --run-spec /tmp/run_spec.json > /tmp/handle.json
```

`deploy` returns a `handle` (screen session / modal app / local pid) — save it (`/tmp/handle.json`) for Step 5/7. The backend picks the right launch primitive per env_type:

- **remote**: `ssh <alias> "screen -dmS <exp> bash -c '<conda_hook> && conda activate <env> && CUDA_VISIBLE_DEVICES=<gpu> python <script> <args> 2>&1 | tee <log>"'`
- **vast**: `ssh -p <port> root@<host> "screen -dmS <exp> bash -c 'cd /workspace/project && CUDA_VISIBLE_DEVICES=<gpu> python ... 2>&1 | tee /workspace/<log>'"` (no conda — Docker image is the env)
- **modal**: generates `modal_launcher.py` (Pattern A: `modal.Mount.from_local_dir` + `modal.Volume` + `@app.function(gpu, timeout, secrets)` + `train.remote()`), then `modal run`
- **local**: `CUDA_VISIBLE_DEVICES=<gpu> python <script> <args> 2>&1 | tee <log>` (Mac MPS omits CUDA_VISIBLE_DEVICES)

For local long-running jobs, use `run_in_background: true` to keep the conversation responsive.

### Step 5: Verify Launch

```bash
python3 "$ENV_HELPER" monitor --env-config "$ENV_CONFIG" --handle /tmp/handle.json
```

Returns `{status: running|done|failed, tail, ...}`. Confirm the job is running and the GPU is allocated.

### Step 6: Feishu Notification (if configured)

After deployment is verified, check `~/.claude/feishu.json`:

- Send `experiment_done` notification: which experiments launched, which GPUs, estimated time
- If config absent or mode `"off"`: skip entirely (no-op)

### Step 7: Auto-Destroy Vast.ai Instance (when `gpu: vast` and `auto_destroy: true`)

**Skip this step if not using vast.ai or `auto_destroy` is `false`** (the `auto_destroy` default rule: fresh rental → true, reuse → false; check `$ENV_CONFIG`). After the experiment completes (detected via `/monitor-experiment` or Step 5 showing `done`):

```bash
python3 "$ENV_HELPER" collect --env-config "$ENV_CONFIG"   # download results + logs to ./results/ ./logs/
python3 "$ENV_HELPER" destroy --env-config "$ENV_CONFIG"    # vastai destroy instance + update vast-instances.json
```

`destroy` for modal does `modal app stop` + `modal volume rm` (serverless, no instance to destroy); remote/local only stop the job (host retained). Report cost from the `vast-instances.json` record.

> This ensures users are never billed for idle vast.ai instances. When `auto_destroy: true` (the default for fresh rentals), the full lifecycle is automatic: rent → setup → run → collect → destroy.

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
