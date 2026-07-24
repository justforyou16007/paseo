# Project: {project-name}

## Pipeline Status

```yaml
stage: idle # idle | idea-discovery | implementation | training | review | paper
idea: "" # Current idea title (one line)
contract: "" # Path to research_contract.md (e.g., idea-stage/docs/research_contract.md)
current_branch: "" # Git branch for this idea
baseline: "" # Baseline numbers for comparison
training_status: idle # idle | running | complete | failed
language: en # en | zh — controls skill output language (see shared-references/output-language.md)
active_tasks: []
next: "" # Concrete next step
last_updated: "" # YYYY-MM-DD HH:mm — auto-updated by skills on every output write
```

## Project Constraints

- {constraint 1}
- {constraint 2}

## Non-Goals

- {non-goal 1}

## Compute Budget

- {budget details, e.g., "8x A100 for 24h via vast.ai"}

## Experiment Environment

> Required for any GPU experiment. Uncomment **one** block and fill it in.
> The `experiment_env` helper (`tools/experiment_env/env_helper.py`) parses this
> into `.aris/experiment-env.json`; see `tools/experiment_env/README.md` for the
> full field reference. Field names here are the canonical ones the validator
> expects — the agent translates any drift (e.g. `Conda env:` → `conda_env`).

<!-- Remote (pre-configured SSH server)
- gpu: remote
- ssh_alias: my-gpu-server
- conda_hook: eval "$(/opt/conda/bin/conda shell.bash hook)"
- conda_env: research
- code_dir: /home/user/experiments/
- code_sync: rsync          # or "git"
- wandb: false
- wandb_project: my-project # required if wandb: true
- wandb_entity: my-team     # optional
-->

<!-- Vast.ai (on-demand rental)
- gpu: vast
- instance_id:              # set to reuse an existing instance; omit for fresh rental
- auto_destroy: true        # default: true for fresh rental, false for reuse
- max_budget: 5.00
- image: pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel
-->

<!-- Modal (serverless)
- gpu: modal
- modal_gpu: A100-80GB      # default: auto
- modal_timeout: 21600      # default: 6 hours
- modal_volume: my-results
- modal_app_file: train.py  # optional
- modal_secrets: [wandb-secret]  # optional list
-->

<!-- Local
- gpu: local
- conda_env: ml
- device: cuda             # or "mps"; auto-detected if omitted
-->

## ARIS Paseo

> Optional. Controls the paseo parent-child agent execution substrate. If
> omitted, the pipeline falls back to in-process `Skill` dispatch only (no
> cross-model codex reviewer). Paste the full block from
> [`templates/CLAUDE_MD_PASEO_SECTION.md`](../templates/CLAUDE_MD_PASEO_SECTION.md)
> and edit the values; see that file for per-variable detail.

```yaml
orchestrator_provider: claude/sonnet-4-6
executor_provider: claude/sonnet-4-6
executor_mode: bypassPermissions
reviewer_provider: codex/gpt-5.5
reviewer_mode: full-access
reviewer_thinking: xhigh
notify_on_finish: true
fanout_subagents: true
subagent_workspace: current
heartbeat_cron: off
```
