"""local_env.py — LocalEnv backend (gpu: local).

Runs the training script directly on this host. No SSH, no provisioning.
Conda env may be activated if specified. Mac MPS vs Linux CUDA detected.

Commands reproduce skills/run-experiment/SKILL.md:
- preflight: nvidia-smi (Linux) / torch.mps (Mac), threshold <500 MiB (L31-53)
- deploy: CUDA_VISIBLE_DEVICES=<gpu> python <script> <args> | tee <log>
  (L179-187); Mac MPS omits CUDA_VISIBLE_DEVICES.
"""

import os
import platform
import shlex

try:
    from .env_backend import EnvBackend, EnvError, run
except ImportError:  # script mode
    from env_backend import EnvBackend, EnvError, run

GPU_FREE_THRESHOLD_MIB = 500


class LocalEnv(EnvBackend):
    """Local host: run jobs in-process (or background screen if long)."""

    # -- helpers ---------------------------------------------------------

    def _device(self):
        return self.config.get("device") or self._detect_device()

    @staticmethod
    def _detect_device():
        if platform.system() == "Darwin":
            return "mps"
        # cheap CUDA probe
        _, rc = run("command -v nvidia-smi >/dev/null 2>&1")
        return "cuda" if rc == 0 else "cpu"

    def _conda_prefix(self):
        hook = self.config.get("conda_hook")
        if hook:
            return hook + " && conda activate " + shlex.quote(self.config.get("conda_env", "base"))
        env = self.config.get("conda_env")
        if env and env != "base":
            return f"conda activate {shlex.quote(env)}"
        return ""

    # -- lifecycle -------------------------------------------------------

    def provision(self) -> dict:
        if self.dry_run:
            return self._announce("provision", "(local: no-op)")
        device = self._device()
        return {"status": "ready", "env_type": "local", "device": device}

    def preflight(self) -> dict:
        device = self._device()
        checks = []
        gpu_free = None
        if device == "cuda":
            out, rc = run(
                "nvidia-smi --query-gpu=index,memory.used,memory.total "
                "--format=csv,noheader"
            )
            if rc != 0:
                checks.append({"name": "nvidia-smi", "ok": False, "detail": "nvidia-smi unavailable"})
            else:
                free = []
                for line in out.strip().splitlines():
                    parts = [p.strip() for p in line.split(",")]
                    if len(parts) < 3:
                        continue
                    try:
                        idx, used = int(parts[0]), int(parts[1])
                    except ValueError:
                        continue
                    free.append((idx, used) if used < GPU_FREE_THRESHOLD_MIB else None)
                free_idx = [i for i, _ in free if i is not None]
                gpu_free = free_idx
                checks.append({"name": "cuda-gpu-free",
                               "ok": len(free_idx) > 0,
                               "detail": f"free indices={free_idx} "
                                         f"(threshold <{GPU_FREE_THRESHOLD_MIB} MiB)"})
        elif device == "mps":
            out, rc = run(
                'python -c "import torch; '
                "print('MPS available:', torch.backends.mps.is_available())\""
            )
            checks.append({"name": "mps-available", "ok": rc == 0 and "True" in out,
                           "detail": out.strip() or "torch import failed"})
        else:
            checks.append({"name": "device", "ok": True,
                           "detail": f"device={device} (no GPU preflight)"})
        conda = self._conda_prefix()
        if conda:
            checks.append({"name": "conda-resolved", "ok": True, "detail": conda})
        ok = all(c["ok"] for c in checks)
        return {"ok": ok, "checks": checks,
                "gpu_free_mib": gpu_free, "conda_resolved": conda or None,
                "device": device}

    def sync(self, src: str) -> dict:
        # local: code already present; no-op
        if self.dry_run:
            return self._announce("sync", f"(local no-op: {src})")
        return {"status": "synced", "method": "local_noop", "remote_path": src}

    def deploy(self, run_spec: dict) -> dict:
        script = run_spec["script"]
        args = " ".join(shlex.quote(a) for a in run_spec.get("args", []))
        log_file = run_spec.get("log_file", "experiment.log")
        env_vars = run_spec.get("env_vars", {})
        prefix = self._conda_prefix()
        # The run command (CUDA_VISIBLE_DEVICES prefix + python + tee) is ONE
        # unit, joined to the conda prefix by `&&` (matches remote style).
        run_part = f"python {shlex.quote(script)} {args}".rstrip()
        if self._device() == "cuda" and "gpu_id" in run_spec:
            run_part = f"CUDA_VISIBLE_DEVICES={int(run_spec['gpu_id'])} {run_part}"
        for k, v in env_vars.items():
            run_part = f"{k}={shlex.quote(str(v))} {run_part}"
        run_part += f" 2>&1 | tee {shlex.quote(log_file)}"
        cmd_parts = []
        if prefix:
            cmd_parts.append(prefix)
        cmd_parts.append(run_part)
        cmd = " && ".join(cmd_parts)
        if self.dry_run:
            return self._announce("deploy", cmd)
        # Launch detached so the CLI returns; caller polls via monitor.
        full = f"nohup bash -c {shlex.quote(cmd)} >/dev/null 2>&1 & echo $!"
        out, rc = run(full)
        if rc != 0 or not out.strip():
            raise EnvError(13, f"failed to launch local job: {cmd}")
        pid = out.strip().splitlines()[-1]
        handle = {"type": "local_pid", "pid": int(pid) if pid.isdigit() else pid,
                  "session_name": run_spec.get("exp_name", "local_exp"),
                  "log_file": log_file}
        return {"status": "launched", "handle": handle, "log_file": log_file,
                "command": cmd}

    def monitor(self, handle: dict) -> dict:
        pid = handle.get("pid")
        if not isinstance(pid, int):
            return {"status": "unknown", "tail": "", "exit_code": None}
        if self.dry_run:
            return self._announce("monitor", f"kill -0 {pid}")
        _, rc = run(f"kill -0 {pid} 2>/dev/null")
        if rc == 0:
            return {"status": "running", "exit_code": None, "tail": ""}
        # process gone — try last log tail
        tail = ""
        log = handle.get("log_file")
        if log and os.path.exists(log):
            t, _ = run(f"tail -n 20 {shlex.quote(log)}")
            tail = t
        return {"status": "done", "exit_code": None, "tail": tail}

    def collect_results(self) -> dict:
        # local: results already on host
        if self.dry_run:
            return self._announce("collect", "(local no-op)")
        return {"status": "collected", "results": [], "local_copy": "."}

    def destroy(self) -> dict:
        # local: nothing to destroy (caller may kill the pid via monitor)
        if self.dry_run:
            return self._announce("destroy", "(local no-op)")
        return {"status": "destroyed"}
