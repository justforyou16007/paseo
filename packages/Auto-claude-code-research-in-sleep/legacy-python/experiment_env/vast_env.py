"""vast_env.py — VastEnv backend (gpu: vast).

Absorbs the vast-gpu skill's Rent/Setup/Destroy logic into the helper.
Two provision modes:
  - reuse: `instance_id` present in config → verify SSH via `vastai ssh-url`,
    parse ssh://root@HOST:PORT, write vast-instances.json. No rental.
  - fresh: `instance_id` absent → search offers, create instance, poll
    until running, get ssh-url, verify, write vast-instances.json.

Deploy uses NO conda (Docker image is the env), cwd /workspace/project.
Destroy respects `auto_destroy` (default rule applied by parse_env):
fresh rental (no instance_id) → True; reuse → False.

Commands reproduce:
- skills/vast-gpu/SKILL.md Rent (152-234), Setup (236-272), Destroy (274-317)
- skills/run-experiment/SKILL.md vast sync (79-95), deploy (154-159),
  auto-destroy (216-247)

State file: <state_dir>/vast-instances.json (schema matches the existing
one so /run-experiment and /monitor-experiment keep working).
"""

import json
import shlex
import time
from pathlib import Path

try:
    from .env_backend import EnvBackend, EnvError, run
except ImportError:  # script mode
    from env_backend import EnvBackend, EnvError, run

VAST_STATE = "vast-instances.json"
DEFAULT_IMAGE = "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel"


class VastEnv(EnvBackend):
    """Vast.ai rental instance; one job per screen session, no conda."""

    # -- state file ------------------------------------------------------

    def _state_path(self):
        return Path(self.state_dir) / VAST_STATE

    def _load_instances(self):
        p = self._state_path()
        if p.exists():
            return json.loads(p.read_text())
        return []

    def _save_instances(self, instances):
        p = self._state_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = str(p) + ".tmp"
        Path(tmp).write_text(json.dumps(instances, indent=2) + "\n")
        import os
        os.replace(tmp, p)

    def _find_instance(self, instance_id):
        for inst in self._load_instances():
            if str(inst.get("instance_id")) == str(instance_id):
                return inst
        return None

    def _upsert_instance(self, record):
        instances = self._load_instances()
        for i, inst in enumerate(instances):
            if str(inst.get("instance_id")) == str(record["instance_id"]):
                instances[i] = record
                break
        else:
            instances.append(record)
        self._save_instances(instances)

    @staticmethod
    def _parse_ssh_url(url):
        """ssh://root@HOST:PORT -> (host, port, user)."""
        # tolerate ssh://user@host:port
        rest = url
        if rest.startswith("ssh://"):
            rest = rest[len("ssh://"):]
        user = "root"
        if "@" in rest:
            user, rest = rest.split("@", 1)
        host, _, port = rest.partition(":")
        return host, int(port) if port else 22, user

    # -- lifecycle -------------------------------------------------------

    def provision(self) -> dict:
        cfg = self.config
        instance_id = cfg.get("instance_id")
        if instance_id:
            return self._provision_reuse(instance_id)
        return self._provision_fresh()

    def _provision_reuse(self, instance_id) -> dict:
        """Verify an existing instance; resolve its SSH url."""
        cmd = f"vastai ssh-url {shlex.quote(str(instance_id))}"
        if self.dry_run:
            return self._announce("provision-reuse", cmd)
        out, rc = run(cmd)
        if rc != 0 or "ssh://" not in out:
            raise EnvError(10, f"vastai ssh-url failed for {instance_id}: {out}")
        url = out.strip().splitlines()[-1].strip()
        host, port, user = self._parse_ssh_url(url)
        # verify
        verify = (f"ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "
                  f"-p {port} {user}@{host} \"nvidia-smi && echo CONNECTION_OK\"")
        vout, vrc = run(verify)
        if vrc != 0 or "CONNECTION_OK" not in vout:
            raise EnvError(10, f"SSH verify failed for instance {instance_id}: {vout}")
        # upsert state (minimal record; keep existing if present)
        existing = self._find_instance(instance_id) or {}
        existing.update({"instance_id": instance_id, "ssh_host": host,
                         "ssh_port": port, "ssh_user": user,
                         "ssh_url": url, "status": "running"})
        self._upsert_instance(existing)
        return {"status": "ready", "env_type": "vast",
                "instance_id": instance_id,
                "ssh": {"host": host, "port": port, "user": user}}

    def _provision_fresh(self) -> dict:
        """Rent a new instance. NOTE: offer selection (cost optimization)
        is presented to the user by the calling SKILL; this backend expects
        an `offer_id` (and optional disk_gb) in the config or run_spec."""
        cfg = self.config
        offer_id = cfg.get("offer_id")
        image = cfg.get("image", DEFAULT_IMAGE)
        disk = cfg.get("disk_gb", 10)
        onstart = "apt-get update && apt-get install -y git screen rsync"
        create = (f"vastai create instance {shlex.quote(str(offer_id))} "
                  f"--image {shlex.quote(image)} --disk {disk} --ssh --direct "
                  f"--onstart-cmd {shlex.quote(onstart)}")
        if self.dry_run:
            return self._announce("provision-fresh", create)
        if not offer_id:
            raise EnvError(10, "fresh vast rental requires `offer_id` in config "
                               "(the SKILL presents cost options first)")
        out, rc = run(create)
        if rc != 0 or "new_contract" not in out:
            raise EnvError(10, f"vastai create instance failed: {out}")
        # parse new_contract id
        instance_id = None
        for tok in out.replace("'", " ").replace(",", " ").split():
            if tok.isdigit():
                instance_id = tok
                break
        if not instance_id:
            raise EnvError(10, f"could not parse instance id from: {out}")
        # poll until running
        for _ in range(15):
            s, _ = run(f"vastai show instances --raw")
            try:
                insts = json.loads(s)
                st = next((i.get("actual_status") for i in insts
                           if str(i.get("id")) == str(instance_id)), None)
            except Exception:
                st = None
            if st == "running":
                break
            time.sleep(20)
        else:
            raise EnvError(10, f"instance {instance_id} did not reach running")
        # ssh-url
        url_out, _ = run(f"vastai ssh-url {instance_id}")
        host, port, user = self._parse_ssh_url(url_out.strip().splitlines()[-1])
        record = {"instance_id": int(instance_id), "gpu_name": cfg.get("gpu_name"),
                  "num_gpus": cfg.get("num_gpus"), "dph": cfg.get("dph"),
                  "ssh_url": url_out.strip(), "ssh_host": host,
                  "ssh_port": port, "ssh_user": user, "status": "running",
                  "image": image, "experiment": None,
                  "estimated_hours": None, "estimated_cost": None}
        self._upsert_instance(record)
        return {"status": "ready", "env_type": "vast",
                "instance_id": int(instance_id),
                "ssh": {"host": host, "port": port, "user": user}}

    def preflight(self) -> dict:
        inst = self._resolve_ssh()
        host, port, user = inst
        cmd = (f"ssh -o StrictHostKeyChecking=no -p {port} {user}@{host} "
               "'nvidia-smi --query-gpu=index,memory.used --format=csv,noheader'")
        if self.dry_run:
            return self._announce("preflight", cmd)
        out, rc = run(cmd)
        free = []
        if rc == 0:
            for line in out.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                try:
                    idx, used = int(parts[0]), int(parts[1])
                except (ValueError, IndexError):
                    continue
                if used < 500:
                    free.append(idx)
        checks = [{"name": "vast-gpu-free", "ok": len(free) > 0,
                   "detail": f"free indices={free}"}]
        # torch import check (Setup Step 3, SKILL.md:265-272)
        torch_out, _ = run(
            f"ssh -o StrictHostKeyChecking=no -p {port} {user}@{host} "
            "\"cd /workspace/project && python -c 'import torch; "
            "print(torch.cuda.is_available())'\"")
        checks.append({"name": "vast-torch", "ok": "True" in torch_out,
                       "detail": torch_out.strip() or "torch unavailable"})
        return {"ok": all(c["ok"] for c in checks), "checks": checks,
                "gpu_free_mib": free, "conda_resolved": None}

    def _resolve_ssh(self):
        """Resolve (host, port, user). Priority:
        1. config ssh_host/ssh_port/ssh_user (reuse mode, set by agent/parse)
        2. vast-instances.json record for instance_id (written by provision)
        3. `vastai ssh-url <instance_id>` (last resort, needs vastai CLI)"""
        # 1. config-provided ssh fields
        if self.config.get("ssh_host"):
            return (self.config["ssh_host"],
                    int(self.config.get("ssh_port", 22)),
                    self.config.get("ssh_user", "root"))
        # 2. state file
        instance_id = self.config.get("instance_id")
        inst = self._find_instance(instance_id) if instance_id else None
        if inst and inst.get("ssh_host"):
            return inst["ssh_host"], inst.get("ssh_port", 22), inst.get("ssh_user", "root")
        # 3. vastai ssh-url
        if not instance_id:
            raise EnvError(11, "no vast instance_id to resolve SSH for")
        out, rc = run(f"vastai ssh-url {instance_id}")
        if rc != 0 or "ssh://" not in out:
            raise EnvError(11, f"cannot resolve ssh-url for {instance_id}: {out}")
        return self._parse_ssh_url(out.strip().splitlines()[-1])

    def sync(self, src: str) -> dict:
        host, port, user = self._resolve_ssh()
        dst = self.config.get("code_dir", "/workspace/project/")
        cmd = (f"rsync -avz -e {shlex.quote('ssh -p ' + str(port))} "
               "--include='*.py' --include='*.yaml' --include='*.yml' "
               "--include='*.json' --include='*.txt' --include='*.sh' "
               "--include='*/' --exclude='*.pt' --exclude='*.pth' "
               "--exclude='*.ckpt' --exclude='__pycache__' --exclude='.git' "
               "--exclude='data/' --exclude='wandb/' --exclude='outputs/' "
               f"{shlex.quote(src.rstrip('/') + '/')} "
               f"{user}@{host}:{shlex.quote(dst.rstrip('/') + '/')}")
        if self.dry_run:
            return self._announce("sync", cmd)
        out, rc = run(cmd)
        if rc != 0:
            raise EnvError(12, f"vast rsync failed: {out}")
        # requirements install (if present)
        req = Path(src) / "requirements.txt"
        if req.exists():
            run(f"scp -P {port} {shlex.quote(str(req))} {user}@{host}:/workspace/")
            run(f"ssh -p {port} {user}@{host} "
                f"{shlex.quote('pip install -q -r /workspace/requirements.txt')}")
        return {"status": "synced", "method": "rsync",
                "remote_path": f"{user}@{host}:{dst}"}

    def deploy(self, run_spec: dict) -> dict:
        host, port, user = self._resolve_ssh()
        script = run_spec["script"]
        args = " ".join(shlex.quote(a) for a in run_spec.get("args", []))
        log_file = run_spec.get("log_file", "experiment.log")
        exp_name = run_spec.get("exp_name", "aris_exp")
        gpu = run_spec.get("gpu_id")
        work = self.config.get("code_dir", "/workspace/project/")
        inner_parts = [f"cd {shlex.quote(work.rstrip('/'))}"]
        # CUDA_VISIBLE_DEVICES prefix + python + tee is ONE unit (no conda on
        # vast — the Docker image is the env). Matches SKILL.md:154-159.
        run_part = f"python {shlex.quote(script)} {args}".rstrip()
        if gpu is not None:
            run_part = f"CUDA_VISIBLE_DEVICES={int(gpu)} {run_part}"
        run_part += f" 2>&1 | tee /workspace/{shlex.quote(log_file)}"
        inner_parts.append(run_part)
        inner = " && ".join(inner_parts)
        remote = f"screen -dmS {shlex.quote(exp_name)} bash -c {shlex.quote(inner)}"
        full = f"ssh -p {port} {user}@{host} {shlex.quote(remote)}"
        if self.dry_run:
            return self._announce("deploy", full)
        _, rc = run(full)
        if rc != 0:
            raise EnvError(13, f"vast deploy failed: {full}")
        # mark experiment on the instance
        instance_id = self.config.get("instance_id")
        if instance_id:
            inst = self._find_instance(instance_id) or {"instance_id": instance_id}
            inst["experiment"] = exp_name
            self._upsert_instance(inst)
        handle = {"type": "screen", "host": host, "port": port, "user": user,
                  "session_name": exp_name, "log_file": f"/workspace/{log_file}",
                  "instance_id": instance_id}
        return {"status": "launched", "handle": handle,
                "log_file": f"/workspace/{log_file}", "command": full}

    def monitor(self, handle: dict) -> dict:
        name = handle["session_name"]
        port = handle.get("port", 22)
        user = handle.get("user", "root")
        host = handle["host"]
        cmd = f"ssh -p {port} {user}@{host} {shlex.quote('screen -ls')}"
        if self.dry_run:
            return self._announce("monitor", cmd)
        out, _ = run(cmd)
        running = name in out
        tail = ""
        if not running and handle.get("log_file"):
            t, _ = run(f"ssh -p {port} {user}@{host} "
                       f"{shlex.quote('tail -n 20 ' + handle['log_file'])}")
            tail = t
        return {"status": "running" if running else "done",
                "exit_code": None, "tail": tail}

    def collect_results(self) -> dict:
        host, port, user = self._resolve_ssh()
        cmd = (f"rsync -avz -e {shlex.quote('ssh -p ' + str(port))} "
               f"{user}@{host}:/workspace/project/results/ ./results/")
        if self.dry_run:
            return self._announce("collect", cmd)
        out, rc = run(cmd)
        if rc != 0:
            raise EnvError(15, f"vast collect results failed: {out}")
        # also grab logs
        run(f"scp -P {port} {user}@{host}:/workspace/*.log ./logs/ 2>/dev/null")
        return {"status": "collected", "results": [], "local_copy": "./results/"}

    def destroy(self) -> dict:
        instance_id = self.config.get("instance_id")
        auto = self.config.get("auto_destroy", True)
        if not auto:
            return {"status": "skipped",
                    "note": "auto_destroy=false; instance retained"}
        if not instance_id:
            raise EnvError(16, "cannot destroy: no instance_id")
        if self.dry_run:
            return self._announce("destroy", f"vastai destroy instance {instance_id}")
        # collect first (results), then destroy, then update state
        try:
            self.collect_results()
        except EnvError:
            pass  # results may already be collected; proceed to destroy
        out, rc = run(f"vastai destroy instance {shlex.quote(str(instance_id))}")
        if rc != 0:
            raise EnvError(16, f"vastai destroy instance failed: {out}")
        inst = self._find_instance(instance_id) or {"instance_id": instance_id}
        inst["status"] = "destroyed"
        self._upsert_instance(inst)
        return {"status": "destroyed", "instance_id": instance_id}
