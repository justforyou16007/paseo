#!/usr/bin/env python3
"""End-to-end tests for env_helper.py CLI (subprocess invocation).

Drives the real CLI as `python3 tools/experiment_env/env_helper.py <cmd>`
in a temp dir so the parse → info → dry-run deploy path is exercised
exactly as a consuming SKILL would invoke it.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_HELPER = REPO_ROOT / "tools" / "experiment_env" / "env_helper.py"


def _run(args, cwd, stdin=None):
    r = subprocess.run([sys.executable, str(ENV_HELPER), *args],
                       cwd=cwd, input=stdin, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


class ParseCliTests(unittest.TestCase):
    def test_parse_writes_file_and_prints_json(self):
        with tempfile.TemporaryDirectory() as d:
            cand = json.dumps({"env_type": "remote", "remote": {
                "ssh_alias": "x", "code_dir": "/p"}})
            rc, out, err = _run(["parse", "--json", "-", "--out",
                                 os.path.join(d, ".aris/env.json")],
                                cwd=d, stdin=cand)
            self.assertEqual(rc, 0, err)
            parsed = json.loads(out)
            self.assertEqual(parsed["env_type"], "remote")
            self.assertEqual(parsed["remote"]["ssh_port"], 22)
            self.assertTrue((Path(d) / ".aris/env.json").exists())

    def test_parse_missing_required_exits_1(self):
        with tempfile.TemporaryDirectory() as d:
            cand = json.dumps({"env_type": "remote", "remote": {"ssh_alias": "x"}})
            rc, out, err = _run(["parse", "--json", "-", "--stdout-only",
                                 "--out", os.path.join(d, "x.json")],
                                cwd=d, stdin=cand)
            self.assertEqual(rc, 1)
            self.assertIn("missing required", err)

    def test_no_config_exits_2(self):
        with tempfile.TemporaryDirectory() as d:
            rc, out, err = _run(["info", "--env-config", os.path.join(d, "nope.json")],
                                cwd=d)
            self.assertEqual(rc, 2)


class ActionCliTests(unittest.TestCase):
    def _setup(self, d, cand):
        # write to the CLI default path (.aris/experiment-env.json) so
        # subsequent action commands find it without --env-config.
        cand_json = json.dumps(cand)
        _run(["parse", "--json", "-", "--out",
              os.path.join(d, ".aris/experiment-env.json")],
             cwd=d, stdin=cand_json)

    def test_info_prints_fields(self):
        with tempfile.TemporaryDirectory() as d:
            self._setup(d, {"env_type": "remote", "remote": {
                "ssh_alias": "x", "code_dir": "/p"}})
            rc, out, err = _run(["info"], cwd=d)
            self.assertEqual(rc, 0, err)
            self.assertEqual(json.loads(out)["env_type"], "remote")

    def test_dry_run_deploy_remote(self):
        with tempfile.TemporaryDirectory() as d:
            self._setup(d, {"env_type": "remote", "remote": {
                "ssh_alias": "box", "conda_env": "r", "code_dir": "/p"}})
            rs = json.dumps({"script": "t.py", "args": [], "gpu_id": 0,
                             "exp_name": "e", "log_file": "e.log"})
            rspath = Path(d) / "rs.json"
            rspath.write_text(rs)
            rc, out, err = _run(["deploy", "--run-spec", str(rspath), "--dry-run"], cwd=d)
            self.assertEqual(rc, 0, err)
            cmd = json.loads(out)["command"]
            self.assertIn("ssh box", cmd)
            self.assertIn("screen -dmS e", cmd)

    def test_staleness_warns_when_source_changed(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "CLAUDE.md"
            src.write_text("env")
            cand = json.dumps({"env_type": "local", "local": {"conda_env": "m"}})
            _run(["parse", "--json", "-", "--source", str(src)], cwd=d, stdin=cand)
            # mutate source -> staleness should warn on next action
            src.write_text("env changed")
            rc, out, err = _run(["provision", "--dry-run"], cwd=d)
            self.assertEqual(rc, 0)
            self.assertIn("changed since last parse", err)


if __name__ == "__main__":
    unittest.main()
