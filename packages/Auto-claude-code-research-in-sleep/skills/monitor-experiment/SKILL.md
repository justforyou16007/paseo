---
name: monitor-experiment
description: Monitor running experiments, check progress, collect results. Use when user says "check results", "is it done", "monitor", or wants experiment output.
argument-hint: [server-alias or screen-name]
allowed-tools: Bash(ssh *), Bash(echo *), Read, Write, Edit
---

# Monitor Experiment Results

> ⏱ **External cadence is appropriate here.** This skill waits on an external
> fact (job completion / progress), so it is a natural `/loop` / `CronCreate`
> surface: the wake reads status and self-judges only **machine-checkable**
> completion (exit code, file exists, epoch logged) — never quality. This is
> the additive external-wait shape in
> [`shared-references/external-cadence.md`](../shared-references/external-cadence.md).
> If a scheduled wait here ends in a verdict step (e.g. then audit results),
> run that verdict **once** after the wait clears — not re-entered per tick.

Monitor: $ARGUMENTS

## Workflow

> **Environment queries are delegated to the `experiment_env` helper** (`tools/experiment_env/env_helper.py`). Resolve it once, then `monitor`/`collect` handle all four env types (remote screen, vast instance, modal app, local pid) uniformly. The `handle` saved by `/run-experiment` Step 4 drives these calls.

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
# handle.json was saved by /run-experiment Step 4 (deploy). If absent, the
# agent reconstructs it from the env config + experiment name.
HANDLE="${HANDLE:-/tmp/handle.json}"
```

### Step 1: Check What's Running

```bash
python3 "$ENV_HELPER" monitor --env-config "$ENV_CONFIG" --handle "$HANDLE"
```

Returns `{status: running|done|failed|unknown, gpu_usage?, tail, exit_code?}`. The backend queries the right surface per env_type:

- **remote/vast**: `ssh ... "screen -ls"` (+ `vastai show instances` for vast, reading `vast-instances.json`)
- **modal**: `modal app list` + `modal app logs <app>` (apps auto-terminate when done — absent from list = finished)
- **local**: `kill -0 <pid>` + log tail

### Step 2: Collect Output

For each running job, the `monitor` `tail` field already carries the last screen/log lines (backend does `screen -X hardcopy` / log tail internally). If you need a larger window, re-run with the backend's log path.

### Step 3: Check for JSON Result Files

```bash
python3 "$ENV_HELPER" collect --env-config "$ENV_CONFIG"   # downloads results + logs to ./results/ ./logs/
```

Then read the collected JSON locally:

```bash
ls -lt ./results/*.json 2>/dev/null | head -20
cat ./results/<latest>.json
```

### Step 3.5: Pull W&B Metrics (when `wandb: true` in CLAUDE.md)

**Skip this step entirely if `wandb` is not set or is `false` in CLAUDE.md.** (Read `wandb`/`wandb_project`/`wandb_entity` from `$ENV_CONFIG`.)

Pull training curves and metrics from Weights & Biases via Python API:

```bash
# List recent runs in the project
ssh <server> "python3 -c \"
import wandb
api = wandb.Api()
runs = api.runs('<entity>/<project>', per_page=10)
for r in runs:
    print(f'{r.id}  {r.state}  {r.name}  {r.summary.get(\"eval/loss\", \"N/A\")}')
\""

# Pull specific metrics from a run (last 50 steps)
ssh <server> "python3 -c \"
import wandb, json
api = wandb.Api()
run = api.run('<entity>/<project>/<run_id>')
history = list(run.scan_history(keys=['train/loss', 'eval/loss', 'eval/ppl', 'train/lr'], page_size=50))
print(json.dumps(history[-10:], indent=2))
\""

# Pull run summary (final metrics)
ssh <server> "python3 -c \"
import wandb, json
api = wandb.Api()
run = api.run('<entity>/<project>/<run_id>')
print(json.dumps(dict(run.summary), indent=2, default=str))
\""
```

**What to extract:**

- **Training loss curve** — is it converging? diverging? plateauing?
- **Eval metrics** — loss, PPL, accuracy at latest checkpoint
- **Learning rate** — is the schedule behaving as expected?
- **GPU memory** — any OOM risk?
- **Run status** — running / finished / crashed?

**W&B dashboard link** (include in summary for user):

```
https://wandb.ai/<entity>/<project>/runs/<run_id>
```

> This gives the auto-review-loop richer signal than just screen output — training dynamics, loss curves, and metric trends over time.

### Step 4: Summarize Results

Present results in a comparison table:

```
| Experiment | Metric | Delta vs Baseline | Status |
|-----------|--------|-------------------|--------|
| Baseline  | X.XX   | —                 | done   |
| Method A  | X.XX   | +Y.Y              | done   |
```

### Step 5: Interpret

- Compare against known baselines
- Flag unexpected results (negative delta, NaN, divergence)
- Suggest next steps based on findings

### Step 6: Feishu Notification (if configured)

After results are collected, check `~/.claude/feishu.json`:

- Send `experiment_done` notification: results summary table, delta vs baseline
- If config absent or mode `"off"`: skip entirely (no-op)

## Key Rules

- Always show raw numbers before interpretation
- Compare against the correct baseline (same config)
- Note if experiments are still running (check progress bars, iteration counts)
- If results look wrong, check training logs for errors before concluding
- **Vast.ai cost awareness**: When monitoring vast.ai instances, report the running cost (hours \* $/hr from `vast-instances.json`). If all experiments on an instance are done, remind the user to run `/vast-gpu destroy <instance_id>` to stop billing
- **Modal cost awareness**: Modal auto-scales to zero — no idle billing. When reporting results from Modal runs, note the actual execution time and estimated cost (time \* $/hr from the GPU tier used). No cleanup action needed
