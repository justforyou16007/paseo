"""Tests for analysis_tools.py — analysis-tool registry (personal long-running
collection; 3-tier progressive disclosure; mandatory per-tool test artifacts).

Run: python3 -m pytest tests/test_analysis_tools.py -q
  or: python3 tests/test_analysis_tools.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import analysis_tools as at  # noqa: E402

PYTHON = sys.executable


def _run(helper_env: dict, *args: str) -> tuple[int, str, str]:
    """Invoke the helper as a subprocess (covers arg parsing + main())."""
    env = {**os.environ, **helper_env}
    proc = subprocess.run(
        [PYTHON, str(TOOLS / "analysis_tools.py"), *args],
        capture_output=True, text=True, env=env)
    return proc.returncode, proc.stdout, proc.stderr


class TestRegistryRoot(unittest.TestCase):
    def test_env_override(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["ARIS_ANALYSIS_TOOLS_DIR"] = d
            try:
                self.assertEqual(at._registry_root(), Path(d).resolve())
            finally:
                del os.environ["ARIS_ANALYSIS_TOOLS_DIR"]

    def test_home_fallback(self):
        fakehome = tempfile.mkdtemp()
        code = (
            "import importlib.util, os; "
            f"os.environ['HOME']={fakehome!r}; "
            "os.environ.pop('ARIS_ANALYSIS_TOOLS_DIR', None); "
            "spec=importlib.util.spec_from_file_location('at', r'%s'); "
            "m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); "
            "print(m._registry_root())" % str(TOOLS / "analysis_tools.py"))
        out = subprocess.run([PYTHON, "-c", code], capture_output=True,
                             text=True, env={"HOME": fakehome})
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn(fakehome, out.stdout)


class TestRegisterAndDiscovery(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.env = {"ARIS_ANALYSIS_TOOLS_DIR": self.dir}
        # Fixtures: a passing unit test + test data.
        self.ut = Path(self.dir) / "_ut.py"
        self.ut.write_text('print("ok")\n', encoding="utf-8")
        self.ut_pass = Path(self.dir) / "tool-unit-test.py"
        self.ut_pass.write_text('print("ok")\n', encoding="utf-8")
        self.ut_fail = Path(self.dir) / "tool-unit-test-fail.py"
        self.ut_fail.write_text('import sys; sys.exit(1)\n', encoding="utf-8")
        self.data = Path(self.dir) / "data.csv"
        self.data.write_text("a,b\n1,2\n", encoding="utf-8")

    def _register(self, slug="t1", **extra):
        args = ["register", "--slug", slug, "--purpose", "ablation by removal",
                "--category", "ablation", "--procedure", "remove each module",
                "--script", str(self.ut_pass), "--resource", str(self.data)]
        store_true = {"update_on_exist", "skip_test"}
        for k, v in extra.items():
            flag = f"--{k.replace('_', '-')}"
            if k in store_true:
                if v:
                    args.append(flag)
            else:
                args += [flag, str(v)]
        return _run(self.env, *args)

    def test_register_rejects_missing_test_artifacts(self):
        rc, out, _ = _run(self.env, "register", "--slug", "x", "--purpose", "p",
                          "--category", "ablation", "--procedure", "p")
        self.assertEqual(rc, 2)
        self.assertIn("missing required test artifacts", out)

    def test_register_with_test_artifacts(self):
        rc, out, _ = self._register()
        self.assertEqual(rc, 0)
        rec = json.loads(out)
        self.assertEqual(rec["scripts"], ["tool-unit-test.py"])
        self.assertEqual(rec["references"], ["data.csv"])
        self.assertTrue(rec["test_required"])
        # SKILL.md + scripts + references written.
        root = Path(self.dir)
        self.assertTrue((root / "skills" / "t1" / "SKILL.md").is_file())
        self.assertTrue((root / "skills" / "t1" / "scripts" /
                         "tool-unit-test.py").is_file())
        self.assertTrue((root / "skills" / "t1" / "references" / "data.csv").is_file())

    def test_skip_test_records_visible_gap(self):
        rc, out, _ = _run(self.env, "register", "--slug", "nt", "--purpose", "p",
                          "--category", "ablation", "--procedure", "p",
                          "--skip-test")
        self.assertEqual(rc, 0)
        rec = json.loads(out)
        self.assertFalse(rec["test_required"])
        # stats reports it untested.
        _, sout, _ = _run(self.env, "stats")
        self.assertEqual(json.loads(sout)["untested"], 1)

    def test_duplicate_rejected_without_update(self):
        self._register()
        rc, out, _ = self._register()
        self.assertEqual(rc, 2)
        self.assertIn("already exists", out)

    def test_update_on_exist_overwrites(self):
        self._register()
        rc, out, _ = self._register(update_on_exist=True)
        self.assertEqual(rc, 0)
        self.assertTrue(json.loads(out)["updated_existing"])

    def test_query_browse_and_soft_match(self):
        self._register()
        # browse-all (no --query) replaces the former `list` subcommand.
        rc, out, _ = _run(self.env, "query")
        self.assertEqual(rc, 0)
        body = json.loads(out)
        self.assertEqual(body["count"], 1)
        self.assertIsNone(body["top_k"])
        self.assertEqual(body["matches"][0]["slug"], "t1")
        # browse rows carry L0 fields but no score.
        self.assertNotIn("score", body["matches"][0])
        # soft match (BM25): "ablation" ranks the registered tool, score>0.
        rc, out, _ = _run(self.env, "query", "--query", "ablation")
        body = json.loads(out)
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["top_k"], 5)
        self.assertGreater(body["matches"][0]["score"], 0)
        self.assertEqual(body["matches"][0]["slug"], "t1")
        # no shared terms → no matches (score>0 filter).
        rc, out, _ = _run(self.env, "query", "--query", "zzzznomatch")
        self.assertEqual(json.loads(out)["count"], 0)

    def test_query_bm25_ranks_and_caps(self):
        """BM25 ranks a term-unique tool to the top, and --top caps the result."""
        # three tools with distinct vocabularies
        specs = [
            ("abl", "per-module ablation contribution by removing components",
             "ablation", "Remove or replace each module."),
            ("sig", "is the gain real effect size bootstrap confidence intervals",
             "significance", ""),
            ("eff", "throughput latency memory flops cost per result",
             "efficiency", ""),
        ]
        for slug, purpose, cat, desc in specs:
            _run(self.env, "register", "--slug", slug, "--purpose", purpose,
                 "--name", slug + "-tool", "--description", desc,
                 "--category", cat, "--procedure", "p",
                 "--script", str(self.ut_pass), "--resource", str(self.data))
        # "ablation" only appears in abl → it ranks #1 with score>0.
        rc, out, _ = _run(self.env, "query", "--query", "ablation contribution")
        body = json.loads(out)
        self.assertEqual(body["matches"][0]["slug"], "abl")
        self.assertGreater(body["matches"][0]["score"], 0)
        # --top caps the number returned.
        rc, out, _ = _run(self.env, "query",
                          "--query", "result gain cost", "--top", "1")
        body = json.loads(out)
        self.assertEqual(body["top_k"], 1)
        self.assertLessEqual(body["count"], 1)

    def test_query_no_text_browses_all_active(self):
        self._register()
        rc, out, _ = _run(self.env, "query")
        body = json.loads(out)
        self.assertEqual(body["count"], 1)
        self.assertIsNone(body["query"])
        self.assertIsNone(body["top_k"])
        for m in body["matches"]:
            self.assertNotIn("score", m)


class TestProgressiveDisclosure(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.env = {"ARIS_ANALYSIS_TOOLS_DIR": self.dir}
        ut = Path(self.dir) / "tool-unit-test.py"
        ut.write_text('print("ok")\n', encoding="utf-8")
        data = Path(self.dir) / "data.csv"
        data.write_text("a,b\n1,2\n", encoding="utf-8")
        _run(self.env, "register", "--slug", "t1", "--purpose", "ablation",
             "--category", "ablation", "--procedure", "remove each module",
             "--script", str(ut), "--resource", str(data))

    def test_load_equals_get(self):
        _, load_out, _ = _run(self.env, "load", "--slug", "t1")
        _, get_out, _ = _run(self.env, "get", "--slug", "t1")
        self.assertEqual(load_out, get_out)
        self.assertIn("# t1", load_out)
        self.assertIn("## Procedure", load_out)

    def test_resource_list_and_name(self):
        _, out, _ = _run(self.env, "resource", "--slug", "t1", "--list")
        names = {r["name"] for r in json.loads(out)["resources"]}
        self.assertEqual(names, {"tool-unit-test.py", "data.csv"})
        _, content, _ = _run(self.env, "resource", "--slug", "t1",
                             "--name", "data.csv")
        self.assertIn("a,b", content)

    def test_load_json_structured(self):
        _, out, _ = _run(self.env, "load", "--slug", "t1", "--json")
        rec = json.loads(out)
        self.assertEqual(rec["slug"], "t1")
        self.assertEqual(rec["scripts"], ["tool-unit-test.py"])


class TestTestSubcommand(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.env = {"ARIS_ANALYSIS_TOOLS_DIR": self.dir}

    def _register_with(self, ut_name: str, ut_content: str):
        ut = Path(self.dir) / ut_name
        ut.write_text(ut_content, encoding="utf-8")
        data = Path(self.dir) / "data.csv"
        data.write_text("a\n1\n", encoding="utf-8")
        # register copies the file as tool-unit-test.py regardless of source name
        # only if source name == tool-unit-test.py; so name it correctly.
        rc, out, _ = _run(self.env, "register", "--slug", "t1", "--purpose", "p",
                          "--category", "ablation", "--procedure", "p",
                          "--script", str(ut), "--resource", str(data))
        assert rc == 0, out
        return ut

    def test_pass_records_true(self):
        self._register_with("tool-unit-test.py", 'print("ok")\n')
        rc, out, _ = _run(self.env, "test", "--slug", "t1")
        self.assertEqual(rc, 0)
        rec = json.loads(out)
        self.assertTrue(rec["pass"])
        self.assertEqual(rec["exit"], 0)
        # ledger has a test row.
        ledger = (Path(self.dir) / "registry.jsonl").read_text(encoding="utf-8")
        self.assertIn('"action": "test"', ledger)

    def test_fail_records_false_exit_nonzero(self):
        self._register_with("tool-unit-test.py", 'import sys; sys.exit(1)\n')
        rc, out, _ = _run(self.env, "test", "--slug", "t1")
        self.assertNotEqual(rc, 0)
        rec = json.loads(out)
        self.assertFalse(rec["pass"])

    def test_test_on_skip_test_tool_errors(self):
        _run(self.env, "register", "--slug", "nt", "--purpose", "p",
             "--category", "ablation", "--procedure", "p", "--skip-test")
        rc, out, _ = _run(self.env, "test", "--slug", "nt")
        self.assertEqual(rc, 2)
        self.assertIn("no tool-unit-test.py", out)


class TestSupersedesAndDeprecate(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.env = {"ARIS_ANALYSIS_TOOLS_DIR": self.dir}
        ut = Path(self.dir) / "tool-unit-test.py"
        ut.write_text('print("ok")\n', encoding="utf-8")
        data = Path(self.dir) / "data.csv"
        data.write_text("a\n1\n", encoding="utf-8")
        self.ut, self.data = ut, data
        _run(self.env, "register", "--slug", "old", "--purpose", "v1",
             "--category", "ablation", "--procedure", "p",
             "--script", str(ut), "--resource", str(data))

    def test_supersedes_auto_deprecates(self):
        rc, out, _ = _run(self.env, "register", "--slug", "new", "--purpose", "v2",
                          "--category", "ablation", "--procedure", "p2",
                          "--script", str(self.ut), "--resource", str(self.data),
                          "--supersedes", "old")
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["superseded"], "old")
        _, lout, _ = _run(self.env, "query", "--status", "deprecated")
        slugs = {t["slug"] for t in json.loads(lout)["matches"]}
        self.assertIn("old", slugs)
        _, aout, _ = _run(self.env, "query", "--status", "active")
        slugs = {t["slug"] for t in json.loads(aout)["matches"]}
        self.assertIn("new", slugs)

    def test_deprecate_and_stats(self):
        rc, _, _ = _run(self.env, "deprecate", "--slug", "old", "--reason", "x")
        self.assertEqual(rc, 0)
        _, out, _ = _run(self.env, "stats")
        st = json.loads(out)
        self.assertEqual(st["by_status"].get("deprecated", 0), 1)


if __name__ == "__main__":
    unittest.main()
