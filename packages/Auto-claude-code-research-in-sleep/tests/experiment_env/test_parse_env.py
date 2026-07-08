#!/usr/bin/env python3
"""Tests for parse_env.validate — the validator+writer.

These test the VALIDATOR, not markdown parsing (the agent does markdown
→ candidate JSON; the validator checks the candidate). Covers the schema
(§2), defaults, the auto_destroy default rule, deprecated-alias warnings,
env_type validation, and the claude/codex schema-parity property.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PKG = REPO_ROOT / "tools" / "experiment_env"
sys.path.insert(0, str(PKG))

import parse_env  # noqa: E402


class ValidateRemoteTests(unittest.TestCase):
    def _remote(self, **extra):
        base = {"env_type": "remote", "remote": {
            "ssh_alias": "gpu-box", "conda_env": "research",
            "code_dir": "/home/u/exp/"}}
        base["remote"].update(extra)
        return base

    def test_canonical_fields_pass_and_defaults_filled(self):
        v = parse_env.validate(self._remote())
        self.assertEqual(v["env_type"], "remote")
        self.assertEqual(v["remote"]["ssh_port"], 22)        # default
        self.assertEqual(v["remote"]["code_sync"], "rsync")  # default
        self.assertEqual(v["remote"]["wandb"], False)        # default
        self.assertEqual(v["schema_version"], 1)
        self.assertEqual(v["remote"]["code_dir"], "/home/u/exp/")

    def test_missing_required_code_dir_errors(self):
        cand = {"env_type": "remote", "remote": {"ssh_alias": "x"}}
        with self.assertRaises(parse_env.ValidationError):
            parse_env.validate(cand)

    def test_wandb_project_required_when_wandb_true(self):
        cand = self._remote(wandb=True)
        with self.assertRaises(parse_env.ValidationError):
            parse_env.validate(cand)

    def test_unknown_field_warns_not_errors(self):
        v = parse_env.validate(self._remote(bogus=1))
        self.assertTrue(any("bogus" in w for w in v["warnings"]))

    def test_untranslated_markdown_tokens_rejected(self):
        # agent forgot to translate `Conda:` / `Code dir:` -> conda_hook/code_dir
        cand = {"env_type": "remote", "remote": {
            "ssh_alias": "x", "Conda": "...", "Code dir": "/p/"}}
        with self.assertRaises(parse_env.ValidationError):
            parse_env.validate(cand)


class AutoDestroyRuleTests(unittest.TestCase):
    def test_fresh_rental_defaults_true(self):
        v = parse_env.validate({"env_type": "vast",
                                "vast": {"max_budget": 5.0}})
        self.assertTrue(v["vast"]["auto_destroy"])

    def test_reuse_mode_defaults_false(self):
        v = parse_env.validate({"env_type": "vast",
                                "vast": {"instance_id": 33799165}})
        self.assertFalse(v["vast"]["auto_destroy"])

    def test_explicit_auto_destroy_wins(self):
        v = parse_env.validate({"env_type": "vast",
                                "vast": {"instance_id": 1, "auto_destroy": True}})
        self.assertTrue(v["vast"]["auto_destroy"])


class AliasWarningTests(unittest.TestCase):
    def test_codex_modal_app_alias_warns(self):
        v = parse_env.validate({"env_type": "modal", "modal": {
            "modal_app": "train.py", "modal_volume": "v"}})
        self.assertTrue(any("modal_app" in w and "deprecated" in w
                            for w in v["warnings"]))

    def test_modal_secrets_str_coerced_to_list(self):
        v = parse_env.validate({"env_type": "modal", "modal": {
            "modal_secrets": "wandb-secret"}})
        self.assertEqual(v["modal"]["modal_secrets"], ["wandb-secret"])


class EnvTypeTests(unittest.TestCase):
    def test_no_env_block_errors(self):
        with self.assertRaises(parse_env.ValidationError):
            parse_env.validate({"env_type": "remote"})

    def test_invalid_env_type_errors(self):
        with self.assertRaises(parse_env.ValidationError):
            parse_env.validate({"env_type": "bogus",
                                 "bogus": {"x": 1}})

    def test_env_type_must_match_present_block(self):
        with self.assertRaises(parse_env.ValidationError):
            parse_env.validate({"env_type": "local", "remote": {"ssh_alias": "x",
                                                                "code_dir": "/p"}})

    def test_env_type_override(self):
        v = parse_env.validate({"env_type": "remote", "local": {"conda_env": "ml"}},
                               env_type_override="local")
        self.assertEqual(v["env_type"], "local")


class ClaudeCodexParityTests(unittest.TestCase):
    """The agent translation guide must make claude (CLAUDE.md) and codex
    (AGENTS.md, with vast_instance/modal_app aliases) produce the SAME
    canonical schema after validation."""

    def test_vast_claude_vs_codex_same_schema(self):
        # claude (canonical) vs codex (vast_instance alias) -> agent translates
        claude = {"env_type": "vast", "vast": {"instance_id": 42,
                 "auto_destroy": False, "image": "img", "max_budget": 3.0}}
        codex_translated = {"env_type": "vast", "vast": {"instance_id": 42,
                 "auto_destroy": False, "image": "img", "max_budget": 3.0}}
        a = parse_env.validate(claude)
        b = parse_env.validate(codex_translated)
        self.assertEqual(a["vast"], b["vast"])

    def test_modal_claude_vs_codex_same_schema(self):
        # claude: modal_gpu/modal_timeout; codex: modal_app_file/modal_secrets
        # schema accepts the UNION (superset), so both validate.
        claude = {"env_type": "modal", "modal": {"modal_gpu": "A100-80GB",
                  "modal_timeout": 3600, "modal_volume": "v"}}
        codex = {"env_type": "modal", "modal": {"modal_app_file": "train.py",
                  "modal_secrets": ["wandb-secret"], "modal_volume": "v",
                  "modal_gpu": "A100-80GB", "modal_timeout": 3600}}
        a = parse_env.validate(claude)
        b = parse_env.validate(codex)
        # both have the same canonical fields present
        self.assertEqual(a["modal"]["modal_gpu"], b["modal"]["modal_gpu"])
        self.assertEqual(a["modal"]["modal_timeout"], b["modal"]["modal_timeout"])
        self.assertEqual(a["modal"]["modal_volume"], b["modal"]["modal_volume"])


class WriteConfigTests(unittest.TestCase):
    def test_write_creates_file_atomically(self):
        v = parse_env.validate({"env_type": "local", "local": {"conda_env": "ml"}})
        with tempfile.TemporaryDirectory() as d:
            out = parse_env.write_config(v, str(Path(d) / "sub" / "env.json"))
            self.assertTrue(Path(out).exists())
            loaded = json.loads(Path(out).read_text())
            self.assertEqual(loaded["env_type"], "local")


if __name__ == "__main__":
    unittest.main()
