---
name: experiment-env-audit
description: 'Cross-model audit of a project''s experiment environment configuration with real execution verification. Static checks (G-K): command provenance, metric key agreement, failure detectability, environment reachability, analysis honesty. Execution checks (L-N): actually run prepare.sh/run.sh/collect.sh/info.sh and verify real results are produced. Dynamic checks (O): simulate agent workflow with source modifications. Patch regression (P): verify patch did not break existing functionality. Dispatched exclusively by /experiment-env-manager.'
argument-hint: "[— project: <name>] [— reviewer: codex|oracle-pro|manual] [— target: draft|promoted] [— report-format: standard|structured] [— patch-id: <id>]"
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

This skill is dispatched exclusively by `/experiment-env-manager`. It is never
dispatched directly by `/experiment-env-configuration` or other workflow skills.

```
Phase 0    Resolve target bundle, parse patch-id, clear stale output
Phase 1    Dispatch cross-model audit (/experiment-audit + checks G-K) — static analysis
Phase 1.5  Execution verification — actually run prepare/run/collect and verify results (checks L-N-O-P)
Phase 2    Read verdict (Type-B — verbatim, never self-judged)
Phase 3    Output report and machine-readable verdict
```

**What gets written:**

| # | Path | Contents |
|---|------|----------|
| 1 | `.aris/env-config/<project>/ENV_CONFIG_AUDIT.md` | Human-readable audit report |
| 2 | `.aris/env-config/<project>/ENV_CONFIG_AUDIT.json` | Machine-readable verdict (same schema as `EXPERIMENT_AUDIT.json`, with checks G-K added) |
| 3 | `.aris/env-config/<project>/ENV_CONFIG_AUDIT_STRUCTURED.json` | Structured verdict for env-manager (when `— report-format: structured`) |

---

## Phase 0: Resolve Target Bundle

1. **Parse arguments.**
   - `— project: <name>` — explicit project slug. If absent, derive from
     `basename "$ROOT"` (same logic as `/experiment-env-configuration` Phase 0).
   - `— target: draft|promoted` — which bundle to audit. Default: `draft`.
   - `— reviewer: codex|oracle-pro|manual` — reviewer backend. Default: `codex`.
   - `— patch-id: <id>` — when present, this is a patch re-audit. Record the
     value for Check P and receipt output.

2. **Resolve the bundle path.**

   | `— target` | Bundle path |
   |---|---|
   | `draft` | `.aris/env-config/<project>/draft/` |
   | `promoted` | `.claude/skills/run-<project>-experiment/` |

3. **Resolve root and clear stale output FIRST.**
   ```bash
   ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
   AUDIT_DIR="$ROOT/.aris/env-config/<project>"

   # Clear stale audit output before any exit-capable command.
   # Uses absolute AUDIT_DIR so it works before cd.
   rm -f "$AUDIT_DIR/ENV_CONFIG_AUDIT.md" \
         "$AUDIT_DIR/ENV_CONFIG_AUDIT.json" \
         "$AUDIT_DIR/ENV_CONFIG_AUDIT_STRUCTURED.json"

   cd "$ROOT" || exit 1
   BUNDLE_DIR="<resolved path>"
   ```

4. **Check bundle exists (after clearing).**
   ```bash
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
      Prior env answers:   <BUNDLE_DIR>/env.json (the bundle's own frozen config), .aris/setup-state.json

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

## Phase 1.5: Execution Verification (Type-A — this skill executes and checks)

Checks G-K above are **static analysis** — they read files and reason about
whether the scripts *would* work. This phase **actually runs the scripts** and
verifies the results are real. This is Type-A (machine-checkable: did the
command exit 0? did the expected file appear?).

### Worktree lifecycle pattern

Checks L2 and O modify source code to test propagation. All modifications
happen in a temporary git worktree. The following pattern is used for both
checks. Each check is a separate worktree invocation.

```bash
# 1. Resolve bundle path to absolute BEFORE entering worktree
BUNDLE_DIR_ABS="$(cd "$BUNDLE_DIR" && pwd)"

# 2. Define cleanup function
WORKTREE_DIR=""
worktree_cleanup() {
  if [ -n "$WORKTREE_DIR" ] && [ -d "$WORKTREE_DIR" ]; then
    git worktree remove --force "$WORKTREE_DIR" 2>/dev/null
    rm -rf "$WORKTREE_DIR" 2>/dev/null
  fi
}

# 3. Allocate temp dir and install traps BEFORE creating worktree
WORKTREE_DIR=$(mktemp -d)
trap 'worktree_cleanup' EXIT
trap 'worktree_cleanup; trap - INT; kill -INT $$' INT
trap 'worktree_cleanup; trap - TERM; kill -TERM $$' TERM

# 4. Create worktree — if this fails, EXIT trap cleans the empty dir
git worktree add --detach "$WORKTREE_DIR" HEAD 2>/dev/null || {
  echo "ERROR: failed to create worktree" >&2
  exit 1
}

# 5. Run check logic (uses $WORKTREE_DIR and $BUNDLE_DIR_ABS)
# ...

# 6. Cleanup happens automatically via EXIT trap
```

Key properties:
- **Trap before creation:** the trap is set before `git worktree add` so an
  early INT/TERM during creation still cleans up.
- **Explicit re-raise:** each signal handler removes the worktree, resets
  its own trap, then re-raises (`kill -INT $$` / `kill -TERM $$`). Bash
  trap handlers do not receive the signal name as `$1` — each handler
  hardcodes its own signal.
- **Absolute bundle path:** `BUNDLE_DIR_ABS` is resolved before `cd` into
  the worktree. The promoted bundle is untracked/gitignored and does not
  exist inside the worktree — scripts must be invoked via absolute path.
- **Creation check:** `|| exit 1` after `git worktree add` prevents
  continuing with a missing worktree.

### L. prepare.sh — environment is reachable AND changes propagate

Two sub-checks:

**L1. Basic reachability** — prepare.sh exits 0:

```bash
sh "$BUNDLE_DIR/scripts/prepare.sh"
```

PASS if exit 0. This proves sync + build + verify all work.

**L2. Change propagation** — a code modification is reflected after rebuild:

Uses the worktree lifecycle pattern above.

1. **Identify canary location** in the worktree: `$WORKTREE_DIR/<entry_point>`

2. **Inject canary marker** into the worktree copy (not the real file):
   ```bash
   CANARY="AUDIT_CANARY_$(date +%s)"
   # Modify $WORKTREE_DIR/<entry_point> to emit $CANARY
   ```

3. **Rebuild** in the worktree:
   ```bash
   cd "$WORKTREE_DIR" && sh "$BUNDLE_DIR_ABS/scripts/prepare.sh"
   ```
   Note: prepare.sh syncs code from the worktree, so the canary propagates.
   The scripts are referenced via absolute path because the promoted bundle
   is untracked/gitignored and does not exist inside the worktree.

4. **Run and check** from the worktree context.

5. **Cleanup** happens automatically via the EXIT trap (removes worktree).

The real working tree is never touched. No stash, no restore, no risk.

PASS if the canary string appears in the run output — the build pipeline
correctly propagates source changes into execution artifacts.
FAIL if the canary is absent — stale build artifacts are served despite
source code modification. This is the failure mode where agents modify
experiment code but `run.sh` silently executes old compiled output.

### M. run.sh + collect.sh — a smoke experiment completes

Run a minimal smoke experiment and verify it produces real output:

```bash
sh "$BUNDLE_DIR/scripts/run.sh" audit-smoke --args "" --gpu 0 2>&1
# wait for completion (foreground mode or poll via monitor.sh)
sh "$BUNDLE_DIR/scripts/collect.sh" audit-smoke
```

PASS if:
1. `run.sh` exits 0 (or the launched job completes via `monitor.sh`)
2. `collect.sh` exits 0
3. The receipt JSON (`.aris/runs/*.experiment.audit-smoke.done.json`) exists
4. The receipt's `status` field is `"ok"` (not `"failed"`)
5. The receipt's `primary_metric` field is non-null (a real value was produced)

FAIL if any of these checks fail. Record the exact failure point and any
error output.

If L2 already produced a successful full run with receipt, this check may
reuse that evidence rather than running a second smoke. The auditor decides
based on whether L2's run produced a complete receipt.

**Cleanup:** after verification, remove the smoke experiment's artifacts
(`audit-smoke` / `audit-canary` handles, result files, log files) so they
don't pollute real experiment data. Keep the receipt for audit evidence.

### N. info.sh — metadata is valid

```bash
INFO_OUT=$(sh "$BUNDLE_DIR/scripts/info.sh")
echo "$INFO_OUT" | jq -e '(.hardware or .resources) and .error_patterns and .connection' >/dev/null
```

PASS if `info.sh` exits 0 and the output contains the required JSON fields.
FAIL if it errors or produces invalid JSON.

### O. Dynamic modification — realistic agent workflow simulation

This check simulates what experiment agents actually do between iterations:
modifying experiment code and re-running. It proves the full cycle works
after source changes, not just from a clean initial state.

Uses the worktree lifecycle pattern (same as L2 — separate worktree invocation).

1. **Read** `env.json` `run.entry_point` to identify the main script/module.
   Make the semantic modification in `$WORKTREE_DIR/...`

2. **Make a semantically meaningful modification** in the worktree copy:
   - Python: change a hyperparameter default value, add a CLI flag, modify
     a loss function coefficient
   - C/C++: change a compile-time constant, modify an algorithm parameter
   - The modification must represent the kind of change experiment agents
     make between iterations — not a trivial comment or print statement

3. **Run the full cycle** from the worktree:
   ```bash
   cd "$WORKTREE_DIR" && sh "$BUNDLE_DIR_ABS/scripts/prepare.sh"
   sh "$BUNDLE_DIR_ABS/scripts/run.sh" audit-dynamic --args "" --gpu 0 2>&1
   sh "$BUNDLE_DIR_ABS/scripts/collect.sh" audit-dynamic
   ```

4. **Verify:**
   a. `run.sh` and `collect.sh` exit 0
   b. Receipt JSON exists with `status: "ok"` and non-null `primary_metric`
   c. The `primary_metric` value differs from the unmodified smoke run (Check M)
      — proving the modification actually took effect, not a cached result

5. **Cleanup** happens automatically via the EXIT trap (removes worktree).

PASS if the full cycle works AND the modification is reflected in the result.
FAIL if any step fails, especially if the result is identical to the
unmodified smoke run — proving stale build artifacts or cached results are
being served despite source code modification.

**Cleanup:** remove `audit-dynamic` artifacts (handles, result files, logs).

### P. Patch regression (conditional — only when `— patch-id` is provided)

When `/experiment-env-manager` patches the configuration and re-audits, this
check verifies the patch did not break existing functionality.

1. Run the standard smoke test (same as Check M):
   ```bash
   sh "$BUNDLE_DIR/scripts/run.sh" audit-regression --args "" --gpu 0 2>&1
   sh "$BUNDLE_DIR/scripts/collect.sh" audit-regression
   ```

2. Verify receipt exists with `status: "ok"` and non-null `primary_metric`.

3. If a prior smoke baseline is available at `$BUNDLE_DIR/smoke_baseline.json`,
   verify:
   - `primary_metric` is within 10% tolerance of the baseline value
   - No new `failure_patterns_matched` entries

   The baseline file is written by `/experiment-env-configuration` Phase 5.5
   and lives inside the promoted bundle (not in the config directory).

PASS if the patched configuration still produces valid results.
FAIL if the patch broke something that previously worked.

**Cleanup:** remove `audit-regression` artifacts.

### Record execution results

Append checks L, M, N, O (and P if applicable) to the `ENV_CONFIG_AUDIT.json`
`checks` object and update `overall_verdict` — if any of L/M/N/O/P is FAIL,
the overall verdict becomes FAIL regardless of the G-K static checks. A
configuration that looks correct on paper but fails in practice must not pass.

### Structured Report (when `— report-format: structured`)

When requested by `/experiment-env-manager`, produce an additional file
`.aris/env-config/<project>/ENV_CONFIG_AUDIT_STRUCTURED.json`:

```json
{
  "overall_verdict": "pass|warn|fail",
  "patch_id": "<echoed from — patch-id argument, or null>",
  "audited_at": "<ISO-8601>",
  "checks": {
    "G": {
      "status": "pass|warn|fail",
      "category": "command_provenance",
      "action_item": null,
      "fix_hint": null,
      "patch_targets": [],
      "error_output": null
    },
    "H": {
      "status": "...",
      "category": "metric_agreement",
      "action_item": "...",
      "fix_hint": "...",
      "patch_targets": ["feedback.result.primary_metric_key"],
      "error_output": null
    },
    "I": {
      "status": "...",
      "category": "failure_detectability",
      "action_item": "...",
      "fix_hint": "...",
      "patch_targets": ["feedback.error.failure_patterns"],
      "error_output": null
    },
    "J": {
      "status": "...",
      "category": "environment_reachability",
      "action_item": "...",
      "fix_hint": "...",
      "patch_targets": ["preparation.environment.verify_cmd"],
      "error_output": null
    },
    "K": {
      "status": "...",
      "category": "analysis_honesty",
      "action_item": "...",
      "fix_hint": "...",
      "patch_targets": ["feedback.analysis.mode"],
      "error_output": null
    },
    "L": {
      "status": "...",
      "category": "prepare_reachability",
      "action_item": "...",
      "fix_hint": "...",
      "patch_targets": ["preparation.environment.build_cmd"],
      "error_output": "..."
    },
    "M": {
      "status": "...",
      "category": "smoke_execution",
      "action_item": "...",
      "fix_hint": "...",
      "patch_targets": ["run.template"],
      "error_output": "..."
    },
    "N": {
      "status": "...",
      "category": "info_metadata",
      "action_item": "...",
      "fix_hint": "...",
      "patch_targets": ["resources"],
      "error_output": "..."
    },
    "O": {
      "status": "...",
      "category": "dynamic_modification",
      "action_item": "...",
      "fix_hint": "...",
      "patch_targets": ["preparation.files.transfer"],
      "error_output": "..."
    },
    "P": {
      "status": "...",
      "category": "patch_regression",
      "action_item": "...",
      "fix_hint": "...",
      "patch_targets": [],
      "error_output": "..."
    }
  },
  "recommended_action": "none|retry_prepare|patch_config|full_reconfigure|ask_user",
  "auto_fixable": true
}
```

Field semantics:
- `patch_id` — echoed from the `— patch-id` argument. `null` when this is
  not a patch re-audit. The manager uses this to verify the verdict belongs
  to the patch it dispatched.
- `audited_at` — ISO-8601 timestamp of when this audit completed. The manager
  uses this to verify the verdict is not stale (must be after the dispatch time).
- `fix_hint` — concrete suggestion for what to change (e.g., "add `pip install -e .`
  to build_cmd"). `null` when status is pass.
- `patch_targets` — per-check list of env.json field paths that need
  modification to fix this specific check. Each check owns its own targets.
  The manager reads `checks[X].patch_targets` to construct a targeted patch.
  An empty array means the check passed or the fix cannot be expressed as
  an env.json patch.
- `auto_fixable` — `true` if all failing checks have non-null `fix_hint`
  values and non-empty `patch_targets`. `false` when the failure requires
  human judgment (e.g., wrong entry_point, fundamentally broken environment).
- `recommended_action`:
  - `none` — all checks pass
  - `retry_prepare` — only prepare-related checks failed, re-running prepare.sh may help
  - `patch_config` — specific env.json fields need patching
  - `full_reconfigure` — too many failures, env-configuration should re-run from scratch
  - `ask_user` — failures require human input (auto_fixable is false)

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

To fix: dispatch /experiment-env-manager which owns the repair loop.
Do not dispatch /experiment-env-configuration or /experiment-env-audit directly.
```

### Receipt file

Write `.aris/runs/<run_id>.experiment-env-audit.<project>.done.json`:

```json
{
  "skill": "experiment-env-audit",
  "project": "<project>",
  "target": "draft|promoted",
  "verdict": "pass|warn|fail|error",
  "patch_id": "<echoed from — patch-id, or null>",
  "report": ".aris/env-config/<project>/ENV_CONFIG_AUDIT.md",
  "structured_report": ".aris/env-config/<project>/ENV_CONFIG_AUDIT_STRUCTURED.json",
  "audited_at": "<ISO-8601>",
  "completed_at": "<ISO-8601>"
}
```

`patch_id` is echoed from the `— patch-id` argument so the manager can
verify this verdict belongs to the patch it dispatched. `null` when this
is not a patch re-audit.

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
2. **Dispatched only by /experiment-env-manager.** This skill is never called
   directly by users, `/experiment-env-configuration`, or other workflow skills.
   Repair cycles are owned by `/experiment-env-manager`.
3. **No repair or retry.** This skill produces a verdict and stops. Repair
   is the caller's (env-manager's) responsibility.
4. **Fresh reviewer per audit.** Each audit dispatches a new sub-agent so the
   reviewer is not anchored on a previously seen draft. Never continue a prior
   audit thread.
5. **File-paths-only receipts.** The receipt file carries paths, not summaries.
   The dispatching parent reads the files themselves.
6. **Clear stale output first.** Phase 0 removes prior audit files before any
   new audit work begins. A manager that reads a verdict file can trust it was
   written by this dispatch, not a prior one.
7. **Echo patch-id.** When `— patch-id` is provided, the structured report and
   receipt both include the patch_id. The manager uses this to prove the verdict
   belongs to the patch being finalized.
8. **Per-check patch_targets.** Each check in the structured report owns its
   `patch_targets[]` — the env.json fields that need modification to fix that
   specific check. The manager reads per-check targets to construct targeted
   patches without ambiguity.

## External dependencies (reused, not modified)

- `skills/experiment-audit/SKILL.md` — the base auditor. Dispatched as a paseo
  sub-agent; provides checks A-F; this skill adds G-K in the dispatch prompt.
- `shared-references/acceptance-gate.md` — DRIVE/ACQUIT; the Type-A / Type-B
  split that this skill implements.
- `shared-references/reviewer-independence.md` — why the auditor reads the
  files itself and receives paths, not summaries.
- `shared-references/paseo-subagent-dispatch.md` — Rule 1 (one agent = one
  skill), Rule 3 (file-paths-only receipts), Rule 4 (Paseo MCP only).
