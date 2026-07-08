#!/usr/bin/env python3
"""Regression test for install_aris.sh registered-subagent distribution.

Covers the `agent` managed-entry kind (agents/<name>.md -> <project>/.claude/agents/<name>.md):
  install: fresh project gets `.claude/agents/<name>.md` -> <repo>/agents/<name>.md
  install: agent row recorded in the manifest with kind=agent + correct source/target rels
  install: idempotent on rerun
  uninstall: removes the managed agent symlink
  uninstall: preserves a user-created agent file (not managed)
  dry-run: prints planned action without writing anything
"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SCRIPT = REPO_ROOT / "tools" / "install_aris.sh"
AGENT_NAME = "experiment-analysis-agent"
REPO_AGENT = REPO_ROOT / "agents" / f"{AGENT_NAME}.md"


def _manifest(project: Path) -> str:
    return (project / ".aris" / "installed-skills.txt").read_text()


class AgentInstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="aris-agent-"))
        self.project = self.tmp / "project"
        self.project.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, *extra_args):
        return subprocess.run(
            [
                "bash",
                str(INSTALL_SCRIPT),
                str(self.project),
                "--aris-repo",
                str(REPO_ROOT),
                "--quiet",
                "--no-doc",
                *extra_args,
            ],
            capture_output=True,
            text=True,
        )

    def _agent_link(self):
        return self.project / ".claude" / "agents" / f"{AGENT_NAME}.md"

    # ─── install behaviour ────────────────────────────────────────────────

    def test_install_creates_agent_symlink(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        link = self._agent_link()
        self.assertTrue(link.is_symlink(), f"expected {link} to be a symlink")
        self.assertEqual(
            os.readlink(link),
            str(REPO_AGENT),
            "managed agent symlink must point to the canonical repo agents/ source",
        )

    def test_install_records_agent_manifest_row(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        text = _manifest(self.project)
        # kind \t name \t source_rel \t target_rel \t mode
        expected_row = "\t".join([
            "agent",
            AGENT_NAME,
            f"agents/{AGENT_NAME}.md",
            f".claude/agents/{AGENT_NAME}.md",
            "symlink",
        ])
        self.assertIn(expected_row, text, f"manifest must record agent row:\n{text}")

    def test_install_is_idempotent(self):
        self._run()
        result = self._run()
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        link = self._agent_link()
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.readlink(link), str(REPO_AGENT))

    def test_install_dry_run_does_not_create_symlink(self):
        result = subprocess.run(
            [
                "bash",
                str(INSTALL_SCRIPT),
                str(self.project),
                "--aris-repo",
                str(REPO_ROOT),
                "--no-doc",
                "--dry-run",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertFalse(self._agent_link().exists(), "dry-run must not create the agent symlink")
        # print_plan emits a CREATE count (80 skills + shared-references + 1 agent);
        # the agent is included in that count even though names are not listed.
        import re
        m = re.search(r"CREATE:\s+(\d+)", result.stdout)
        self.assertIsNotNone(m, "dry-run output must include a CREATE count")
        self.assertGreaterEqual(int(m.group(1)), 82, "CREATE count must include the agent")  # type: ignore[union-attr]

    # ─── uninstall behaviour ──────────────────────────────────────────────

    def test_uninstall_removes_managed_agent_symlink(self):
        self._run()
        self.assertTrue(self._agent_link().is_symlink())
        result = self._run("--uninstall")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertFalse(self._agent_link().exists(), "uninstall must remove the managed agent symlink")

    def test_uninstall_preserves_user_agent_file(self):
        # Install, then replace the managed symlink with a user-authored real file.
        self._run()
        link = self._agent_link()
        link.unlink()
        link.write_text("# my own agent, not managed\n")
        marker = link.read_text()

        result = self._run("--uninstall")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertTrue(link.is_file(), "user-created agent file must be preserved by uninstall")
        self.assertEqual(link.read_text(), marker)

    def test_reconcile_removes_agent_no_longer_upstream(self):
        # Seed a managed "ghost" agent: a manifest row + symlink pointing into the
        # real repo, for an agent name that does NOT exist under agents/. Reconcile
        # against the real repo must REMOVE it (compute_plan REMOVE for kind=agent,
        # apply_plan REMOVE with S1+S2 passing because the target is inside the repo).
        self._run()  # establishes a manifest + .claude/agents/ dir
        ghost = "ghost-analysis-agent"
        ghost_link = self.project / ".claude" / "agents" / f"{ghost}.md"
        # dangling symlink into the real repo (target resolves inside $ARIS_REPO)
        os.symlink(str(REPO_ROOT / "agents" / f"{ghost}.md"), str(ghost_link))

        # Append a managed row for the ghost so reconcile sees it as managed.
        manifest_path = self.project / ".aris" / "installed-skills.txt"
        manifest_path.write_text(
            manifest_path.read_text()
            + "\t".join([
                "agent", ghost, f"agents/{ghost}.md",
                f".claude/agents/{ghost}.md", "symlink",
            ]) + "\n"
        )

        result = self._run()  # reconcile (manifest exists)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertFalse(
            ghost_link.exists(),
            "reconcile must REMOVE a managed agent symlink no longer upstream",
        )
        # the real agent is unaffected
        self.assertTrue(self._agent_link().is_symlink())


if __name__ == "__main__":
    unittest.main()
