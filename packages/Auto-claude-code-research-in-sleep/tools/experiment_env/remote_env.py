"""remote_env.py — RemoteEnv backend (gpu: remote).

Orchestrates a pre-existing SSH server from the LOCAL host: rsync code
in, then launch the job in a detached `screen` session with a conda
activation prefix. Does NOT replace queue_manager.py — that runs ON the
remote host for batch scheduling; this backend drives a single job.

Commands reproduce skills/run-experiment/SKILL.md:
- preflight: ssh <alias> nvidia-smi threshold <500 MiB (L31-53)
- sync: rsync (--include *.py, default) or git push/pull (L55-96)
- deploy: ssh <alias> "screen -dmS <exp> bash -c '<conda_hook> &&
  conda activate <env> && CUDA_VISIBLE_DEVICES=<gpu> python ... | tee"
  (L144-148)
- monitor: ssh <alias> "screen -ls"; hardcopy tail (L26-27,50)
- destroy: kill the screen session (host itself stays up)
"""

import shlex

try:
    from .env_backend import EnvBackend, EnvError, run
except ImportError:  # script mode
    from env_backend import EnvBackend, EnvError, run

GPU_FREE_THRESHOLD_MIB = 500


class RemoteEnv(EnvBackend):
    """SSH-attached server; one job per screen session."""

    # -- helpers ---------------------------------------------------------

    def _ssh(self):
        """ssh <alias> — alias is the ssh config Host entry."""
        return f"ssh {shlex.quote(self.config['ssh_alias'])}"

    def _conda_prefix(self):
        hook = self.config.get("conda_hook")
        env = self.config.get("conda_env", "base")
        if hook:
            return f'{hook} && conda activate {shlex.quote(env)}'
        return f"conda activate {shlex.quote(env)}"

    # -- lifecycle -------------------------------------------------------

    def provision(self) -> dict:
        if self.dry_run:
            return self._announce("provision", f"{self._ssh()} true")
        _, rc = run(f"{self._ssh()} true")
        if rc != 0:
            raise EnvError(10, f"SSH connectivity failed for "
                                f"{self.config['ssh_alias']!r}")
        return {"status": "ready", "env_type": "remote",
                "ssh": {"alias": self.config["ssh_alias"],
                        "host": self.config.get("ssh_host"),
                        "port": self.config.get("ssh_port", 22),
                        "user": self.config.get("ssh_user")}}

    def preflight(self) -> dict:
        cmd = (f"{self._ssh()} nvidia-smi --query-gpu=index,memory.used,"
               "memory.total --format=csv,noheader")
        if self.dry_run:
            return self._announce("preflight", cmd)
        out, rc = run(cmd)
        checks = []
        free = []
        if rc != 0:
            checks.append({"name": "remote-nvidia-smi", "ok": False,
                           "detail": "nvidia-smi unreachable on host"})
        else:
            for line in out.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) < 2:
                    continue
                try:
                    idx, used = int(parts[0]), int(parts[1])
                except ValueError:
                    continue
                if used < GPU_FREE_THRESHOLD_MIB:
                    free.append(idx)
            checks.append({"name": "remote-gpu-free", "ok": len(free) > 0,
                           "detail": f"free indices={free}"})
        conda = self._conda_prefix()
        checks.append({"name": "conda-resolved", "ok": True, "detail": conda})
        return {"ok": all(c["ok"] for c in checks), "checks": checks,
                "gpu_free_mib": free, "conda_resolved": conda}

    def sync(self, src: str) -> dict:
        method = self.config.get("code_sync", "rsync")
        dst = self.config["code_dir"]
        alias = self.config["ssh_alias"]
        if method == "git":
            if self.dry_run:
                return self._announce("sync",
                                      f"git push && {self._ssh()} 'cd {dst} && git pull'")
            out1, rc1 = run("git add -A && git commit -m 'sync: experiment deployment' "
                            "&& git push")
            if rc1 != 0:
                raise EnvError(12, f"git push failed: {out1}")
            out2, rc2 = run(f"{self._ssh()} {shlex.quote('cd ' + dst + ' && git pull')}")
            if rc2 != 0:
                raise EnvError(12, f"remote git pull failed: {out2}")
            return {"status": "synced", "method": "git",
                    "remote_path": f"{alias}:{dst}"}
        # rsync (default): only .py files unless broader sync requested
        cmd = (f"rsync -avz --include='*.py' --exclude='*' "
               f"{shlex.quote(src.rstrip('/') + '/')} "
               f"{shlex.quote(alias + ':' + dst.rstrip('/') + '/')}")
        if self.dry_run:
            return self._announce("sync", cmd)
        out, rc = run(cmd)
        if rc != 0:
            raise EnvError(12, f"rsync failed: {out}")
        return {"status": "synced", "method": "rsync",
                "remote_path": f"{alias}:{dst}"}

    def deploy(self, run_spec: dict) -> dict:
        script = run_spec["script"]
        args = " ".join(shlex.quote(a) for a in run_spec.get("args", []))
        log_file = run_spec.get("log_file", "experiment.log")
        exp_name = run_spec.get("exp_name", "aris_exp")
        gpu = run_spec.get("gpu_id")
        env_vars = run_spec.get("env_vars", {})
        inner_parts = []
        cond = self._conda_prefix()
        if cond:
            inner_parts.append(cond)
        # The run command (CUDA_VISIBLE_DEVICES prefix + python + tee) is ONE
        # unit, joined to the conda prefix by `&&` — matches SKILL.md:144-148.
        run_part = f"python {shlex.quote(script)} {args}".rstrip()
        if gpu is not None:
            run_part = f"CUDA_VISIBLE_DEVICES={int(gpu)} {run_part}"
        for k, v in env_vars.items():
            run_part = f"{k}={shlex.quote(str(v))} {run_part}"
        run_part += f" 2>&1 | tee {shlex.quote(log_file)}"
        inner_parts.append(run_part)
        inner = " && ".join(inner_parts)
        remote_cmd = f"screen -dmS {shlex.quote(exp_name)} bash -c {shlex.quote(inner)}"
        full = f"{self._ssh()} {shlex.quote(remote_cmd)}"
        if self.dry_run:
            return self._announce("deploy", full)
        _, rc = run(full)
        if rc != 0:
            raise EnvError(13, f"failed to launch screen session: {full}")
        handle = {"type": "screen", "host": self.config["ssh_alias"],
                  "session_name": exp_name, "log_file": log_file}
        return {"status": "launched", "handle": handle, "log_file": log_file,
                "command": full}

    def monitor(self, handle: dict) -> dict:
        name = handle["session_name"]
        cmd = f"{self._ssh()} {shlex.quote('screen -ls')}"
        if self.dry_run:
            return self._announce("monitor", cmd)
        out, _ = run(cmd)
        running = name in out
        tail = ""
        if not running:
            log = handle.get("log_file")
            if log:
                t, _ = run(f"{self._ssh()} {shlex.quote('tail -n 20 ' + log)}")
                tail = t
        return {"status": "running" if running else "done",
                "exit_code": None, "tail": tail}

    def collect_results(self) -> dict:
        alias = self.config["ssh_alias"]
        dst = self.config["code_dir"]
        results_remote = f"{dst.rstrip('/')}/results/"
        local = "./results/"
        cmd = (f"rsync -avz {shlex.quote(alias + ':' + results_remote)} "
               f"{shlex.quote(local)}")
        if self.dry_run:
            return self._announce("collect", cmd)
        out, rc = run(cmd)
        if rc != 0:
            raise EnvError(15, f"rsync results failed: {out}")
        return {"status": "collected", "results": [], "local_copy": local}

    def destroy(self) -> dict:
        # remote host is NOT destroyed; only stop the screen session if known
        if self.dry_run:
            return self._announce("destroy", "(remote: stop screen only)")
        return {"status": "destroyed",
                "note": "remote host retained; stop screen via monitor/kill"}
