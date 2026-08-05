---
name: experiment-env-audit
description: 'Cross-model audit of a project''s experiment environment configuration. Checks that the frozen prepare→run→collect→analyze scripts are trustworthy: command provenance, metric key agreement, failure detectability, environment reachability, analysis honesty. Dispatches /experiment-audit for baseline checks A-F and adds environment-specific checks G-K. Use when environment may have changed and the existing config needs re-validation, or when /experiment-env-configuration needs to gate promotion of a draft bundle. Use when user says "audit experiment environment", "审计实验环境", "check if env config still works", or when prepare.sh/run.sh failures suggest environment drift.'
argument-hint: "[— project: <name>] [— reviewer: codex|oracle-pro|manual] [— target: draft|promoted]"
allowed-tools: Bash(*), Read, Grep, Glob, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__wait_for_agent, mcp__paseo__archive_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission
---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in
> [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill;
> Rule 4: Paseo MCP Only, Strict). The audit is dispatched via
> `mcp__paseo__create_agent` — not the host `Skill` / `Agent` / `Task` tools.

> **Gate provenance** (`shared-references/acceptance-gate.md` step 5).
> This skill produces a **Type-B verdict** — *is the frozen environment
> configuration trustworthy?* The verdict is produced by `/experiment-audit`
> on a different model family and is **read verbatim**. This skill never forms
> its own opinion of the result.

# Experiment Environment Audit

Audit the experiment environment configuration for: **$ARGUMENTS**

## Purpose

An experiment environment configuration freezes the prepare→run→collect→analyze
loop into scripts and a `env.json` config of record. This audit verifies that
the frozen configuration is trustworthy — that it will actually reproduce the
run it claims to freeze, that metrics match, that failures are detectable, and
that the environment is genuinely reachable.

This skill is called in two contexts:

1. **Draft audit** (`— target: draft`, default): called by
   `/experiment-env-configuration` before promoting a draft bundle into
   `.claude/skills/run-<project>-experiment/`. The promotion gate reads the
   verdict produced here.

2. **Promoted audit** (`— target: promoted`): called by any experiment workflow
   skill (`/run-experiment`, `/auto-research-loop`, `/experiment-bridge`) when
   the environment may have changed and the existing config needs re-validation.

```
Phase 0    Resolve target bundle (draft or promoted)
Phase 1    Dispatch cross-model audit (/experiment-audit + checks G-K)
Phase 2    Read verdict (Type-B — verbatim, never self-judged)
Phase 3    Output report and machine-readable verdict
```

**What gets written:**

| # | Path | Contents |
|---|------|----------|
| 1 | `.aris/env-config/<project>/ENV_CONFIG_AUDIT.md` | Human-readable audit report |
| 2 | `.aris/env-config/<project>/ENV_CONFIG_AUDIT.json` | Machine-readable verdict (same schema as `EXPERIMENT_AUDIT.json`, with checks G-K added) |

---

## Phase 0: Resolve Target Bundle

1. **Parse arguments.**
   - `— project: <name>` — explicit project slug. If absent, derive from
     `basename "$ROOT"` (same logic as `/experiment-env-configuration` Phase 0).
   - `— target: draft|promoted` — which bundle to audit. Default: `draft`.
   - `— reviewer: codex|oracle-pro|manual` — reviewer backend. Default: `codex`.

2. **Resolve the bundle path.**

   | `— target` | Bundle path |
   |---|---|
   | `draft` | `.aris/env-config/<project>/draft/` |
   | `promoted` | `.claude/skills/run-<project>-experiment/` |

3. **Verify prerequisites.**
   ```bash
   BUNDLE_DIR="<resolved path>"
   test -f "$BUNDLE_DIR/env.json" || { echo "ERROR: env.json not found in $BUNDLE_DIR" >&2; exit 1; }
   test -d "$BUNDLE_DIR/scripts" || { echo "ERROR: scripts/ not found in $BUNDLE_DIR" >&2; exit 1; }
   ```

   If prerequisites fail, report `{ "verdict": "error", "reason": "bundle not found" }`
   and stop.

---

## Phase 1: Dispatch Cross-Model Audit

Dispatch a **paseo sub-agent** per Rule 1 / Rule 4 — never the host `Skill` tool:

```
mcp__paseo__create_agent
  title:    "env-config audit: <project>"
  provider: claude
  cwd:      $ROOT
  initialPrompt: |
    Run the skill /experiment-audit — reviewer: <REVIEWER_BACKEND>
    scoped to the experiment-environment configuration, not to results.

    Audit target (paths only — read them yourself, they are not summarized here):
      Bundle directory:    <BUNDLE_DIR>/
      Frozen config:       <BUNDLE_DIR>/env.json
      Generated scripts:   <BUNDLE_DIR>/scripts/*.sh
      Generated skill:     <BUNDLE_DIR>/SKILL.md
      Baseline evidence:   refine-logs/EXPERIMENT_TRACKER.md
      Metric contract:     CLAUDE.md  (## Metric Target)
      Prior env answers:   .aris/experiment-env.json, .aris/setup-state.json

    Apply checklist A–F as written, PLUS these configuration-specific checks.
    Report each as PASS | WARN | FAIL with file:line evidence:

    G. Command provenance — does run.template correspond to a command that
       demonstrably ran during baseline reproduction (cite the EXPERIMENT_TRACKER
       row or log), or was it synthesized? FAIL if synthesized with no evidence.
       When `baseline.kind == "mock"` (recorded in env.json), the mock's
       SMOKE_RESULT.json and smoke.log count as execution evidence — the mock
       was generated by /experiment-env-configuration and executed end-to-end
       through the real environment. A command with zero execution evidence
       still FAILs.
    H. Metric key agreement — does feedback.result.primary_metric_key exist in a
       real result artifact AND match CLAUDE.md ## Metric Target? FAIL on mismatch:
       every downstream stop check silently compares nothing.
       When CLAUDE.md has no `## Metric Target` (new project), downgrade to
       WARN but still require `primary_metric_key` to exist in the smoke run's
       output artifact. FAIL only when `## Metric Target` exists and disagrees.
    I. Failure detectability — would feedback.error.failure_patterns actually fire
       on the crash modes this project exhibits? FAIL if a crash would be
       indistinguishable from "still running".
    J. Environment reachability — is preparation.environment.verify_cmd a real
       check of the env that runs the entry point, or a tautology (e.g. `true`,
       `echo ok`, `python --version` for a CUDA job)? FAIL if tautological.
    K. Analysis honesty — does feedback.analysis actually produce the artifact it
       claims at output_path, or is it a stub? WARN on stub, FAIL on a stub
       presented as complete.

    Write the report to .aris/env-config/<project>/ENV_CONFIG_AUDIT.md and the
    machine-readable verdict to .aris/env-config/<project>/ENV_CONFIG_AUDIT.json
    (same schema as EXPERIMENT_AUDIT.json, with checks G–K added).

    Reply with the two file paths only.
```

Then `mcp__paseo__wait_for_agent`, read the receipt file, and
`mcp__paseo__archive_agent` (用完即 archive). **Never poll `get_agent_status`.**

### Type-A self-check: did the audit produce a verdict?

This half is machine-checkable — this skill may judge it:

```bash
AUDIT_JSON=".aris/env-config/<project>/ENV_CONFIG_AUDIT.json"
test -f "$AUDIT_JSON" && jq -e '.overall_verdict' "$AUDIT_JSON" >/dev/null
```

If the file is missing or unparseable, that is a **hard stop**: report
`{ "verdict": "error", "reason": "audit did not return a verdict" }`.
A caller that promotes when the auditor failed to answer is self-acquitting
by omission.

---

## Phase 2: Read Verdict (Type-B — MUST NOT form own opinion)

Transcribe, do not evaluate:

```bash
VERDICT=$(jq -r '.overall_verdict' "$AUDIT_JSON" | tr 'A-Z' 'a-z')
```

| `overall_verdict` | Meaning |
|---|---|
| `pass` | Configuration is trustworthy. |
| `warn` | Trustworthy with caveats — action items should be surfaced. |
| `fail` | Configuration is not trustworthy — specific checks failed. |
| missing / unparseable | Audit did not complete. |

**The verdict is copied verbatim.** This skill does not reinterpret a FAIL as
"a warning really", does not average A–K into an overall of its own, and does
not re-run the audit hoping for a better answer.

---

## Phase 3: Output

Write the output summary to stdout as JSON:

```json
{
  "verdict": "pass|warn|fail|error",
  "report": ".aris/env-config/<project>/ENV_CONFIG_AUDIT.md",
  "verdict_file": ".aris/env-config/<project>/ENV_CONFIG_AUDIT.json",
  "target": "draft|promoted",
  "failing_checks": [],
  "warn_checks": [],
  "action_items": []
}
```

When `— target: promoted` and `verdict == "fail"`, append a recommendation:

```
The promoted experiment environment configuration did not pass audit.
Failing checks: <list>

To reconfigure: /experiment-env-configuration — reconfigure
To re-audit after manual fixes: /experiment-env-audit — project: <project> — target: promoted
```

### Receipt file

Write `.aris/runs/<run_id>.experiment-env-audit.<project>.done.json`:

```json
{
  "skill": "experiment-env-audit",
  "project": "<project>",
  "target": "draft|promoted",
  "verdict": "pass|warn|fail|error",
  "report": ".aris/env-config/<project>/ENV_CONFIG_AUDIT.md",
  "completed_at": "<ISO-8601>"
}
```

This is the file a dispatching parent reads (`paseo-subagent-dispatch.md` Rule 3,
file-paths-only receipts).

---

## Constants

- **AUDIT_DIR_TEMPLATE** = `.aris/env-config/<project>`
- **REVIEWER_BACKEND** = `codex` (override with `— reviewer: oracle-pro|manual`)

## Critical Rules

1. **Never self-judge the audit result.** This skill verifies that the audit
   *ran* (Type-A: file exists and parses) and reads `overall_verdict` verbatim
   (Type-B). It must not reinterpret, average, override, or discount a verdict.
2. **The audit stays advisory to everyone else.** `/experiment-audit`'s own
   "never blocks" contract is untouched. Whether to block on FAIL is the
   **caller's** decision: `/experiment-env-configuration` blocks promotion;
   `/auto-research-loop` logs and continues; `/run-experiment` suggests
   reconfiguration.
3. **No repair or retry.** This skill produces a verdict and stops. Repair
   cycles (fix draft → re-audit) are the caller's responsibility.
   `/experiment-env-configuration` has a bounded repair loop (MAX_AUDIT_ROUNDS = 2);
   other callers decide independently.
4. **Fresh reviewer per audit.** Each audit dispatches a new sub-agent so the
   reviewer is not anchored on a previously seen draft. Never continue a prior
   audit thread.
5. **File-paths-only receipts.** The receipt file carries paths, not summaries.
   The dispatching parent reads the files themselves.

## External dependencies (reused, not modified)

- `skills/experiment-audit/SKILL.md` — the base auditor. Dispatched as a paseo
  sub-agent; provides checks A-F; this skill adds G-K in the dispatch prompt.
- `shared-references/acceptance-gate.md` — DRIVE/ACQUIT; the Type-A / Type-B
  split that this skill implements.
- `shared-references/reviewer-independence.md` — why the auditor reads the
  files itself and receives paths, not summaries.
- `shared-references/paseo-subagent-dispatch.md` — Rule 1 (one agent = one
  skill), Rule 3 (file-paths-only receipts), Rule 4 (Paseo MCP only).
