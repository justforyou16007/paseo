#!/usr/bin/env python3
"""analysis_tools.py — Analysis-tool registry (shared ARIS helper, Policy B).

ARIS currently lacks a reuse mechanism for result-analysis methods: once an
agent distills an analysis process into a reusable method (often *with* the
script it used), other agents have no single entry point to discover / fetch /
run it. This helper is that entry point.

An agent **registers** an analysis process as a reusable *skill* (a real
``SKILL.md`` + optional ``scripts/`` it copies in — not a bare spec), and other
agents **query / get** the available analysis tools and run them.

Design mirrors the existing shared helpers:
  - ``tools/research_wiki.py`` — argparse subcommands, ``.aris/`` storage,
    append-only JSONL ledger, ``_now()``, ``init``-free auto-create, ``stats``.
  - ``tools/run_state.py`` — ``flock`` + atomic temp-file replace, single-writer
    contract, slug validation, minimal CLI.

Globally effective by default (no ``init`` subcommand). The registry lives in
a **personal, long-running directory** — ``$HOME/.aris/analysis_tools/`` — NOT
the canonical ``skills/`` corpus and NOT a per-project path.

Why personal, not repo-local: Claude Code / Codex CLI **cannot reload skills at
runtime** — a skill registered mid-session is invisible to the live skill loader
until the session restarts. So this helper is itself the access mechanism: an
agent ``load``s a registered tool's ``SKILL.md`` and follows it inline. For that
to be useful across sessions and across projects, the collection must persist in
one personal location rather than being scattered per-repo. Override the location
with ``$ARIS_ANALYSIS_TOOLS_DIR`` (e.g. to keep a team-shared collection on a
synced volume); falls back to ``$ARIS_REPO/.aris/analysis_tools/`` then
``./.aris/analysis_tools/`` if ``$HOME`` is unset.

Corpus-mutation invariant (acceptance-gate.md / two-layer convention): this
helper NEVER writes the canonical ``skills/`` corpus and NEVER calls
``provenance.py``. Promoting a registered tool to an installable skill is a
Type-B act that leaves the registry for ``/meta-apply`` (fresh cross-model jury +
``provenance.py stamp``), human-triggered.

What is deterministic (this helper) vs what the executor LLM does:
  - helper STORES:    register / deprecate / add-category (ledger + skill dir)
  - helper ANSWERS:   query / get / load / resource / test / categories
                      / stats (read-only)
  - executor DRIVES:  judging whether two tools are functionally similar and
                      merging them (point 4 — a generation/authoring act, never a
                      verdict); running a registered tool's analysis (point 5 —
                      must happen in a subagent, never the main agent).

Progressive disclosure — three-tier model (mirrors the live skill loader, which
injects only a skill's frontmatter ``description`` into context and reads the
body / resources on demand; here the helper *is* the loader because skills
cannot be reloaded at runtime):

  - Level 0 (metadata, always cheap): ``query`` → ``name`` + ``description``
    + ``category`` + ``purpose`` only. With ``--query <text>`` it BM25-ranks
    the L0 text (purpose + name + description + tags + inputs) and returns the
    top-K (score>0) candidates — soft match, so the agent judges relevance
    itself instead of relying on a hard hit. Without ``--query`` it returns all
    filtered candidates (browse-all).
  - Level 1 (core content, on demand): ``load --slug <s>`` → the complete
    ``SKILL.md`` (frontmatter + full body). ``get --slug <s>`` is the raw
    full-body accessor (same read path). Load **only** the candidate you chose
    from L0.
  - Level 2 (detailed resources, deep on demand): ``resource --slug <s>
    --list`` / ``--name <file>`` → one file from the tool's ``scripts/`` or
    ``references/``. Pulled only while executing a step that names it — the
    agent decides which L2 files to read; L2 is never auto-pulled on load.

Per-tool test-artifact contract (mandatory): every registered tool MUST ship
``scripts/tool-unit-test.py`` (deterministic unit test, exit 0 = pass) AND
``references/`` test data (≥1 file). ``register`` rejects a tool missing either
unless ``--skip-test`` is given (recorded visibly as ``test_required:false``,
never silently). ``test --slug <s>`` runs the unit test from the tool's own
directory and appends a ``test`` ledger row — the "验证效果" receipt.

Usage: python3 analysis_tools.py <subcommand> [options]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Generator, Optional

try:
    import fcntl  # POSIX
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore

# Seeded the first time the type table is touched. Extensible via add-category.
DEFAULT_CATEGORIES = [
    {"key": "ablation", "name": "Ablation analysis",
     "description": "Per-component contribution by removing / replacing modules."},
    {"key": "statistical-test", "name": "Statistical testing",
     "description": "Hypothesis tests, confidence intervals, multiple-comparison correction."},
    {"key": "significance", "name": "Significance analysis",
     "description": "Is the gain real? effect size, bootstrap CIs, paired tests vs baselines."},
    {"key": "error-analysis", "name": "Error analysis",
     "description": "Per-sample / per-slice failure taxonomy and confusion structure."},
    {"key": "visualization", "name": "Visualization",
     "description": "Render results as plots / tables / figures for inspection."},
    {"key": "scaling-law", "name": "Scaling-law analysis",
     "description": "Fit power-law / exponent trends across compute / data / params."},
    {"key": "efficiency", "name": "Efficiency / cost analysis",
     "description": "Throughput, latency, memory, FLOPs, $ per result."},
    {"key": "robustness", "name": "Robustness analysis",
     "description": "Stability under distribution shift, noise, adversarial perturbation."},
    {"key": "data-coverage", "name": "Data coverage analysis",
     "description": "Slice coverage, demographic / group breakdown, missing-data audit."},
    {"key": "baseline-comparison", "name": "Baseline comparison",
     "description": "Head-to-head vs prior work tables with matched settings."},
    {"key": "reproducibility", "name": "Reproducibility analysis",
     "description": "Variance across seeds / runs, determinism, rerun agreement."},
]

ACTIVE, DEPRECATED = "active", "deprecated"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _emit(obj: object) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def _registry_root() -> Path:
    """Personal, long-running registry root.

    Priority: $ARIS_ANALYSIS_TOOLS_DIR → $HOME/.aris/analysis_tools/ →
    $ARIS_REPO/.aris/analysis_tools/ → ./.aris/analysis_tools/.

    Personal (not repo-local) because Claude Code / Codex CLI cannot reload
    skills at runtime, so this helper *is* the access mechanism and the
    collection must persist across sessions and projects. A repo-local path
    would lose the collection when the agent moves to another project and would
    be invisible mid-session regardless.
    """
    override = os.environ.get("ARIS_ANALYSIS_TOOLS_DIR")
    if override:
        return Path(override).expanduser().resolve()
    home = os.environ.get("HOME")
    if home:
        return Path(home).expanduser() / ".aris" / "analysis_tools"
    # parents[1] of this file = ARIS repo root (this file lives in tools/).
    repo_root = Path(__file__).resolve().parents[1]
    return (repo_root / ".aris" / "analysis_tools").resolve()


def _ledger_path() -> Path:
    return _registry_root() / "registry.jsonl"


def _categories_path() -> Path:
    return _registry_root() / "categories.json"


def _skill_dir(slug: str) -> Path:
    return _registry_root() / "skills" / slug


def _skill_md(slug: str) -> Path:
    return _skill_dir(slug) / "SKILL.md"


def _scripts_dir(slug: str) -> Path:
    return _skill_dir(slug) / "scripts"


def _references_dir(slug: str) -> Path:
    return _skill_dir(slug) / "references"


# Mandatory deterministic unit test for every tool (exit 0 = pass).
UNIT_TEST_NAME = "tool-unit-test.py"


def _unit_test_path(slug: str) -> Path:
    return _scripts_dir(slug) / UNIT_TEST_NAME


def _validate_slug(slug: str) -> str:
    safe = "".join(c for c in slug if c.isalnum() or c in "-_.")
    if not safe or safe != slug or slug in (".", ".."):
        raise ValueError(
            f"invalid slug {slug!r} (use [A-Za-z0-9-_.]; no spaces/slashes)")
    return slug


def _csv(val: Optional[str]) -> list[str]:
    if not val:
        return []
    return [s.strip() for s in val.split(",") if s.strip()]


# ── BM25 soft ranking (replaces substring hard-match in `query`) ─────────────
# Why: a tool's `purpose` wording rarely matches the analysis-task wording
# verbatim, so substring matching silently misses reusable tools and the agent
# re-registers a duplicate. BM25 ranks the L0 text (purpose + name + description
# + tags + inputs) and returns the top-K candidates for the agent to judge.

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall((text or "").lower())


def _tool_l0_text(rec: dict) -> str:
    """The searchable document for one tool: all L0 fields concatenated."""
    parts = [
        rec.get("purpose", ""),
        rec.get("name", ""),
        rec.get("description", ""),
        " ".join(rec.get("tags", []) or []),
        " ".join(rec.get("inputs", []) or []),
    ]
    return " ".join(p for p in parts if p)


def _bm25_scores(docs: list[tuple[str, list[str]]],
                 query_tokens: list[str],
                 k1: float = 1.5, b: float = 0.75) -> dict[str, float]:
    """Standard BM25 over (slug, tokens) docs. Returns slug → score (>0 only
    for docs sharing ≥1 query term)."""
    n_docs = len(docs)
    if n_docs == 0 or not query_tokens:
        return {}
    avgdl = sum(len(toks) for _, toks in docs) / n_docs
    # document frequency per query term
    df: dict[str, int] = {}
    for term in set(query_tokens):
        df[term] = sum(1 for _, toks in docs if term in toks)
    # term frequency per doc
    scores: dict[str, float] = {slug: 0.0 for slug, _ in docs}
    for slug, toks in docs:
        if not toks:
            continue
        tf: dict[str, int] = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        dl = len(toks)
        norm = 1 - b + b * (dl / avgdl) if avgdl > 0 else 1.0
        s = 0.0
        for term in query_tokens:
            n = df.get(term, 0)
            if n == 0:
                continue
            idf = math.log((n_docs - n + 0.5) / (n + 0.5) + 1)
            f = tf.get(term, 0)
            if f == 0:
                continue
            s += idf * (f * (k1 + 1)) / (f + k1 * norm)
        if s > 0:
            scores[slug] = s
    return {slug: s for slug, s in scores.items() if s > 0}


@contextmanager
def _write_lock() -> Generator[None, None, None]:
    """Best-effort advisory lock for write ops. Single-writer is the contract;
    this only guards a stray concurrent writer. No-op where fcntl is unavailable."""
    root = _registry_root()
    root.mkdir(parents=True, exist_ok=True)
    if fcntl is None:
        yield
        return
    lock_path = root / ".registry.lock"
    fh = open(lock_path, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fh, fcntl.LOCK_UN)
        finally:
            fh.close()


def _atomic_write_json(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".cat.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        finally:
            raise


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".sk.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        finally:
            raise


def _ensure_categories() -> list[dict]:
    p = _categories_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8")).get("categories", [])
        except Exception:
            pass  # fall through to reseed
    obj = {"categories": list(DEFAULT_CATEGORIES)}
    with _write_lock():
        _atomic_write_json(p, obj)
    return obj["categories"]


def _category_keys() -> set[str]:
    return {c["key"] for c in _ensure_categories()}


def _read_ledger() -> list[dict]:
    p = _ledger_path()
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # skip malformed line, never crash reads
    return out


def _current_state() -> dict[str, dict]:
    """Latest-entry-wins per slug → current tool state."""
    state: dict[str, dict] = {}
    for rec in _read_ledger():
        slug = rec.get("slug")
        if not slug:
            continue
        prev = state.get(slug, {})
        # register/deprecate both carry the full current snapshot fields; merge
        # so a deprecate row (which only flips status + adds reason) preserves
        # the prior name/purpose/category/etc.
        merged = {**prev, **{k: v for k, v in rec.items() if v is not None}}
        state[slug] = merged
    return state


def _procedure_text(procedure: Optional[str]) -> tuple[str, str]:
    """Return (text, source) where source is 'inline' or 'file:<path>'.
    If `procedure` is a path to an existing file, read it; else treat as inline."""
    if procedure is None:
        return ("", "none")
    p = Path(procedure)
    if p.is_file():
        return (p.read_text(encoding="utf-8"), f"file:{p}")
    return (procedure, "inline")


def _content_hash(procedure_text: str, script_names: list[str]) -> str:
    h = hashlib.sha256()
    h.update(procedure_text.encode("utf-8"))
    for n in sorted(script_names):
        h.update(n.encode("utf-8"))
    return "sha256:" + h.hexdigest()[:16]


def _render_skill_md(rec: dict) -> str:
    lines = ["---"]
    lines.append(f"name: {rec['slug']}")
    lines.append(f"description: \"{rec.get('purpose', '').replace(chr(34), '')} "
                 f"(analysis tool, category: {rec.get('category', '')})\"")
    lines.append(f"category: {rec.get('category', '')}")
    if rec.get("inputs"):
        lines.append("inputs: " + json.dumps(rec["inputs"], ensure_ascii=False))
    if rec.get("outputs"):
        lines.append("outputs: " + json.dumps(rec["outputs"], ensure_ascii=False))
    if rec.get("tags"):
        lines.append("tags: " + json.dumps(rec["tags"], ensure_ascii=False))
    if rec.get("author"):
        lines.append(f"author: {rec['author']}")
    if rec.get("source_skill"):
        lines.append(f"source-skill: {rec['source_skill']}")
    if rec.get("supersedes"):
        lines.append(f"supersedes: {rec['supersedes']}")
    lines.append(f"registered: {rec.get('ts', _now())}")
    lines.append(f"content_hash: {rec.get('content_hash', '')}")
    lines.append(f"status: {rec.get('status', ACTIVE)}")
    lines.append("---")
    lines.append("")
    lines.append(f"# {rec.get('name', rec['slug'])}")
    lines.append("")
    lines.append(f"> {rec.get('purpose', '')}")
    lines.append("")
    if rec.get("description"):
        lines.append(rec["description"])
        lines.append("")
    if rec.get("inputs"):
        lines.append("## Inputs")
        for i in rec["inputs"]:
            lines.append(f"- {i}")
        lines.append("")
    if rec.get("outputs"):
        lines.append("## Outputs")
        for o in rec["outputs"]:
            lines.append(f"- {o}")
        lines.append("")
    lines.append("## Procedure")
    proc = rec.get("procedure_text", "")
    lines.append(proc if proc.strip() else "_(no procedure recorded)_")
    lines.append("")
    if rec.get("scripts"):
        lines.append("## Scripts")
        lines.append("Copied into this tool's `scripts/` directory:")
        for s in rec["scripts"]:
            lines.append(f"- `{s}`")
        lines.append("")
    if rec.get("references"):
        lines.append("## References (test data)")
        lines.append("Copied into this tool's `references/` directory:")
        for r in rec["references"]:
            lines.append(f"- `{r}`")
        lines.append("")
    if rec.get("test_required") is False:
        lines.append("> ⚠️ Registered with `--skip-test`: no `tool-unit-test.py` / "
                     "references test data enforced. Effect is unverified.")
        lines.append("")
    if rec.get("supersedes"):
        lines.append(f"This tool supersedes `{rec['supersedes']}` (auto-deprecated on register).")
        lines.append("")
    return "\n".join(lines)


def _append_ledger(rec: dict) -> None:
    p = _ledger_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


# ── subcommands ──────────────────────────────────────────────────────────────

def cmd_register(args: argparse.Namespace) -> int:
    slug = _validate_slug(args.slug)
    valid = _category_keys()
    if args.category not in valid:
        _emit({"error": f"unknown category {args.category!r}",
               "valid_categories": sorted(valid),
               "hint": "add one via `add-category --key ...` first"})
        return 2

    state = _current_state()
    exists = slug in state
    if exists and not args.update_on_exist and not args.supersedes:
        _emit({"error": f"slug {slug!r} already exists",
               "existing": {k: state[slug].get(k) for k in
                            ("name", "category", "purpose", "status")},
               "hint": "use --update-on-exist to overwrite, or --supersedes <old-slug> "
                       "to register a successor that auto-deprecates the old one"})
        return 2

    proc_text, proc_source = _procedure_text(args.procedure)

    # Copy scripts → skills/<slug>/scripts/ and references → references/ (under
    # lock). Both directories are clean-rebuilt on (re)register so a stale
    # tool-unit-test.py or test-data file never survives an update.
    script_names: list[str] = []
    reference_names: list[str] = []
    with _write_lock():
        sdir = _scripts_dir(slug)
        rdir = _references_dir(slug)
        if sdir.exists():
            shutil.rmtree(sdir)
        if rdir.exists():
            shutil.rmtree(rdir)
        for src in (args.script or []):
            sp = Path(src)
            if not sp.is_file():
                _emit({"error": f"script not found: {src}"})
                return 2
            sdir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(sp, sdir / sp.name)
            script_names.append(sp.name)
        for src in (args.resource or []):
            sp = Path(src)
            if not sp.is_file():
                _emit({"error": f"resource not found: {src}"})
                return 2
            rdir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(sp, rdir / sp.name)
            reference_names.append(sp.name)

        # Mandatory test-artifact contract: every tool ships tool-unit-test.py
        # (deterministic, exit 0 = pass) AND references/ test data. Reject unless
        # --skip-test is given (recorded visibly, never silently).
        test_required = True
        if not args.skip_test:
            missing = []
            if UNIT_TEST_NAME not in script_names:
                missing.append(f"scripts/{UNIT_TEST_NAME}")
            if not reference_names:
                missing.append("references/ (test data)")
            if missing:
                _emit({"error": f"tool {slug!r} missing required test artifacts: {missing}",
                       "hint": "pass --script <tool-unit-test.py> --resource <test-data-file>, "
                               "or --skip-test to register anyway (recorded as test_required:false)"})
                return 2
        else:
            test_required = False

        chash = _content_hash(proc_text, script_names + reference_names)
        rec = {
            "action": "register",
            "slug": slug,
            "name": args.name or slug,
            "description": args.description or "",
            "purpose": args.purpose,
            "category": args.category,
            "inputs": _csv(args.inputs),
            "outputs": _csv(args.outputs),
            "tags": _csv(args.tags),
            "author": args.author or "",
            "source_skill": args.source_skill or "",
            "procedure_source": proc_source,
            "procedure_text": proc_text,
            "scripts": script_names,
            "references": reference_names,
            "test_required": test_required,
            "status": args.status or ACTIVE,
            "content_hash": chash,
            "supersedes": args.supersedes or "",
            "spec_path": str(_skill_md(slug).relative_to(_registry_root())),
            "ts": _now(),
        }
        _atomic_write_text(_skill_md(slug), _render_skill_md(rec))
        _append_ledger(rec)

        # --supersedes: auto-deprecate the predecessor.
        deprecated_info = None
        if args.supersedes:
            old = args.supersedes
            if old in _current_state():
                dep = {"action": "deprecate", "slug": old,
                       "status": DEPRECATED, "reason": f"superseded by {slug}",
                       "ts": _now()}
                _append_ledger(dep)
                deprecated_info = {"superseded": old}
            else:
                deprecated_info = {"superseded_warning": f"{old} not found; recorded as supersedes link only"}

    _emit({"action": "register", "slug": slug, "status": rec["status"],
           "content_hash": chash,
           "spec_path": str(_skill_md(slug)),
           "scripts": script_names,
           "references": reference_names,
           "test_required": test_required,
           "updated_existing": exists,
           **(deprecated_info or {})})
    return 0


def cmd_query(args: argparse.Namespace) -> int:
    """Level 0 (metadata) find. Hard-filters on explicit constraints
    (--status / --category / --tag / --inputs), then — when --query is given —
    BM25-ranks the candidates on their L0 text and returns the top-K (score>0)
    for the agent to judge. Without --query, returns all filtered candidates
    (browse-all; this replaces the former `list` subcommand)."""
    state = _current_state()
    candidates: list[tuple[str, dict]] = []
    for slug, rec in sorted(state.items()):
        if args.status and rec.get("status", ACTIVE) != args.status:
            continue
        if args.category and rec.get("category") != args.category:
            continue
        if args.tag and args.tag not in rec.get("tags", []):
            continue
        if args.inputs and not any(i in rec.get("inputs", []) for i in _csv(args.inputs)):
            continue
        candidates.append((slug, rec))

    def _l0(slug: str, rec: dict, score: Optional[float] = None) -> dict:
        row = {"slug": slug, "name": rec.get("name", slug),
               "description": rec.get("description", ""),
               "category": rec.get("category", ""),
               "purpose": rec.get("purpose", ""),
               "tags": rec.get("tags", [])}
        if score is not None:
            row["score"] = round(score, 4)
        return row

    if args.query:
        q_tokens = _tokenize(args.query)
        docs = [(slug, _tokenize(_tool_l0_text(rec))) for slug, rec in candidates]
        scores = _bm25_scores(docs, q_tokens)
        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[:args.top]
        # build matches preserving candidate recs
        cand_map = {slug: rec for slug, rec in candidates}
        matches = [_l0(slug, cand_map[slug], score) for slug, score in ranked]
        _emit({"count": len(matches), "top_k": args.top,
               "query": args.query, "matches": matches})
        return 0

    # no --query → browse all filtered candidates (no score, no cap)
    matches = [_l0(slug, rec) for slug, rec in candidates]
    _emit({"count": len(matches), "top_k": None, "query": None, "matches": matches})
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    slug = _validate_slug(args.slug)
    state = _current_state()
    if slug not in state:
        _emit({"error": f"no tool with slug {slug!r}"})
        return 1
    if args.json:
        rec = state[slug]
        _emit({k: rec.get(k) for k in
               ("slug", "name", "description", "purpose", "category", "inputs",
                "outputs", "tags", "author", "source_skill", "supersedes",
                "scripts", "status", "content_hash", "spec_path", "ts")})
        return 0
    p = _skill_md(slug)
    if not p.exists():
        _emit({"error": f"spec file missing for {slug!r} (ledger entry exists)",
               "spec_path": str(p)})
        return 1
    sys.stdout.write(p.read_text(encoding="utf-8"))
    if not p.read_text(encoding="utf-8").endswith("\n"):
        sys.stdout.write("\n")
    return 0


def cmd_load(args: argparse.Namespace) -> int:
    """Level 1 (core content): the complete SKILL.md, read on demand. The
    on-demand equivalent of what the live skill loader would have injected had
    the skill been reloadable. Main agent should fan this out to a subagent."""
    slug = _validate_slug(args.slug)
    state = _current_state()
    if slug not in state:
        _emit({"error": f"no tool with slug {slug!r}"})
        return 1
    if args.json:
        rec = state[slug]
        _emit({k: rec.get(k) for k in
               ("slug", "name", "description", "purpose", "category", "inputs",
                "outputs", "tags", "author", "source_skill", "supersedes",
                "scripts", "references", "test_required", "status",
                "content_hash", "spec_path", "ts")})
        return 0
    p = _skill_md(slug)
    if not p.exists():
        _emit({"error": f"spec file missing for {slug!r} (ledger entry exists)",
               "spec_path": str(p)})
        return 1
    sys.stdout.write(p.read_text(encoding="utf-8"))
    if not p.read_text(encoding="utf-8").endswith("\n"):
        sys.stdout.write("\n")
    return 0


def _list_resources(slug: str) -> list[dict]:
    """Enumerate scripts/ and references/ for a tool (Level 2 index)."""
    out: list[dict] = []
    for kind, d in (("script", _scripts_dir(slug)), ("reference", _references_dir(slug))):
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            if f.is_file():
                out.append({"kind": kind, "name": f.name,
                            "path": str(f.relative_to(_skill_dir(slug)))})
    return out


def cmd_resource(args: argparse.Namespace) -> int:
    """Level 2 (detailed resources): enumerate or print one file from a tool's
    scripts/ or references/. Pulled only while executing a step that names it —
    never load all resources up front."""
    slug = _validate_slug(args.slug)
    if slug not in _current_state():
        _emit({"error": f"no tool with slug {slug!r}"})
        return 1
    resources = _list_resources(slug)
    if args.list:
        _emit({"slug": slug, "count": len(resources), "resources": resources})
        return 0
    if not args.name:
        _emit({"error": "resource requires --name <file> or --list",
               "available": [r["name"] for r in resources]})
        return 2
    target = None
    for r in resources:
        if r["name"] == args.name or r["path"] == args.name:
            target = r
            break
    if target is None:
        _emit({"error": f"resource {args.name!r} not found for {slug!r}",
               "available": [r["name"] for r in resources]})
        return 1
    p = _skill_dir(slug) / target["path"]
    sys.stdout.write(p.read_text(encoding="utf-8"))
    if not p.read_text(encoding="utf-8").endswith("\n"):
        sys.stdout.write("\n")
    return 0


def cmd_test(args: argparse.Namespace) -> int:
    """Run the tool's mandatory scripts/tool-unit-test.py with cwd = the tool's
    own directory (so the test can reach `references/<test-data>` and
    `scripts/<helper>` via relative paths), capture exit code, and append a
    `test` ledger row — the 验证效果 receipt. Exit code mirrors the unit
    test's exit code so callers can gate on it."""
    slug = _validate_slug(args.slug)
    state = _current_state()
    if slug not in state:
        _emit({"error": f"no tool with slug {slug!r}"})
        return 1
    ut = _unit_test_path(slug)
    if not ut.is_file():
        _emit({"error": f"no {UNIT_TEST_NAME} for {slug!r} "
               f"(tool was registered with --skip-test)",
               "path": str(ut)})
        return 2
    try:
        proc = subprocess.run(
            [sys.executable, f"scripts/{UNIT_TEST_NAME}"],
            cwd=str(_skill_dir(slug)),
            capture_output=True, text=True)
        exit_code = proc.returncode
        passed = exit_code == 0
    except Exception as e:  # pragma: no cover - spawn failure
        rec = {"action": "test", "slug": slug, "pass": False,
               "exit": -1, "error": str(e), "ts": _now()}
        with _write_lock():
            _append_ledger(rec)
        _emit({**rec, "stdout": "", "stderr": str(e)})
        return 2

    rec = {"action": "test", "slug": slug, "pass": passed,
           "exit": exit_code, "ts": _now()}
    with _write_lock():
        _append_ledger(rec)
    _emit({**rec,
           "stdout": proc.stdout[-2000:] if args.verbose else "",
           "stderr": proc.stderr[-2000:] if args.verbose else ""})
    return exit_code


def cmd_categories(args: argparse.Namespace) -> int:
    cats = _ensure_categories()
    if args.json:
        _emit({"count": len(cats), "categories": cats})
        return 0
    print(f"{'key':<22} name")
    print("-" * 60)
    for c in cats:
        print(f"{c['key']:<22} {c.get('name', '')}")
        if c.get("description"):
            print(f"{'':<22} {c['description']}")
    print(f"\n{len(cats)} categories. Filter query with --category <key>.")
    return 0


def cmd_add_category(args: argparse.Namespace) -> int:
    key = _validate_slug(args.key)
    cats = _ensure_categories()
    if any(c["key"] == key for c in cats):
        _emit({"error": f"category {key!r} already exists"})
        return 2
    cats.append({"key": key, "name": args.name or key, "description": args.description or ""})
    with _write_lock():
        _atomic_write_json(_categories_path(), {"categories": cats})
    _emit({"action": "add-category", "key": key, "name": args.name or key})
    return 0


def cmd_deprecate(args: argparse.Namespace) -> int:
    slug = _validate_slug(args.slug)
    state = _current_state()
    if slug not in state:
        _emit({"error": f"no tool with slug {slug!r}"})
        return 1
    with _write_lock():
        _append_ledger({"action": "deprecate", "slug": slug, "status": DEPRECATED,
                        "reason": args.reason or "", "ts": _now()})
    _emit({"action": "deprecate", "slug": slug, "status": DEPRECATED,
           "reason": args.reason or ""})
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    del args  # argparse dispatch signature; no options used
    state = _current_state()
    by_status: dict[str, int] = {}
    by_category: dict[str, int] = {}
    untested = 0
    for rec in state.values():
        s = rec.get("status", ACTIVE)
        by_status[s] = by_status.get(s, 0) + 1
        c = rec.get("category", "(none)")
        by_category[c] = by_category.get(c, 0) + 1
        if rec.get("test_required", True) is False:
            untested += 1
    _emit({"total": len(state), "by_status": by_status,
           "by_category": dict(sorted(by_category.items())),
           "untested": untested,
           "categories_defined": len(_ensure_categories())})
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="analysis_tools.py",
        description="Analysis-tool registry (record an analysis process as a reusable skill; "
                    "query/get available analysis tools).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("register", help="record an analysis process as a reusable skill")
    p.add_argument("--slug", required=True)
    p.add_argument("--name", help="human-readable name (default: slug)")
    p.add_argument("--description", help="longer description")
    p.add_argument("--purpose", required=True, help="one-line: what this tool analyzes")
    p.add_argument("--category", required=True, help="type-table key (see `categories`)")
    p.add_argument("--inputs", help="comma-separated input artifacts")
    p.add_argument("--outputs", help="comma-separated output artifacts")
    p.add_argument("--procedure", help="path to a file OR inline text of the analysis steps")
    p.add_argument("--script", action="append", default=[], help="path to a script to copy in (repeatable). "
                    "One MUST be named tool-unit-test.py unless --skip-test.")
    p.add_argument("--resource", action="append", default=[],
                   help="path to a reference / test-data file to copy into references/ (repeatable). "
                        "At least one is required unless --skip-test.")
    p.add_argument("--skip-test", action="store_true",
                   help="register without enforcing tool-unit-test.py + references test data "
                        "(recorded visibly as test_required:false; effect is unverified)")
    p.add_argument("--tags", help="comma-separated tags")
    p.add_argument("--author", help="who/what registered it")
    p.add_argument("--source-skill", help="originating skill name, if distilled from one")
    p.add_argument("--status", choices=[ACTIVE, DEPRECATED], default=ACTIVE)
    p.add_argument("--update-on-exist", action="store_true",
                   help="overwrite an existing tool with this slug (used for merges)")
    p.add_argument("--supersedes", help="slug of an older tool this replaces (auto-deprecates it)")
    p.set_defaults(func=cmd_register)

    p = sub.add_parser("query", help="find analysis tools: BM25-rank top-K by --query, or browse all (L0 metadata). Run before registering to avoid duplicates.")
    p.add_argument("--query", help="free-text query; BM25-ranks candidates on purpose+name+description+tags+inputs and returns top-K (score>0)")
    p.add_argument("--category")
    p.add_argument("--tag")
    p.add_argument("--inputs", help="comma-separated; match tools consuming any of these")
    p.add_argument("--status", choices=[ACTIVE, DEPRECATED], default=ACTIVE,
                   help="filter by status (default: active)")
    p.add_argument("--top", type=int, default=5, help="max candidates to return when --query is given (default: 5)")
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("get", help="print the full spec of one tool (fetch-on-demand)")
    p.add_argument("--slug", required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("load", help="Level 1: load the full SKILL.md of one tool (on-demand core content)")
    p.add_argument("--slug", required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_load)

    p = sub.add_parser("resource", help="Level 2: enumerate or print one script/reference file of a tool")
    p.add_argument("--slug", required=True)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--list", action="store_true", help="enumerate scripts/ and references/")
    g.add_argument("--name", help="print the contents of one file (by name)")
    p.set_defaults(func=cmd_resource)

    p = sub.add_parser("test", help="run a tool's tool-unit-test.py and record the 验证效果 receipt")
    p.add_argument("--slug", required=True)
    p.add_argument("--verbose", action="store_true", help="include captured stdout/stderr")
    p.set_defaults(func=cmd_test)

    p = sub.add_parser("categories", help="list the tool type table")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_categories)

    p = sub.add_parser("add-category", help="extend the type table with a new category")
    p.add_argument("--key", required=True)
    p.add_argument("--name")
    p.add_argument("--description")
    p.set_defaults(func=cmd_add_category)

    p = sub.add_parser("deprecate", help="mark a tool deprecated (append-only; never hard-deleted)")
    p.add_argument("--slug", required=True)
    p.add_argument("--reason")
    p.set_defaults(func=cmd_deprecate)

    p = sub.add_parser("stats", help="registry counts by status / category")
    p.set_defaults(func=cmd_stats)

    args = ap.parse_args()
    try:
        return args.func(args)
    except ValueError as e:
        _emit({"error": str(e)})
        return 2


if __name__ == "__main__":
    sys.exit(main())
