"""parse_env.py — validate + write the experiment-env config.

This is a VALIDATOR + WRITER, not a markdown parser. The agent reads
CLAUDE.md/AGENTS.md and produces a canonical candidate JSON (using the
translation guide in README.md); this module:

  1. validates the candidate against the schema (required fields/types),
  2. fills defaults,
  3. applies the `auto_destroy` default rule,
  4. validates `env_type` (set by the agent; checked against the env
     sub-objects actually present),
  5. records provenance + content hash for staleness detection,
  6. writes `.aris/experiment-env.json` and prints the validated config
     to stdout.

Importable: `validate(candidate, source_path=None, env_type_override=None)
-> dict`. Executable: `python3 parse_env.py --json <file|-> [--source P]
[--env-type T] [--out PATH]`.

The canonical field schema is defined inline below as ENV_SCHEMAS so the
validator is the single source of truth for what each env block may
contain. Deprecated aliases are listed in ALIASES purely to emit
warnings when an agent forgets to translate one — the validator never
auto-converts (translation is the agent's job).
"""

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1
DEFAULT_OUT = ".aris/experiment-env.json"

ENV_TYPES = ("local", "remote", "vast", "modal")

# Per-env field specs: field -> (type, required, default-or-None, is_conditional)
# type is a callable / tuple of types; "list_str" means list[str].
# required=True → hard error if missing (after defaults applied).
# default not None → filled if missing.
ENV_SCHEMAS: dict = {
    "remote": {
        "ssh_alias":      (str, True, None),
        "ssh_host":       (str, False, None),
        "ssh_port":       (int, False, 22),
        "ssh_user":       (str, False, None),
        "gpu_desc":       (str, False, None),
        "conda_env":      (str, False, "base"),
        "conda_hook":     (str, False, None),
        "code_dir":       (str, True, None),
        "code_sync":      (str, False, "rsync"),
        "wandb":          (bool, False, False),
        "wandb_project":  (str, False, None),
        "wandb_entity":   (str, False, None),
    },
    "vast": {
        "auto_destroy":   (bool, False, None),   # default rule applied below
        "max_budget":     ((float, int), False, None),
        "image":          (str, False, "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-devel"),
        "work_dir":       (str, False, "/workspace/"),
        "code_dir":       (str, False, "/workspace/project/"),
        "instance_id":    ((str, int), False, None),
        "ssh_host":       (str, False, None),
        "ssh_port":       (int, False, 22),
        "ssh_user":       (str, False, "root"),
        "wandb":          (bool, False, False),
        "wandb_project":  (str, False, None),
        "wandb_entity":   (str, False, None),
    },
    "modal": {
        "modal_gpu":      (str, False, "auto"),
        "modal_timeout":  (int, False, 21600),
        "modal_volume":   (str, False, None),
        "modal_app_file": (str, False, None),
        "modal_secrets":  (list, False, []),
    },
    "local": {
        "conda_env":      (str, False, "base"),
        "conda_hook":     (str, False, None),
        "device":         (str, False, None),
    },
}

# Deprecated aliases -> canonical. Used ONLY to warn; never auto-convert.
ALIASES: dict = {
    "vast_instance": "instance_id",
    "modal_app": "modal_app_file",
    # codex single-value modal_secrets (str) should be wrapped to list by
    # the agent; if it slips through as a str we coerce + warn.
}


class ValidationError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _check_type(value, expected):
    """expected is either a type/tuple of types, or `list` (means list)."""
    if expected is list:
        return isinstance(value, list)
    return isinstance(value, expected)


def _coerce_str_list(value, warnings, field):
    """modal_secrets may arrive as a bare string (codex single-value form);
    coerce to a one-element list and warn."""
    if isinstance(value, str):
        warnings.append(
            f"{field} given as str, coerced to list[{value!r}] "
            f"(agent should emit a list)"
        )
        return [value]
    return value


def _apply_auto_destroy_default(vast_cfg: dict, warnings):
    """instance_id missing (fresh rental) -> default True;
    instance_id present (reuse) -> default False. Explicit value wins.

    Reconciles the claude default (True) and codex default (False) split
    with one rule that carries both intents."""
    if "auto_destroy" in vast_cfg:
        return  # explicit
    has_instance = vast_cfg.get("instance_id") is not None
    vast_cfg["auto_destroy"] = not has_instance
    warnings.append(
        f"auto_destroy defaulted to {vast_cfg['auto_destroy']} "
        f"({'reuse' if has_instance else 'fresh-rental'} mode)"
    )


def validate(candidate: dict, source_path: "str | None" = None,
             env_type_override: "str | None" = None) -> dict:
    """Validate a candidate env config dict; return the canonical dict
    ready to write. Raises ValidationError on hard errors."""
    if not isinstance(candidate, dict):
        raise ValidationError("candidate config must be a JSON object")

    warnings: list = []
    env_type = env_type_override or candidate.get("env_type")

    # Collect each env sub-object present (agent may provide 1 or more).
    present = {t: candidate[t] for t in ENV_TYPES if t in candidate}

    if not present:
        raise ValidationError(
            "no environment block found in candidate "
            f"(expected one of {list(ENV_TYPES)})"
        )

    if not env_type:
        raise ValidationError(
            "env_type not set; the agent must set env_type to the active "
            "environment (script does not pick among multiple)"
        )
    if env_type not in ENV_TYPES:
        raise ValidationError(
            f"env_type {env_type!r} invalid; expected one of {list(ENV_TYPES)}"
        )
    if env_type not in present:
        raise ValidationError(
            f"env_type is {env_type!r} but no {env_type!r} block was provided"
        )

    canonical_envs: dict = {}
    for etype, block in present.items():
        if not isinstance(block, dict):
            raise ValidationError(f"{etype} block must be a JSON object")
        spec = ENV_SCHEMAS[etype]
        out: dict = {}
        # 1. pass through provided fields with type checks
        for k, v in block.items():
            if k in ALIASES:
                warnings.append(
                    f"{k!r} is deprecated; use {ALIASES[k]!r} "
                    f"(agent should translate; not auto-converted)"
                )
                # do not place under alias name; skip — agent must re-emit
                continue
            if k not in spec:
                warnings.append(f"unknown field {etype}.{k} (ignored)")
                continue
            expected_type = spec[k][0]
            if k == "modal_secrets" and etype == "modal":
                v = _coerce_str_list(v, warnings, k)
            if not _check_type(v, expected_type):
                raise ValidationError(
                    f"{etype}.{k} must be {expected_type!r}, got "
                    f"{type(v).__name__}"
                )
            out[k] = v
        # 2. fill defaults
        for k, (_etype_t, required, default) in spec.items():
            if k not in out:
                if default is not None:
                    out[k] = default
                elif required:
                    raise ValidationError(
                        f"missing required field {etype}.{k}"
                    )
        # 3. conditional: remote wandb_project required when wandb=True
        if etype == "remote" and out.get("wandb") and not out.get("wandb_project"):
            raise ValidationError(
                "remote.wandb_project is required when remote.wandb is true"
            )
        # 4. vast auto_destroy default rule
        if etype == "vast":
            _apply_auto_destroy_default(out, warnings)
        canonical_envs[etype] = out

    result: dict = {
        "schema_version": SCHEMA_VERSION,
        "env_type": env_type,
        "warnings": warnings,
    }
    result.update(canonical_envs)

    # provenance (for staleness detection in env_helper.py)
    if source_path:
        sp = Path(source_path)
        result["source"] = sp.name
        result["source_path"] = str(sp.resolve()) if sp.exists() else str(sp)
        try:
            st = sp.stat()
            result["source_mtime"] = int(st.st_mtime)
            content = sp.read_bytes()
            result["source_hash"] = hashlib.sha256(content).hexdigest()
        except OSError:
            # path may be valid but unreadable in sandbox; keep what we have
            pass
    result["parsed_at"] = datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    return result


def write_config(validated: dict, out_path: str = DEFAULT_OUT) -> str:
    """Write validated config to `out_path` atomically; return the path."""
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(out) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(validated, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, out)
    return str(out)


def _read_candidate(json_arg: str) -> dict:
    """Read candidate JSON from `--json <file|->`."""
    if json_arg == "-":
        raw = sys.stdin.read()
    else:
        raw = Path(json_arg).read_text()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValidationError(f"candidate JSON is invalid: {e}")


def main(argv=None) -> int:
    import argparse

    p = argparse.ArgumentParser(
        prog="parse_env.py",
        description="Validate + write the experiment-env config (does not "
                    "read markdown — feed it the agent's candidate JSON).",
    )
    p.add_argument("--json", dest="json", required=True,
                   help="candidate JSON path, or '-' for stdin")
    p.add_argument("--source", default=None,
                   help="CLAUDE.md/AGENTS.md path (records provenance + hash)")
    p.add_argument("--env-type", default=None,
                   help="override env_type in the candidate")
    p.add_argument("--out", default=DEFAULT_OUT,
                   help=f"output path (default: {DEFAULT_OUT})")
    p.add_argument("--stdout-only", action="store_true",
                   help="do not write file, just print validated JSON")
    args = p.parse_args(argv)

    try:
        candidate = _read_candidate(args.json)
        validated = validate(candidate, source_path=args.source,
                              env_type_override=args.env_type)
        if not args.stdout_only:
            write_config(validated, args.out)
        json.dump(validated, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    except ValidationError as e:
        sys.stderr.write(f"ERROR: {e.message}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
