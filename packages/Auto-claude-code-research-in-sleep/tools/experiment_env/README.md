# experiment_env — unified experiment-environment helper

A multi-owner Layer-2 helper (see
`skills/shared-references/integration-contract.md` §2) that gives every
GPU-consuming skill one CLI to drive **local**, **remote**, **Vast.ai**
and **Modal** environments:

```
env_helper.py parse      validate agent's candidate JSON → .aris/experiment-env.json
env_helper.py info       print current env config
env_helper.py provision  create/rent the environment
env_helper.py preflight  GPU / conda / connectivity check
env_helper.py sync       sync code to the environment
env_helper.py deploy     launch one job (--run-spec PATH)
env_helper.py monitor    query job status (--handle PATH)
env_helper.py collect    download results (--handle PATH)
env_helper.py destroy    tear the environment down (--handle PATH)
```

Any action accepts `--dry-run` (print what it would do, no side effects).

## Architecture — who does what

| Job                                                                                               | Done by                                                   |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Read CLAUDE.md/AGENTS.md, understand free text, pick env_type, translate field names to canonical | **the agent** (the model)                                 |
| Validate the candidate JSON, fill defaults, check env_type, write `.aris/experiment-env.json`     | **`parse_env.py` / `env_helper.py parse`** (this package) |
| Create/rent/sync/deploy/monitor/destroy the environment                                           | **a backend subclass** of `EnvBackend`                    |

`parse_env.py` **never reads markdown** — it only validates what the
agent extracted. This keeps the brittle part (understanding drifting
field names) in the agent, where the model is good at it, and the
deterministic part (schema validation) in code, where it belongs.

## How a SKILL calls this helper

Copy this Layer 0→3 resolver block (mirrors `experiment-queue`'s):

```bash
ENV_HELPER=""
if [ -z "${ARIS_REPO:-}" ] && [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi
ENV_HELPER=".aris/tools/experiment_env/env_helper.py"                       # Layer 1
[ -f "$ENV_HELPER" ] || ENV_HELPER="tools/experiment_env/env_helper.py"    # Layer 2 (canonical)
[ -f "$ENV_HELPER" ] || { [ -n "${ARIS_REPO:-}" ] && ENV_HELPER="$ARIS_REPO/tools/experiment_env/env_helper.py"; }  # Layer 3
[ -f "$ENV_HELPER" ] || ENV_HELPER=""
[ -z "$ENV_HELPER" ] && { echo "ERROR: experiment_env helper not found" >&2; exit 1; }
ENV_CONFIG=".aris/experiment-env.json"
python3 "$ENV_HELPER" preflight --env-config "$ENV_CONFIG"
```

No `os.execv` shim is needed — the canonical code lives at Layer 2
(`tools/experiment_env/`) directly.

## Agent translation guide (CLAUDE.md/AGENTS.md → candidate JSON)

The agent reads the project's `CLAUDE.md` (or `AGENTS.md` in codex
mode — pick whichever exists), finds the `## Remote Server` / `## Vast.ai`
/ `## Modal` / `## Local Environment` section, and emits a candidate
JSON using **canonical** field names. Translate these markdown tokens:

| markdown token                  | canonical field                                                 | notes                    |
| ------------------------------- | --------------------------------------------------------------- | ------------------------ |
| `vast_instance`                 | `instance_id`                                                   | codex alias              |
| `modal_app`                     | `modal_app_file`                                                | codex alias              |
| `modal_secrets` (single string) | `modal_secrets` (list)                                          | wrap as one-element list |
| `Conda env:` / `Activate:`      | `conda_env`                                                     | docs drift               |
| `Code directory:` / `Code dir:` | `code_dir`                                                      | docs/skill drift         |
| `Conda:` (remote, full hook)    | `conda_hook` + trailing `conda activate <env>` → `conda_env`    |                          |
| `SSH:`                          | `ssh_alias` (+ parse `ssh -p P root@host` → ssh_host/port/user) |                          |
| `GPU:`                          | `gpu_desc`                                                      | human-readable           |
| no `gpu:` line, section present | set `env_type` from the section                                 | agent decides            |

The validator emits a **warning** (non-blocking) if a deprecated alias
slips through untranslated, but does **not** auto-convert — fix the
agent's translation, don't add conversion logic here.

Example candidate JSON (remote):

```json
{
  "env_type": "remote",
  "remote": {
    "ssh_alias": "my-gpu-server",
    "conda_hook": "eval \"$(/opt/conda/bin/conda shell.bash hook)\"",
    "conda_env": "research",
    "code_dir": "/home/user/experiments/",
    "code_sync": "rsync",
    "wandb": false
  }
}
```

Then: `echo '<candidate>' | python3 env_helper.py parse --json - --source CLAUDE.md`

## `auto_destroy` default rule

Vast.ai `auto_destroy` reconciles the claude default (`true`) and codex
default (`false`) with one rule:

- `instance_id` **absent** (fresh rental) → default `true` (destroy after, save money)
- `instance_id` **present** (reuse) → default `false` (don't destroy what you didn't create)

An explicit `auto_destroy` always overrides.

## Adding a new environment (e.g. `k8s`)

1. Create `k8s_env.py` with `class K8sEnv(EnvBackend)`.
2. Implement the 7 methods: `provision`, `preflight`, `sync`, `deploy`,
   `monitor`, `collect_results`, `destroy`. Use `self.run(...)` (from
   `env_backend`) for shell commands; respect `self.dry_run` (return
   `self._announce(action, cmd)` instead of executing).
3. Register in `EnvBackend.create()` (`env_backend.py`): add
   `from .k8s_env import K8sEnv` (and the script-mode fallback) and
   `"k8s": K8sEnv` to the registry.
4. Add `"k8s"` to `ENV_TYPES` and a schema block to `ENV_SCHEMAS` in
   `parse_env.py` (fields, types, required, defaults).
5. (Optional) add deprecated-alias entries to `ALIASES` for warning.
6. Add a backend test in `tests/experiment_env/test_backends.py`.

No skill needs to change — they all dispatch through `EnvBackend.create()`.

## Layering with `queue_manager.py`

This helper runs **locally** and orchestrates one environment (SSH out,
vastai, modal CLI). `skills/experiment-queue/scripts/queue_manager.py`
runs **on the remote host** and batch-schedules N jobs. They are
complementary:

- `env_helper provision + preflight + sync` prepares the host **once**.
- `experiment-queue` (manifest filled from `experiment-env.json`)
  uploads `queue_manager.py` + manifest and runs N jobs.
- `env_helper destroy` runs **once** at the end (vast `auto_destroy`
  fires for the batch, not per-job).

## Failure policies (per integration-contract.md)

| subcommand                                                            | policy                                           |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| `parse`, `info`                                                       | E (diagnostic — warnings non-blocking)           |
| `provision`/`preflight`/`sync`/`deploy`/`monitor`/`collect`/`destroy` | A (gate — unresolved or failed blocks the skill) |

Exit codes: `0` ok, `1` hard error, `2` no config, `10-16` per-method error.

## Docker environment support

The Docker backend runs experiments in isolated containers with optional GPU passthrough.
It supports both pre-built images and local Dockerfile builds, bind-mounts for code
and results, custom volumes, environment variables, and network configuration.

Example candidate JSON (using pre-built image):
```json
{
  "env_type": "docker",
  "docker": {
    "image": "nvidia/cuda:12.1.0-devel-ubuntu22.04",
    "gpus": "all",
    "shm_size": "32g",
    "runtime": "nvidia",
    "env_vars": {"WANDB_MODE": "online"},
    "volumes": ["/local/data:/data", "/local/models:/models"],
    "auto_remove": true
  }
}
```

Example candidate JSON (building from local Dockerfile):
```json
{
  "env_type": "docker",
  "docker": {
    "dockerfile": "Dockerfile.train",
    "build_context": "./",
    "build_args": {"PY_VERSION": "3.10"},
    "gpus": "all",
    "work_dir": "/code",
    "results_dir": "/output"
  }
}
```
