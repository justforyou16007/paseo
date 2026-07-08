---
name: "monitor-experiment"
description: 'Monitor running experiments, check progress, collect results. Use when user says "check results", "is it done", "monitor", or wants experiment output.'
---

# Monitor Experiment Results

Monitor: $ARGUMENTS

## Workflow

> **Environment queries are delegated to the `experiment_env` helper** (`tools/experiment_env/env_helper.py`). Resolve it once, then `monitor`/`collect` handle all four env types uniformly (the backend type — local/SSH/Vast/Modal — is recorded in `$ENV_CONFIG` and the saved `handle`, so you do not assume a plain SSH screen). The agent reads `AGENTS.md` (codex mode).

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
HANDLE="${HANDLE:-/tmp/handle.json}"   # saved by /run-experiment Step 4 (deploy)
```

### Step 1: Check What's Running

First identify the backend from `AGENTS.md`, run notes, or launch summary: local, SSH, Vast.ai, or Modal. Monitor the backend that was actually used; do not assume a plain SSH screen session when the run was launched through Vast.ai or Modal. The `handle` + `$ENV_CONFIG` carry this, so a single call covers all backends:

```bash
python3 "$ENV_HELPER" monitor --env-config "$ENV_CONFIG" --handle "$HANDLE"
```

```bash
ssh <server> "screen -ls"
```

For Vast.ai, also check instance state, SSH reachability, hourly cost, and whether `auto_destroy` is pending. For Modal, check the Modal run/app logs, function status, timeout, volume outputs, and cloud cost exposure.

### Step 2: Collect Output from Each Screen

For each screen session, capture the last N lines:

```bash
ssh <server> "screen -S <name> -X hardcopy /tmp/screen_<name>.txt && tail -50 /tmp/screen_<name>.txt"
```

If hardcopy fails, check for log files or tee output.

### Step 3: Check for JSON Result Files

```bash
ssh <server> "ls -lt <results_dir>/*.json 2>/dev/null | head -20"
```

If JSON results exist, fetch and parse them:

```bash
ssh <server> "cat <results_dir>/<latest>.json"
```

### Step 3.5: Pull W&B Metrics (when `wandb: true` in AGENTS.md)

If the project enables W&B, pull metrics before interpreting results. Prefer W&B as the source of training curves and recent eval state, while still checking logs for crashes.

List recent runs:

```bash
python3 - <<'PY'
import wandb
api = wandb.Api()
for run in api.runs("<entity>/<project>", per_page=20):
    print(run.name, run.state, run.url)
PY
```

Pull recent history for a specific run:

```bash
python3 - <<'PY'
import wandb
api = wandb.Api()
run = api.run("<entity>/<project>/<run_id>")
for row in run.history(samples=50, keys=["train/loss", "eval/loss", "eval/accuracy", "train/lr"]):
    print(row)
print("summary:", dict(run.summary))
PY
```

If W&B is configured but unavailable, report the connectivity problem and fall back to screen/log/json evidence. Do not interpret missing W&B data as experiment failure by itself.

Always include W&B dashboard links (`run.url`) when available so later review and paper-writing agents can inspect the exact training curves.

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

After results are collected, check `~/.codex/feishu.json`:

- Send `experiment_done` notification: results summary table, delta vs baseline
- If config absent or mode `"off"`: skip entirely (no-op)

## Key Rules

- Always show raw numbers before interpretation
- Compare against the correct baseline (same config)
- Note if experiments are still running (check progress bars, iteration counts)
- If results look wrong, check training logs for errors before concluding
- Include backend cost/risk notes for long-running Vast.ai or Modal jobs
