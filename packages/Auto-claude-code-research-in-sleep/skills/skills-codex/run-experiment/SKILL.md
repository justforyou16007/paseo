---
name: "run-experiment"
description: "Deploy and run ML experiments on local or remote GPU servers. Use when user says \"run experiment\", \"deploy to server\", \"\u8dd1\u5b9e\u9a8c\", or needs to launch training jobs."
---

# Run Experiment

Deploy and run ML experiment: $ARGUMENTS

## Workflow

> **Environment control is delegated to the `experiment_env` helper** (`tools/experiment_env/env_helper.py`). Resolve it once via the Layer 0-3 chain, then every step calls a subcommand. The agent reads the project's `AGENTS.md` (codex mode — falls back to `CLAUDE.md` if no `AGENTS.md`) and translates the env section into a candidate JSON; `env_helper.py parse` validates + writes `.aris/experiment-env.json`. See `tools/experiment_env/README.md` for the translation guide (the codex aliases `vast_instance`→`instance_id`, `modal_app`→`modal_app_file` are translated by the agent; the validator warns if a raw alias slips through).

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

Read `AGENTS.md` (or `CLAUDE.md`), find the env section, translate field names to canonical (`vast_instance`→`instance_id`, `modal_app`→`modal_app_file`, `Conda:`→`conda_hook`/`conda_env`, `Code dir:`→`code_dir`, `SSH:`→`ssh_alias`, etc.), pick `env_type`, and validate+write:

```bash
echo '<candidate-json>' | python3 "$ENV_HELPER" parse --json - --source AGENTS.md
```

Env types: `gpu: local`, `gpu: remote`, `gpu: vast` (`vast_instance` present → reuse, else fresh rental in Step 4), `gpu: modal`. If no env info found in AGENTS.md, ask the user.

### Step 2: Pre-flight Check

```bash
python3 "$ENV_HELPER" preflight --env-config "$ENV_CONFIG" --dry-run
python3 "$ENV_HELPER" preflight --env-config "$ENV_CONFIG"
```

Returns `{ok, checks[], gpu_free_mib}`. Free GPU = `memory.used < 500 MiB`. Pick a free GPU index for Step 4. Modal skips GPU preflight.

### Step 3: Sync Code

```bash
python3 "$ENV_HELPER" sync --env-config "$ENV_CONFIG" --src ./src --dry-run
python3 "$ENV_HELPER" sync --env-config "$ENV_CONFIG" --src ./src
```

Honors `code_sync` (`rsync` default, or `git`). Vast always rsyncs to the configured remote path. Modal mounts local code at run time. Do not silently ignore a requested Vast.ai route — if credentials/instance metadata are missing, `provision`/`sync` will error and the agent surfaces it.

### Step 3.5: W&B Integration (when `wandb: true` in AGENTS.md)

**Skip this step entirely if `wandb` is not set or is `false` in AGENTS.md.** (Read `wandb`/`wandb_project`/`wandb_entity` from `$ENV_CONFIG`.)

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

> The W&B project name and API key come from `AGENTS.md` (see example below). The experiment name is auto-generated from the script name + timestamp.

### Step 4: Deploy

Provision the environment first (vast: rent/reuse; remote/modal/local: verify), then launch the job. Build a `run_spec` JSON (`{script, args, gpu_id, exp_name, log_file, env_vars?}`) and deploy:

```bash
python3 "$ENV_HELPER" provision --env-config "$ENV_CONFIG" --dry-run
python3 "$ENV_HELPER" provision --env-config "$ENV_CONFIG"
echo '<run_spec-json>' > /tmp/run_spec.json
python3 "$ENV_HELPER" deploy --env-config "$ENV_CONFIG" --run-spec /tmp/run_spec.json --dry-run
python3 "$ENV_HELPER" deploy --env-config "$ENV_CONFIG" --run-spec /tmp/run_spec.json > /tmp/handle.json
```

`deploy` returns a `handle` (screen session / modal app / local pid) — save it for Step 5/7. Per env_type the backend uses the right primitive:

- **remote**: `ssh <alias> "screen -dmS <exp> bash -c '<conda_hook> && conda activate <env> && CUDA_VISIBLE_DEVICES=<gpu> python <script> <args> 2>&1 | tee <log>"'`
- **vast**: SSH+screen into the instance (`cd <code_dir>`, no conda); include instance id, SSH endpoint, cost in the report. If `auto_destroy: true`, cleanup is wired in Step 7. If the instance is unreachable or the command fails, capture logs and ask before spending more GPU time — do not relaunch blindly.
- **modal**: generates `modal_launcher.py` (Pattern A) and `modal run`. Verify secrets/volumes/image before launch; if Modal reports a config error, fix it before retrying.
- **local**: `CUDA_VISIBLE_DEVICES=<gpu> python <script> <args> 2>&1 | tee <log>` (Mac MPS omits CUDA_VISIBLE_DEVICES)

For local long-running jobs, use `run_in_background: true` to keep the conversation responsive.

### Step 5: Verify Launch

```bash
python3 "$ENV_HELPER" monitor --env-config "$ENV_CONFIG" --handle /tmp/handle.json
```

Returns `{status: running|done|failed, tail, exit_code?}`. Confirm the job is running and GPU is allocated.

### Step 6: Feishu Notification (if configured)

After deployment is verified, check `~/.codex/feishu.json`:

- Send `experiment_done` notification: which experiments launched, which GPUs, estimated time
- If config absent or mode `"off"`: skip entirely (no-op)

### Step 7: Auto-Destroy Vast.ai Instance (when `gpu: vast` and `auto_destroy: true`)

Only run this after the experiment has completed (Step 5 shows `done`) and results/logs/checkpoints have been persisted. The `auto_destroy` default rule: fresh rental (no `instance_id`) → true; reuse → false (check `$ENV_CONFIG`).

```bash
python3 "$ENV_HELPER" collect --env-config "$ENV_CONFIG"   # copy results + logs to durable location
python3 "$ENV_HELPER" destroy --env-config "$ENV_CONFIG"    # destroys only the recorded instance id for this run
```

If any artifact copy fails, `collect` errors and `destroy` does not proceed — do not destroy the instance.

## Key Rules

- ALWAYS check GPU availability first — never blindly assign GPUs
- Each experiment gets its own screen session + GPU (remote) or background process (local)
- Use `tee` to save logs for later inspection
- Run deployment commands with `run_in_background: true` to keep conversation responsive
- Report back: which GPU, which screen/process, what command, estimated time
- If multiple experiments, launch them in parallel on different GPUs

## AGENTS.md Example

Users should add their server info to their project's `AGENTS.md`:

```markdown
## Remote Server

- SSH: `ssh my-gpu-server`
- GPU: 4x A100 (80GB each)
- Conda: `eval "$(/opt/conda/bin/conda shell.bash hook)" && conda activate research`
- Code dir: `/home/user/experiments/`
- code_sync: rsync # default. Or set to "git" for git push/pull workflow
- wandb: false # set to "true" to auto-add W&B logging to experiment scripts
- wandb_project: my-project # W&B project name (required if wandb: true)
- wandb_entity: my-team # W&B team/user (optional, uses default if omitted)

## Vast.ai

- gpu: vast
- vast_instance: 123456
- SSH: `ssh -p 12345 root@ssh.vast.ai`
- Code dir: `/workspace/experiments/`
- auto_destroy: false

## Modal

- gpu: modal
- modal_app: `train.py`
- modal_secrets: `wandb-secret`
- modal_volume: `experiment-results`

## Local Environment

- Mac MPS / Linux CUDA
- Conda env: `ml` (Python 3.10 + PyTorch)
```

> **W&B setup**: Run `wandb login` on your server once (or set `WANDB_API_KEY` env var). The skill reads project/entity from `AGENTS.md` and adds `wandb.init()` + `wandb.log()` to your training scripts automatically. Dashboard: `https://wandb.ai/<entity>/<project>`.
