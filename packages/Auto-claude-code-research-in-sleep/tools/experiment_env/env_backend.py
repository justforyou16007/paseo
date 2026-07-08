"""env_backend.py — abstract base class + factory for experiment environments.

The seven lifecycle methods (provision / preflight / sync / deploy /
monitor / collect_results / destroy) are the contract every backend
implements. Each returns a JSON-serializable dict; the CLI prints it to
stdout for the calling SKILL to parse. Failures raise `EnvError(exit_code,
message)` which the CLI maps to a process exit code.

`detect` is intentionally NOT a method: which environment is active is
decided at parse time (agent sets `env_type` in the candidate JSON) and
the validator checks it; the backend is then constructed for that one
env_type via `EnvBackend.create()`.

Reference for the commands each backend reimplements:
- skills/run-experiment/SKILL.md (Step 2-7)
- skills/vast-gpu/SKILL.md (Rent/Setup/Destroy)
- skills/serverless-modal/SKILL.md (Pattern A launcher)
"""

import subprocess
from abc import ABC, abstractmethod


class EnvError(Exception):
    """Raised by a backend method on failure. `code` is the CLI exit code."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def run(cmd, check=False, capture=True):
    """Run a shell command, return (stdout, returncode).

    Mirrors the `run()` primitive in skills/experiment-queue/scripts/
    queue_manager.py:103-108 so backends share one execution style.
    """
    r = subprocess.run(cmd, shell=True, capture_output=capture, text=True)
    if check and r.returncode != 0:
        raise EnvError(1, f"command failed: {cmd}\n{r.stderr}")
    return r.stdout, r.returncode


class EnvBackend(ABC):
    """Abstract base for an experiment environment backend.

    `config` is this environment's sub-object from
    .aris/experiment-env.json (e.g. the `remote` block), already
    validated + default-filled by parse_env.validate().
    `state_dir` is where runtime state files (vast-instances.json) live.
    `dry_run` (set by the CLI) makes methods print what they would do
    instead of executing side-effecting commands.
    """

    def __init__(self, config: dict, state_dir: str = ".", dry_run: bool = False):
        self.config = config
        self.state_dir = state_dir
        self.dry_run = dry_run

    # -- factory ---------------------------------------------------------

    @staticmethod
    def create(env_type: str, config: dict, state_dir: str = ".",
               dry_run: bool = False) -> "EnvBackend":
        """Construct the backend for `env_type`. Invalid → ValueError."""
        # Local imports to avoid a circular import at module load. Use
        # relative imports when imported as a package member, absolute
        # imports when run as a standalone script (env_helper.py adds the
        # package dir to sys.path).
        if __package__:
            from .local_env import LocalEnv
            from .remote_env import RemoteEnv
            from .vast_env import VastEnv
            from .modal_env import ModalEnv
        else:
            from local_env import LocalEnv
            from remote_env import RemoteEnv
            from vast_env import VastEnv
            from modal_env import ModalEnv

        registry = {
            "local": LocalEnv,
            "remote": RemoteEnv,
            "vast": VastEnv,
            "modal": ModalEnv,
        }
        cls = registry.get(env_type)
        if cls is None:
            raise ValueError(
                f"unknown env_type {env_type!r}; expected one of "
                f"{sorted(registry)}"
            )
        return cls(config, state_dir=state_dir, dry_run=dry_run)

    # -- shared helpers --------------------------------------------------

    def _announce(self, action: str, cmd: str) -> dict:
        """Common dry-run return: describe what would run."""
        return {"status": "dry_run", "action": action, "command": cmd}

    # -- lifecycle (the contract) ---------------------------------------

    @abstractmethod
    def provision(self) -> dict:
        """Create/rent the environment (vast: vastai create; modal/remote/
        local: verify connectivity). Returns connection details."""

    @abstractmethod
    def preflight(self) -> dict:
        """GPU-availability / conda / connectivity check before running."""

    @abstractmethod
    def sync(self, src: str) -> dict:
        """Synchronize local code `src` to the environment."""

    @abstractmethod
    def deploy(self, run_spec: dict) -> dict:
        """Launch one job from `run_spec`. Returns a `handle` for monitor/
        collect/destroy. run_spec keys: script, args, gpu_id?, exp_name,
        log_file, env_vars?."""

    @abstractmethod
    def monitor(self, handle: dict) -> dict:
        """Query the status of a previously-deployed job (handle)."""

    @abstractmethod
    def collect_results(self) -> dict:
        """Download results/logs from the environment to the local host."""

    @abstractmethod
    def destroy(self) -> dict:
        """Tear the environment down (vast: destroy instance; modal:
        app stop + volume rm; remote/local: stop job)."""
