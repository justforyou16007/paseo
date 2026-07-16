"""docker_env.py — DockerEnv backend (gpu: docker).

Runs experiments in Docker containers. Supports bind-mounting local code
and results, building from Dockerfile or pulling pre-built images, GPU
passthrough, custom networks, volumes, and env vars.

Commands:
- provision: docker info (check Docker is running) + docker build / pull
- preflight: docker image inspect + nvidia-smi check if gpus configured
- sync: no-op (bind-mount)
- deploy: docker run -d with all configured flags
- monitor: docker inspect status + docker logs tail
- collect_results: no-op (bind-mount results to local)
- destroy: docker stop + docker rm (if auto_remove)
"""

import json as _json
import shlex
import os
from pathlib import Path

try:
    from .env_backend import EnvBackend, EnvError, run
except ImportError:  # script mode
    from env_backend import EnvBackend, EnvError, run

_STATE_FILE = "docker-state.json"


class DockerEnv(EnvBackend):
    """Docker container environment: runs jobs in isolated containers."""

    # -- helpers ---------------------------------------------------------

    def _container_name(self, run_spec=None):
        if run_spec and run_spec.get("exp_name"):
            return f"aris-{run_spec['exp_name']}"
        return "aris-experiment"

    def _state_path(self):
        return Path(self.state_dir) / _STATE_FILE

    def _save_state(self, state: dict):
        p = self._state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(_json.dumps(state, indent=2) + "\n")

    def _load_state(self) -> dict:
        p = self._state_path()
        if p.exists():
            return _json.loads(p.read_text())
        return {}

    # -- lifecycle -------------------------------------------------------

    def provision(self) -> dict:
        """Verify Docker is running, build/pull the requested image."""
        if self.dry_run:
            cmds = ["docker info"]
            if self.config.get("dockerfile"):
                build_ctx = self.config.get("build_context", ".")
                build_args = " ".join(f"--build-arg {shlex.quote(k)}={shlex.quote(v)}" for k, v in self.config.get("build_args", {}).items())
                cmds.append(f"docker build {build_args} -t aris-custom -f {shlex.quote(self.config['dockerfile'])} {shlex.quote(build_ctx)}")
            else:
                cmds.append(f"docker pull {shlex.quote(self.config.get('image', 'python:3.11'))}")
            return self._announce("provision", " && ".join(cmds))

        # Check Docker is available
        _, rc = run("docker info", check=False)
        if rc != 0:
            raise EnvError(10, "Docker not running or not accessible; install Docker and ensure it's running")

        image = self.config.get("image", "python:3.11")
        # Build from Dockerfile if provided
        if self.config.get("dockerfile"):
            build_ctx = self.config.get("build_context", ".")
            build_args = self.config.get("build_args", {})
            build_args_str = " ".join(f"--build-arg {shlex.quote(k)}={shlex.quote(v)}" for k, v in build_args.items())
            dockerfile_path = self.config["dockerfile"]
            # Use custom image name when building
            image = "aris-custom"
            build_cmd = f"docker build {build_args_str} -t {shlex.quote(image)} -f {shlex.quote(dockerfile_path)} {shlex.quote(build_ctx)}"
            _, rc = run(build_cmd, check=True)
        else:
            # Pull the image if not present
            _, rc = run(f"docker image inspect {shlex.quote(image)} >/dev/null 2>&1", check=False)
            if rc != 0:
                pull_cmd = f"docker pull {shlex.quote(image)}"
                _, rc = run(pull_cmd, check=True)

        return {"status": "ready", "env_type": "docker", "image": image}

    def preflight(self) -> dict:
        """Check image exists and GPU is available if configured."""
        checks = []
        image = self.config.get("image", "python:3.11")
        if self.config.get("dockerfile"):
            image = "aris-custom"

        # Check image exists
        if self.dry_run:
            checks.append({"name": "image-exists", "ok": True, "detail": f"dry-run: image {image} exists"})
        else:
            _, rc = run(f"docker image inspect {shlex.quote(image)} >/dev/null 2>&1", check=False)
            checks.append({
                "name": "image-exists",
                "ok": rc == 0,
                "detail": f"image {image} exists" if rc == 0 else f"image {image} not found"
            })

        # Check GPU if configured
        gpus = self.config.get("gpus")
        if gpus:
            if self.dry_run:
                checks.append({"name": "gpu-available", "ok": True, "detail": f"dry-run: gpus {gpus} available"})
            else:
                gpu_cmd = f"docker run --rm --gpus {shlex.quote(gpus)} {shlex.quote(image)} nvidia-smi"
                _, rc = run(gpu_cmd, check=False)
                checks.append({
                    "name": "gpu-available",
                    "ok": rc == 0,
                    "detail": "GPU passthrough works" if rc == 0 else "GPU passthrough failed; check NVIDIA Docker runtime is installed"
                })

        ok = all(c["ok"] for c in checks)
        return {"ok": ok, "checks": checks, "conda_resolved": None}

    def sync(self, src: str) -> dict:
        """No-op for bind-mount setup; code is already accessible via mount."""
        if self.dry_run:
            return self._announce("sync", f"(docker bind-mount no-op: {src})")
        return {
            "status": "synced",
            "method": "bind_mount",
            "remote_path": self.config.get("work_dir", "/workspace"),
            "local_src": src
        }

    def deploy(self, run_spec: dict) -> dict:
        """Launch the experiment in a detached Docker container."""
        image = self.config.get("image", "python:3.11")
        if self.config.get("dockerfile"):
            image = "aris-custom"

        container_name = self._container_name(run_spec)
        script = run_spec["script"]
        args = " ".join(shlex.quote(a) for a in run_spec.get("args", []))
        work_dir = self.config.get("work_dir", "/workspace")
        results_dir = self.config.get("results_dir", "/results")

        # Build docker run command parts
        cmd_parts = ["docker run -d", f"--name {shlex.quote(container_name)}"]

        # Add GPU flag if configured
        gpus = self.config.get("gpus")
        if gpus:
            cmd_parts.append(f"--gpus {shlex.quote(gpus)}")

        # Add shm size
        shm_size = self.config.get("shm_size", "16g")
        cmd_parts.append(f"--shm-size {shlex.quote(shm_size)}")

        # Add runtime if configured
        runtime = self.config.get("runtime")
        if runtime:
            cmd_parts.append(f"--runtime {shlex.quote(runtime)}")

        # Add network if configured
        network = self.config.get("network")
        if network:
            cmd_parts.append(f"--network {shlex.quote(network)}")

        # Add bind mounts: code, results, extra volumes
        # Code mount: local src -> work_dir
        cmd_parts.append(f"-v {shlex.quote(os.path.abspath('.'))}:{shlex.quote(work_dir)}")
        # Results mount: local ./results -> results_dir
        Path("./results").mkdir(parents=True, exist_ok=True)
        cmd_parts.append(f"-v {shlex.quote(os.path.abspath('./results'))}:{shlex.quote(results_dir)}")
        # Extra volumes
        for vol in self.config.get("volumes", []):
            cmd_parts.append(f"-v {shlex.quote(vol)}")

        # Add env vars (copy to avoid mutating config)
        env_vars = dict(self.config.get("env_vars", {}))
        # Merge run-specific env vars
        env_vars.update(run_spec.get("env_vars", {}))
        for k, v in env_vars.items():
            cmd_parts.append(f"-e {shlex.quote(k)}={shlex.quote(str(v))}")

        # Add work dir
        cmd_parts.append(f"-w {shlex.quote(work_dir)}")

        # Add image and command
        cmd_parts.append(shlex.quote(image))
        cmd_parts.append(f"python {shlex.quote(script)} {args}".rstrip())

        full_cmd = " ".join(cmd_parts)

        if self.dry_run:
            return self._announce("deploy", full_cmd)

        # Run the container
        out, rc = run(full_cmd, check=True)
        container_id = out.strip()

        handle = {
            "type": "docker_container",
            "container_id": container_id,
            "container_name": container_name,
            "image": image
        }

        # Persist state so destroy can find the container
        self._save_state({"container_name": container_name,
                          "container_id": container_id})

        return {
            "status": "launched",
            "handle": handle,
            "command": full_cmd,
            "container_id": container_id,
            "container_name": container_name
        }

    def monitor(self, handle: dict) -> dict:
        """Check container status and get latest logs."""
        container_id = handle.get("container_id") or handle.get("container_name")
        if not container_id:
            return {"status": "unknown", "tail": "", "exit_code": None}

        if self.dry_run:
            return self._announce("monitor", f"docker inspect {shlex.quote(container_id)} && docker logs --tail 50 {shlex.quote(container_id)}")

        # Get container status
        status_out, rc = run(f"docker inspect --format '{{{{.State.Status}}}}' {shlex.quote(container_id)}", check=False)
        if rc != 0:
            return {"status": "not_found", "tail": "", "exit_code": None}

        status = status_out.strip()
        running = status in ["running", "created", "restarting"]

        # Get last 50 lines of logs
        logs_out, _ = run(f"docker logs --tail 50 {shlex.quote(container_id)}", check=False)

        return {
            "status": "running" if running else "done",
            "exit_code": None,
            "tail": logs_out[-2000:]  # Last 2000 chars to keep it manageable
        }

    def collect_results(self) -> dict:
        """No-op for bind-mount setup; results are already on local disk."""
        if self.dry_run:
            return self._announce("collect", "(docker bind-mount no-op)")
        return {"status": "collected", "results": [], "local_copy": "./results/"}

    def destroy(self) -> dict:
        """Stop and remove the container if auto_remove is enabled."""
        auto_remove = self.config.get("auto_remove", True)
        # Recover container name from state saved by deploy, fall back to default
        state = self._load_state()
        container_name = state.get("container_name", self._container_name())

        if self.dry_run:
            cmds = []
            if auto_remove:
                cmds.append(f"docker stop {shlex.quote(container_name)}")
                cmds.append(f"docker rm {shlex.quote(container_name)}")
            else:
                cmds.append("(auto_remove=False: no destroy action)")
            return self._announce("destroy", " && ".join(cmds))

        stopped = False
        removed = False

        if auto_remove:
            # Stop container (ignore error if already stopped)
            run(f"docker stop {shlex.quote(container_name)}", check=False)
            stopped = True
            # Remove container (ignore error if already removed)
            run(f"docker rm {shlex.quote(container_name)}", check=False)
            removed = True

        return {
            "status": "destroyed",
            "container_stopped": stopped,
            "container_removed": removed,
            "auto_remove": auto_remove
        }
