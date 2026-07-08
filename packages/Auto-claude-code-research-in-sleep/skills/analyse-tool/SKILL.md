---
name: analyse-tool
description: 'General-purpose experiment-analysis tool: analyse experiment results (logs / metrics / artifacts) by reusing a registered analysis method, or — if none fits — distilling the run into a reusable tool (SKILL.md + scripts/ + references/ test data) and registering it via analysis_tools.py. Work≠Verifier: the analysis method (SKILL.md + scripts) is authored by the Claude fan-out subagent (the registered 实验分析Agent), but the verification side (references/ test data + scripts/tool-unit-test.py) is authored by Codex in a fresh thread — never the same model. Use when user says "analyse results", "分析实验结果", "analyse tool", "分析工具注册/查询", "register analysis skill", "merge analysis tools", or an agent needs a reusable analysis method for experiment results. Helper lives in a personal long-running dir because skills cannot be reloaded at runtime. Register/merge/run MUST fan out to the registered 实验分析Agent subagent — only find (query) runs in the main agent.'
argument-hint: "[find <query> | load <slug> | register <description> | merge <slug-a> <slug-b> | run <slug>]"
allowed-tools: Bash(*), Read, Grep, Glob, Write, Edit, Agent
---

# Experiment-Analysis Tool

This is ARIS's **general experiment-analysis tool**. Given experiment results
(logs, metrics, artifacts), it produces the analysis — **reusing** a registered
analysis method when one fits, and otherwise **distilling** the just-performed
analysis into a reusable tool (procedure + script + deterministic unit test +
test data), registering it, and running it, so the next agent facing the same
analysis shape finds it ready. The deterministic storage/lookup lives in one
helper, `tools/analysis_tools.py`; the LLM only **drives**.

The reusable-method registry is the _mechanism_, not the product. The product is
the analysis. ARIS previously had no reuse entry point for experiment-result
analysis methods: once an agent distilled an analysis process into a reusable
method (often _with_ the script it used), other agents had no way to discover /
fetch / run it. This skill is that entry point.

## Context: $ARGUMENTS

## Why a personal dir + why fan-out (READ FIRST)

Two structural constraints:

1. **No runtime skill reload.** Claude Code and Codex CLI cannot reload skills
   mid-session — a skill authored at runtime is invisible to the live skill
   loader until restart. So this helper _is_ the access mechanism: an agent
   `load`s a registered tool's `SKILL.md` and follows it inline. For that to be
   useful across sessions and projects, the collection lives in a **personal,
   long-running directory** — `$HOME/.aris/analysis_tools/` (overridable via
   `$ARIS_ANALYSIS_TOOLS_DIR`), NOT the canonical `skills/` corpus (which is a
   Type-B mutation reserved for `/meta-apply`) and NOT a per-project path.

2. **Fan-out mandate.** Loading a tool body, authoring/registering a new tool,
   judging similarity and merging, and running a tool's analysis are all
   **generation/execution acts** that must happen in a **subagent** — never the
   main agent. This keeps the main context clean and matches ARIS's
   executor-drives / helper-stores split (see
   [`shared-references/integration-contract.md`](../shared-references/integration-contract.md)
   §"anti-pattern: the skill will intelligently decide" and
   [`shared-references/acceptance-gate.md`](../shared-references/acceptance-gate.md)).

## Safety Rules — READ FIRST

**NEVER do any of the following:**

- `sudo` anything
- `rm -rf`, `rm -r`, or any recursive deletion
- `rm` any file you did not create in this session
- Overwrite existing source files without reading them first
- `git push`, `git reset --hard`, or any destructive git operation
- Kill processes you did not start

**If a step requires any of the above, STOP and report to the user.**

## Resolve the helper (Policy B — side-effect)

The registry is a convenience collection; the primary research output is
delivered without it. So this is **Policy B** (warn-and-skip), not a gate.
Canonical name `analysis_tools.py`; resolve via the standard 3-layer chain
(`integration-contract.md` §2). Semantic var `ANALYSIS_TOOLS`:

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1
if [ -z "${ARIS_REPO:-}" ] && [ -f .aris/installed-skills.txt ]; then
    ARIS_REPO=$(awk -F'\t' '$1=="repo_root"{print $2; exit}' .aris/installed-skills.txt 2>/dev/null) || true
fi
ANALYSIS_TOOLS=".aris/tools/analysis_tools.py"
[ -f "$ANALYSIS_TOOLS" ] || ANALYSIS_TOOLS="tools/analysis_tools.py"
[ -f "$ANALYSIS_TOOLS" ] || { [ -n "${ARIS_REPO:-}" ] && ANALYSIS_TOOLS="$ARIS_REPO/tools/analysis_tools.py"; }
[ -f "$ANALYSIS_TOOLS" ] || ANALYSIS_TOOLS=""
[ -n "$ANALYSIS_TOOLS" ] || {
  echo "WARN: analysis_tools.py not resolved at .aris/tools/, tools/, or \$ARIS_REPO/tools/." >&2
  echo "      Primary research output unaffected; analysis-tool registry unavailable." >&2
}
```

All examples below assume `$ANALYSIS_TOOLS` is resolved and use:
`python3 "$ANALYSIS_TOOLS" <subcommand> ...`

## Progressive disclosure — three tiers

| Tier                      | Subcommand                                  | What you get                                         | When                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **L0 metadata**           | `query` / `categories` / `stats`            | `name` + `description` + `category` + `purpose` only | browse for relevance — cheap, safe in main agent. `query --query <text>` **BM25-ranks** the L0 text and returns the **top-5** (score>0) candidates; `query` with no `--query` returns all. Soft match — the agent judges relevance itself. |
| **L1 core content**       | `load --slug <s>` (== `get --slug <s>`)     | the complete `SKILL.md`                              | on demand, **inside a subagent** — load only the one candidate chosen from L0                                                                                                                                                              |
| **L2 detailed resources** | `resource --slug <s> --list` / `--name <f>` | one file from `scripts/` or `references/`            | deep on demand, while executing a step that names it — **never auto-pulled on load**                                                                                                                                                       |

## Operations — who runs what

| Task                      | Subcommand                                                                  | Runs in                         |
| ------------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| **find** similar tools    | `query --query ... --category ... --inputs ...` (BM25 top-5, L0 only)       | **main agent** (L0 only)        |
| **load** a tool body      | `load --slug <s>` (`resource` L2 on demand per step)                        | **subagent** (实验分析Agent)    |
| **register** a new tool   | `register --slug ... --script tool-unit-test.py --resource <test-data> ...` | **subagent** (实验分析Agent)    |
| **merge** two tools       | re-author merged `SKILL.md`, `register --supersedes <loser>`                | **subagent** (实验分析Agent)    |
| **run** a tool's analysis | `load` L1 → `resource` L2 (on demand) → execute procedure                   | **subagent** (实验分析Agent)    |
| **test** a tool's effect  | `test --slug <s>`                                                           | subagent (gate before register) |

### 🚫 Mandatory fan-out rule

**Only `find` (`query` / `categories` / `stats`) runs in the main
agent.** `load` / `register` / `merge` / `run` are **ALL forbidden in the main
agent** and must fan out to a subagent. The main agent dispatches the task,
relays the subagent's result, and otherwise stays out of the tool bodies and
analysis execution.

## The 实验分析Agent — a registered subagent

The find-or-create-register loop lives in a **registered Claude Code subagent**,
not inlined here and not loaded at runtime:

- [`../../agents/experiment-analysis-agent.md`](../../agents/experiment-analysis-agent.md)
  — the **实验分析Agent** (Experiment Analysis Agent) subagent. Its body is the
  full loop: `query` (BM25 top-5) → (match? `load` L1 + `resource` L2 on demand + run) / (no match? author
  `SKILL.md` + `scripts/` + `references/` test data) → `test --slug` (must pass)
  → `register` (or `--supersedes`), plus the resolver, the per-tool test-artifact
  contract, the visible checklist, and the return contract.

Because it is registered, the main agent invokes it by `subagent_type` — no
runtime role-file Read. `install_aris.sh` distributes it to
`<project>/.claude/agents/experiment-analysis-agent.md` (a managed symlink to
the repo `agents/` source) so it is present after install.

The loop is **mechanism-agnostic** for the bash part — it only drives
`analysis_tools.py` over bash. Two things differ by host: how the subagent is
_spawned_ (`Agent` tool with a registered `subagent_type` here;
`spawn_agent`/`send_input` in the Codex mirror), and which model family authors
the **verification side**. Here (Claude host) the subagent is Claude and does
the **work** (`SKILL.md` + scripts); **Codex** authors the verification side
(`references/` test data + `tool-unit-test.py`) in a fresh `mcp__codex__codex`
thread — work and verifier are different families
([`experiment-integrity.md`](../shared-references/experiment-integrity.md)).
The `mcp__codex__codex` grant lives on the subagent's own frontmatter
(`tools:`), not on this skill.

### Fan-out recipe — main agent dispatches the registered subagent

```text
# Claude Code fan-out recipe (main agent):
Agent(subagent_type: "experiment-analysis-agent", prompt: """
  Task: <register|merge|run|load> ...   # the concrete analysis task + inputs
  Return: the analysis result (for run) or the register receipt (for register),
          plus a one-line note of which slug was reused / newly registered
          (and that Codex authored the test set, for a new tool).
""")
```

The subagent's body already carries the resolver, the work≠verifier split, and
the loop — the dispatch prompt only needs the task and inputs. The main agent
never performs the loop steps itself; it only resolves `$ANALYSIS_TOOLS` for its
own `find` and dispatches.

(Codex CLI mirror: no registered-agent mechanism exists for Codex CLI — it
keeps the `spawn_agent` + runtime-Read-role-file form; see the
`skills-codex/analyse-tool` mirror.)

## Fan-out (fan-out-pattern.md) — `Agent` grant rationale

This skill grants `Agent` because **fan-out is the contract**, not an option:
`load` / `register` / `merge` / `run` are generation/execution acts that must
happen in subagents. Per
[`shared-references/fan-out-pattern.md`](../shared-references/fan-out-pattern.md):
**fan-out is 火力 (firepower); the jury is 裁判席 (the bench). Subagents
GENERATE; they never score.** Here the registered 实验分析Agent subagent
generates analysis results and authors+registers the **work** side of tools.
The verification side — the test set + unit test — is **not** generated by that
same subagent: it is authored by **Codex** in a fresh thread, a different family
([`experiment-integrity.md`](../shared-references/experiment-integrity.md)),
so the deterministic `test --slug` gate (Type-A) is checked against a test the
executor could not have written. The `mcp__codex__codex` capability for that
cross-model test authorship (fresh thread, file paths only, never `codex-reply`
— per [`reviewer-routing.md`](../shared-references/reviewer-routing.md) and
[`reviewer-independence.md`](../shared-references/reviewer-independence.md)) is
granted on the **subagent's own frontmatter `tools:`**, not on this skill —
least privilege, the grant lives where it is used. Promoting a tool into the
canonical `skills/` corpus remains a Type-B act routed through `/meta-apply`.

## Per-tool test-artifact contract (mandatory)

Every registered tool MUST ship:

- **`scripts/tool-unit-test.py`** — deterministic unit test (exit 0 = pass),
  **authored by Codex** (different family from the Claude work author).
- **`references/`** — the tool's test data (≥1 file), **also authored by
  Codex** as part of the verification set.

`register` **rejects** (exit 2) a tool missing either, unless `--skip-test` is
given. `--skip-test` is recorded visibly in the ledger as `test_required:false`
(effect unverified) — the gap is never silent, and `--skip-test` is **never** a
substitute for the cross-model authoring rule: it means _no_ test exists, not
"the executor wrote its own." `test --slug <s>` is how effect is validated and
re-validated; it appends a `test` ledger row
`{action:"test", slug, pass, exit, ts}` that a third party can inspect.
Full detail and the authoring checklist live in the
[`实验分析Agent` role file](experiment-analysis-agent.md).

## Concrete artifacts / backfill

- **Artifact (§3):** every `register` appends `registry.jsonl` + writes
  `skills/<slug>/SKILL.md` (+ `scripts/`, `references/`); every `test` appends a
  `test` row. These are the receipts a third party inspects.
- **Backfill (§5):** `register --update-on-exist` overwrites a slug (used for
  merges); `deprecate --slug <s> --reason ...` retires a tool (append-only,
  never hard-deleted); `--supersedes <old>` auto-deprecates the predecessor.

## See Also

- [`../../agents/experiment-analysis-agent.md`](../../agents/experiment-analysis-agent.md)
  — the registered 实验分析Agent subagent: the full find-or-create-register
  loop (work = Claude, verification = Codex). Granted `mcp__codex__codex` on its
  own frontmatter.
- [`shared-references/experiment-integrity.md`](../shared-references/experiment-integrity.md)
  — "the model that writes experiment code must NOT be the model that judges
  experiment integrity" — why the test set + unit test are Codex-authored.
- [`shared-references/reviewer-routing.md`](../shared-references/reviewer-routing.md)
  — Codex MCP (`mcp__codex__codex`, `gpt-5.5`, `xhigh`), fresh thread.
- [`shared-references/reviewer-independence.md`](../shared-references/reviewer-independence.md)
  — pass file paths only, never summaries or interpretations.
- [`shared-references/integration-contract.md`](../shared-references/integration-contract.md)
  — the resolver chain, Policy B (side-effect), and the anti-patterns this skill
  refuses.
- [`shared-references/acceptance-gate.md`](../shared-references/acceptance-gate.md)
  — Type-A (deterministic `test` gate, safe same-model) vs Type-B (promoting a
  tool into the canonical `skills/` corpus, which routes through `/meta-apply`).
- `tools/analysis_tools.py --help` — the canonical helper.
