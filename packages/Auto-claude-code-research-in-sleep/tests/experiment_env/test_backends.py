#!/usr/bin/env python3
"""Tests for the four EnvBackend subclasses.

Mock `subprocess.run` so no real SSH/vastai/modal is invoked. Asserts the
generated commands match the SKILL.md originals and the factory handles
unknown env_type.
"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "tools" / "experiment_env"
sys.path.insert(0, str(PKG))

from env_backend import EnvBackend, EnvError  # noqa: E402
import local_env  # noqa: E402
import remote_env  # noqa: E402
import vast_env  # noqa: E402
import modal_env  # noqa: E402


def _run_ok(stdout="", rc=0):
    """A fake subprocess.run result for mocking env_backend.run."""
    r = mock.Mock()
    r.stdout = stdout
    r.returncode = rc
    r.stderr = ""
    return r


class FactoryTests(unittest.TestCase):
    def test_unknown_env_type_raises(self):
        with self.assertRaises(ValueError):
            EnvBackend.create("bogus", {})

    def test_creates_each_backend(self):
        self.assertIsInstance(EnvBackend.create("local", {}), local_env.LocalEnv)
        self.assertIsInstance(EnvBackend.create("remote", {"ssh_alias": "x",
                                     "code_dir": "/p"}), remote_env.RemoteEnv)
        self.assertIsInstance(EnvBackend.create("vast", {"instance_id": 1}),
                              vast_env.VastEnv)
        self.assertIsInstance(EnvBackend.create("modal", {}), modal_env.ModalEnv)


class LocalDeployTests(unittest.TestCase):
    def test_cuda_deploy_uses_cuda_visible_devices_and_tee(self):
        env = LocalEnv = EnvBackend.create("local", {"conda_env": "ml",
                                        "device": "cuda"}, dry_run=True)
        with mock.patch.object(local_env, "run") as m:
            m.return_value = ("12345\n", 0)
            r = env.deploy({"script": "train.py", "args": ["--epochs", "5"],
                            "gpu_id": 2, "exp_name": "e", "log_file": "e.log"})
        cmd = r["command"] if "command" in r else r.get("command", "")
        self.assertIn("CUDA_VISIBLE_DEVICES=2", cmd)
        self.assertIn("conda activate ml", cmd)
        self.assertIn("python train.py --epochs 5", cmd)
        self.assertIn("tee e.log", cmd)


class RemoteDeployTests(unittest.TestCase):
    def test_deploy_generates_screen_conda_cuda_tee(self):
        env = EnvBackend.create("remote", {
            "ssh_alias": "gpu-box", "conda_hook": 'eval "$(/opt/conda/bin/conda shell.bash hook)"',
            "conda_env": "research", "code_dir": "/home/u/exp/"}, dry_run=True)
        r = env.deploy({"script": "train.py", "args": ["--epochs", "5"],
                        "gpu_id": 2, "exp_name": "exp01", "log_file": "exp01.log"})
        cmd = r["command"]
        self.assertIn("ssh gpu-box", cmd)
        self.assertIn("screen -dmS exp01", cmd)
        self.assertIn("conda activate research", cmd)
        self.assertIn("CUDA_VISIBLE_DEVICES=2 python train.py --epochs 5", cmd)
        self.assertIn("tee exp01.log", cmd)
        # no rogue `&&` between python and the tee pipe
        self.assertNotIn("5 && 2>&1", cmd)


class VastTests(unittest.TestCase):
    def test_reuse_skips_rental(self):
        env = EnvBackend.create("vast", {"instance_id": 33799165,
            "ssh_host": "1.2.3.4", "ssh_port": 58955}, dry_run=True)
        with mock.patch.object(vast_env, "run") as m:
            r = env.provision()
            # reuse path should NOT call vastai create instance
            called = " ".join(str(c.args[0]) for c in m.call_args_list)
            self.assertNotIn("create instance", called)

    def test_reuse_deploy_uses_port_workspace_no_conda(self):
        env = EnvBackend.create("vast", {"instance_id": 1,
            "ssh_host": "h", "ssh_port": 22}, dry_run=True)
        r = env.deploy({"script": "train.py", "args": [], "gpu_id": 0,
                        "exp_name": "e", "log_file": "e.log"})
        cmd = r["command"]
        self.assertIn("ssh -p 22 root@h", cmd)
        self.assertIn("cd /workspace/project", cmd)
        self.assertIn("tee /workspace/e.log", cmd)
        self.assertNotIn("conda activate", cmd)

    def test_destroy_skips_when_auto_destroy_false(self):
        env = EnvBackend.create("vast", {"instance_id": 1,
            "auto_destroy": False}, dry_run=True)
        r = env.destroy()
        self.assertEqual(r["status"], "skipped")


class ModalLauncherTests(unittest.TestCase):
    def test_deploy_generates_pattern_a_with_all_fields(self):
        env = EnvBackend.create("modal", {
            "modal_gpu": "A100-80GB", "modal_timeout": 3600,
            "modal_volume": "exp-results", "modal_app_file": "train.py",
            "modal_secrets": ["wandb-secret"]}, dry_run=True)
        r = env.deploy({"script": "train.py", "args": ["--output_dir", "/results/run_001"],
                        "exp_name": "exp1"})
        code = r["launcher"]
        for needle in [
            "modal.App(", "modal.Image.debian_slim", "pip_install",
            "modal.Mount.from_local_dir", 'remote_path="/workspace"',
            'modal.Volume.from_name', "create_if_missing=True",
            "@app.function", 'gpu="A100-80GB"', "timeout=3600",
            'volumes={"/results": volume}',
            "modal.Secret.from_name", "volume.commit()",
            "@app.local_entrypoint", "train.remote()",
        ]:
            self.assertIn(needle, code, f"launcher missing {needle!r}")


if __name__ == "__main__":
    unittest.main()
