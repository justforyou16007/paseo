#!/usr/bin/env python3
"""env_helper.py — CLI entrypoint for the experiment_env helper.

Subcommands:
    parse     validate agent's candidate JSON + write .aris/experiment-env.json
    info      print the current env config (env_type, fields)
    provision create/rent the environment
    preflight GPU/conda/connectivity check
    sync      sync code to the environment
    deploy    launch one job (--run-spec PATH)
    monitor   query job status (--handle PATH)
    collect   download results (--handle PATH)
    destroy   tear the environment down (--handle PATH)

Every action subcommand: reads --env-config (default
.aris/experiment-env.json), checks staleness (source mtime + sha256),
constructs EnvBackend.create(env_type, config), dispatches, prints JSON
to stdout. exit 0 ok / 1 hard error / 2 no config / 10-16 method error.

Layer 0-3 resolution block (copy into each consuming SKILL.md):

    ENV_HELPER=""
    if [ -z "${ARIS_REPO:-}" ] && [ -f .aris/installed-skills.txt ]; then
        ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
    fi
    ENV_HELPER=".aris/tools/experiment_env/env_helper.py"
    [ -f "$ENV_HELPER" ] || ENV_HELPER="tools/experiment_env/env_helper.py"
    [ -f "$ENV_HELPER" ] || { [ -n "${ARIS_REPO:-}" ] && ENV_HELPER="$ARIS_REPO/tools/experiment_env/env_helper.py"; }
    [ -f "$ENV_HELPER" ] || ENV_HELPER=""
    [ -z "$ENV_HELPER" ] && { echo "ERROR: experiment_env helper not found" >&2; exit 1; }
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

# Make `import parse_env` / `from env_backend import ...` work whether
# invoked as `python3 tools/experiment_env/env_helper.py` (script) or
# `python3 -m tools.experiment_env.env_helper` (module).
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:  # package mode (python -m tools.experiment_env.env_helper)
    from . import parse_env  # noqa: E402
    from .env_backend import EnvBackend, EnvError  # noqa: E402
except ImportError:  # script mode (python3 tools/experiment_env/env_helper.py)
    import parse_env  # noqa: E402
    from env_backend import EnvBackend, EnvError  # noqa: E402

DEFAULT_CONFIG = ".aris/experiment-env.json"


def _load_config(env_config: str) -> dict:
    p = Path(env_config)
    if not p.exists():
        sys.stderr.write(
            f"ERROR: env config not found at {env_config}\n"
            f"       Run `env_helper.py parse --json <candidate> --source "
            f"CLAUDE.md` first (the agent produces the candidate JSON from "
            f"CLAUDE.md/AGENTS.md).\n"
        )
        sys.exit(2)
    return json.loads(p.read_text())


def _check_stale(cfg: dict, env_config: str):
    """Warn (non-blocking) if the source markdown changed since last parse."""
    source = cfg.get("source_path")
    if not source or not Path(source).exists():
        return
    sp = Path(source)
    try:
        st = sp.stat()
        content = sp.read_bytes()
    except OSError:
        return
    mtime = int(st.st_mtime)
    digest = hashlib.sha256(content).hexdigest()
    stale = (cfg.get("source_mtime") != mtime) or (cfg.get("source_hash") != digest)
    if stale:
        sys.stderr.write(
            f"WARN: {source} changed since last parse (mtime/hash mismatch); "
            f"re-run `env_helper.py parse` to refresh {env_config}\n"
        )


def _backend_from_config(env_config: str, dry_run: bool) -> "EnvBackend":
    cfg = _load_config(env_config)
    _check_stale(cfg, env_config)
    env_type = cfg.get("env_type")
    if not env_type:
        sys.stderr.write("ERROR: env_config has no env_type\n")
        sys.exit(1)
    block = cfg.get(env_type)
    if not block:
        sys.stderr.write(f"ERROR: env_type={env_type!r} but no {env_type!r} "
                         f"block in config\n")
        sys.exit(1)
    state_dir = str(Path(env_config).resolve().parent)
    return EnvBackend.create(env_type, block, state_dir=state_dir, dry_run=dry_run)


def _emit(result):
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


def _read_json_file(path: str) -> dict:
    return json.loads(Path(path).read_text())


def cmd_parse(args):
    candidate = _read_json_file_stdin(args.json)
    try:
        validated = parse_env.validate(
            candidate, source_path=args.source,
            env_type_override=args.env_type)
        if not args.stdout_only:
            parse_env.write_config(validated, args.out)
        _emit(validated)
    except parse_env.ValidationError as e:
        sys.stderr.write(f"ERROR: {e.message}\n")
        return 1
    return 0


def _read_json_file_stdin(spec):
    if spec == "-":
        return json.loads(sys.stdin.read())
    return json.loads(Path(spec).read_text())


def cmd_info(args):
    cfg = _load_config(args.env_config)
    env_type = cfg.get("env_type")
    block = cfg.get(env_type, {}) if env_type else {}
    _emit({"env_type": env_type, "source": cfg.get("source"),
           "parsed_at": cfg.get("parsed_at"),
           "warnings": cfg.get("warnings", []),
           "fields": block})
    return 0


def cmd_provision(args):
    b = _backend_from_config(args.env_config, args.dry_run)
    return _run_method(b.provision, 10)


def cmd_preflight(args):
    b = _backend_from_config(args.env_config, args.dry_run)
    return _run_method(b.preflight, 11)


def cmd_sync(args):
    b = _backend_from_config(args.env_config, args.dry_run)
    return _run_method(lambda: b.sync(args.src), 12)


def cmd_deploy(args):
    b = _backend_from_config(args.env_config, args.dry_run)
    run_spec = _read_json_file(args.run_spec)
    return _run_method(lambda: b.deploy(run_spec), 13)


def cmd_monitor(args):
    b = _backend_from_config(args.env_config, args.dry_run)
    handle = _read_json_file(args.handle)
    return _run_method(lambda: b.monitor(handle), 14)


def cmd_collect(args):
    b = _backend_from_config(args.env_config, args.dry_run)
    return _run_method(b.collect_results, 15)


def cmd_destroy(args):
    b = _backend_from_config(args.env_config, args.dry_run)
    return _run_method(b.destroy, 16)


def _run_method(fn, err_code):
    try:
        result = fn()
        _emit(result)
        return 0
    except EnvError as e:
        sys.stderr.write(f"ERROR: {e.message}\n")
        return e.code
    except KeyError as e:
        sys.stderr.write(f"ERROR: missing field {e}\n")
        return err_code


def build_parser():
    p = argparse.ArgumentParser(
        prog="env_helper.py",
        description="Unified experiment-environment helper (ARIS).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    pp = sub.add_parser("parse", help="validate candidate JSON + write config")
    pp.add_argument("--json", required=True, help="candidate JSON path or '-' for stdin")
    pp.add_argument("--source", default=None, help="CLAUDE.md/AGENTS.md path")
    pp.add_argument("--env-type", default=None)
    pp.add_argument("--out", default=DEFAULT_CONFIG)
    pp.add_argument("--stdout-only", action="store_true")
    pp.set_defaults(func=cmd_parse)

    pi = sub.add_parser("info", help="print current env config")
    pi.add_argument("--env-config", default=DEFAULT_CONFIG)
    pi.set_defaults(func=cmd_info)

    for name, fn, extra in [
        ("provision", cmd_provision, []),
        ("preflight", cmd_preflight, []),
        ("sync", cmd_sync, [("--src", {"required": True, "help": "local source dir"})]),
        ("deploy", cmd_deploy, [("--run-spec", {"required": True, "help": "path to run_spec JSON"})]),
        ("monitor", cmd_monitor, [("--handle", {"required": True, "help": "path to handle JSON"})]),
        ("collect", cmd_collect, []),
        ("destroy", cmd_destroy, [("--handle", {"required": False, "help": "path to handle JSON"})]),
    ]:
        sp = sub.add_parser(name, help=f"{name} the environment")
        sp.add_argument("--env-config", default=DEFAULT_CONFIG)
        for flag, kw in extra:
            sp.add_argument(flag, **kw)
        sp.add_argument("--dry-run", action="store_true",
                        help="print what would run, do not execute")
        sp.set_defaults(func=fn)
    return p


def main(argv=None):
    p = build_parser()
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
