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

> **Environment queries are delegated to the generated project-level experiment skill** (`.claude/skills/run-<project>-experiment/scripts/`). The `monitor.sh` and `collect.sh` scripts handle all env types (remote screen, vast instance, modal app, local pid) uniformly, including W&B metric retrieval. Run `/experiment-env-configuration` first to generate the skill.

```bash
# --- resolve the project-level experiment skill ---
PROJECT=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')
SKILL_DIR=".claude/skills/run-${PROJECT}-experiment"
[ -d "$SKILL_DIR/scripts" ] || { echo "ERROR: experiment skill not found at $SKILL_DIR — run /experiment-env-configuration first" >&2; exit 1; }

# Handle is now stored per-experiment in the skill directory
HANDLE_DIR="$SKILL_DIR/handles"
```

### Step 1: Check What's Running

```bash
sh "$SKILL_DIR/scripts/monitor.sh" "$EXP_NAME"
```

Returns a JSON object with `status` (`running|done|failed|unknown`), `gpu_usage`, `tail`, `exit_code`, `elapsed_seconds`, and `wandb` fields. The script handles all env types internally — no per-env branching needed.

### Step 2: Collect Output

For each running job, the `monitor.sh` output JSON's `tail` field already carries the last screen/log lines. If you need a larger window, re-run with the skill's log path.

### Step 3: Check for JSON Result Files

```bash
sh "$SKILL_DIR/scripts/collect.sh" "$EXP_NAME"   # downloads results + logs to ./results/ ./logs/
```

The receipt JSON at `.aris/runs/<run_id>.experiment.<exp>.done.json` contains all fields: `status`, `primary_metric`, `metrics`, `gpu_usage`, `wandb`, `failure_patterns_matched`, `elapsed_seconds`.

Then read the collected JSON locally:

```bash
ls -lt ./results/*.json 2>/dev/null | head -20
cat ./results/<latest>.json
```

### Step 3.5: W&B Metrics (when `wandb: true` in CLAUDE.md)

**Skip this step entirely if `wandb` is not set or is `false` in CLAUDE.md.**

W&B data is now available directly in the `monitor.sh` output JSON's `wandb` field — no separate SSH call or raw Python snippet needed. The `wandb` object includes recent training metrics, run state, and a dashboard link.

**What to extract from the `wandb` field:**

- **Training loss curve** — is it converging? diverging? plateauing?
- **Eval metrics** — loss, PPL, accuracy at latest checkpoint
- **Learning rate** — is the schedule behaving as expected?
- **GPU memory** — any OOM risk?
- **Run status** — running / finished / crashed?

Include the W&B dashboard link (from the `wandb.url` field) in the summary for the user.

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
