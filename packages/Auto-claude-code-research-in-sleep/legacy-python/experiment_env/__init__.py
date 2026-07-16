"""experiment_env — unified experiment-environment helper for ARIS.

A multi-owner Layer-2 helper package (see
skills/shared-references/integration-contract.md §2) that lets every
GPU-consuming skill (run-experiment / monitor-experiment / vast-gpu /
serverless-modal / experiment-queue) drive local, remote, Vast.ai and
Modal environments through one CLI:

    env_helper.py parse    --json - --source CLAUDE.md   # validate+write config
    env_helper.py preflight --env-config .aris/experiment-env.json
    env_helper.py sync      --src ./src
    env_helper.py deploy    --run-spec run.json
    env_helper.py monitor   --handle handle.json
    env_helper.py collect    --handle handle.json
    env_helper.py destroy    --handle handle.json
    env_helper.py provision  /  info

Design split:
- Parsing CLAUDE.md/AGENTS.md free text is the AGENT's job (the model
  reads markdown and produces a canonical candidate JSON).
- `parse_env.py` / `env_helper.py parse` only VALIDATE + WRITE that
  candidate — it never reads markdown, never hard-codes alias tables.
- Environment control (provision/preflight/sync/deploy/monitor/collect/
  destroy) is implemented per-backend as a subclass of `EnvBackend`.

New environment = subclass EnvBackend + implement 7 methods + register
in `EnvBackend.create()`. See README.md for the walk-through.
"""

from .env_backend import EnvBackend, EnvError

__all__ = ["EnvBackend", "EnvError"]
