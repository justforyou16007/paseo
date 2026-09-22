---
name: experiment-env-audit
description: 'Cross-model audit of a project''s experiment environment configuration with real execution verification. Static checks (G-K): command provenance, metric key agreement, failure detectability, environment reachability, analysis honesty. Execution checks (L-N): actually run the ops (sync-code, build-env, launch-job, collect-outputs, env-info) and verify real results are produced. Dynamic checks (O): simulate agent workflow with source modifications. Patch regression (P): verify patch did not break existing functionality. Dispatched exclusively by /experiment-env-manager.'
argument-hint: "[— project: <name>] [— target: draft|promoted] [— report-format: standard|structured] [— patch-id: <id>] [— paseo-config: <path>]"
allowed-tools: Bash(*), Read, Grep, Glob, mcp__paseo__get_agent_status
---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in
> [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill;
> Rule 4: Paseo MCP Only, Strict). `/experiment-env-manager` dispatches this
> skill via `mcp__paseo__create_agent` **on the reviewer leg**
> (`reviewer_provider`, default `codex/gpt-5.5`).

> **This agent IS the cross-model reviewer.** It does not spawn one. The
> bundle under audit was generated on the executor leg
> (`/experiment-env-configuration`, `executor_provider`, default a claude
> model); this agent runs on the reviewer leg and applies the checklist
> itself. A nested reviewer would be the same model family as this host —
> a second opinion from the same jury is not a second opinion.

> **Gate provenance** (`shared-references/acceptance-gate.md` step 5).
> This skill produces a **Type-B verdict** — *is the frozen environment
> configuration trustworthy?* The agent that applies the static checklist,
> runs the execution checks, and authors `overall_verdict` is one and the
> same, and it is cross-model relative to the configuration's author. Phase 0
> step 5 verifies that before any check runs.

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
Phase 0    Resolve target bundle, parse patch-id, clear stale output, verify cross-model host
Phase 1    Apply the static checklist (/experiment-audit A-F + checks G-K) — static analysis
Phase 1.5  Execution verification — actually run prepare/run/collect and verify results (checks L-N-O-P)
Phase 2    Settle the verdict (static half + execution half, no softening)
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
   - `— patch-id: <id>` — when present, this is a patch re-audit. Record the
     value for Check P and receipt output.
   - `- paseo-config: <path>` - a rendered `.aris/runs/<run_id>.paseo-config.json`
     handed over by the caller (e.g. env-manager). When absent, Phase 0 step 5
     renders one from CLAUDE.md.

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

5. **Verify this host is the cross-model leg.** This agent authors the
   verdict, so the check is on **its own** provider — not on a value it is
   about to dispatch with.
   ```bash
   AUDIT_RUN_ID="env-audit-$(date +%Y%m%d-%H%M%S)"
   PASEO_CONFIG="${ARG_PASEO_CONFIG:-.aris/runs/${AUDIT_RUN_ID}.paseo-config.json}"
   if [ ! -f "$PASEO_CONFIG" ]; then
     RENDER=".aris/tools/render_w_agent_prompt.sh"
     [ -f "$RENDER" ] || RENDER="tools/render_w_agent_prompt.sh"
     [ -f "$RENDER" ] || { echo "ERROR: paseo config and config emitter are missing"; exit 1; }
     PASEO_CONFIG=$(bash "$RENDER" --emit-config --run-id "$AUDIT_RUN_ID" --root "$ROOT")
   fi
   ENV_EXECUTOR_PROVIDER=$(jq -er '.executor_provider' "$PASEO_CONFIG") || exit 1
   ENV_REVIEWER_PROVIDER=$(jq -er '.reviewer_provider' "$PASEO_CONFIG") || exit 1
   echo "executor family: ${ENV_EXECUTOR_PROVIDER%%/*}"
   ```

   Read your own provider with `mcp__paseo__get_agent_status` on
   `$PASEO_AGENT_ID` (paseo injects it into every agent's environment) and
   compare `snapshot.provider` with the executor family printed above.

   **Hard stop when they match.** A host in the executor's family is grading
   work its own family produced:
   ```
   ERROR: this audit is running on <host provider>, the same model family as
   executor_provider (<value>). /experiment-env-manager must dispatch
   /experiment-env-audit on reviewer_provider (<value>, e.g. codex/gpt-5.5).
   Re-dispatch on the reviewer leg.
   ```
   No fallback, no silent substitution — a same-family jury is not a jury.
   If `get_agent_status` is unavailable (not an agent-scoped session), stop
   the same way: an unverifiable host is not a verified one.

---

## Phase 1: Static Checklist (applied by this agent)

This agent is the cross-model reviewer (Phase 0 step 5 proved it). It reads the
target files directly and applies the checklist itself. **Do not spawn a
reviewer sub-agent** — a child on the reviewer leg is the same family as this
host, and a child on the executor leg is the family that wrote the bundle.
Neither is a second opinion.

Apply `/experiment-audit`'s checklist A–F (read them from
`skills/experiment-audit/SKILL.md` §"Step 2: Send to Reviewer" — the audit
checklist inside that prompt block) scoped to the experiment-environment
configuration, not to results. Then apply checks G–K below. Read every target
file yourself; nothing here is a summary of it.

```
    Audit target:
      Bundle directory:    <BUNDLE_DIR>/
      Frozen config:       <BUNDLE_DIR>/env.json
      Generated scripts:   <BUNDLE_DIR>/scripts/lib/env.sh, <BUNDLE_DIR>/scripts/ops/*.sh
      Generated skill:     <BUNDLE_DIR>/SKILL.md
      Baseline evidence:   refine-logs/EXPERIMENT_TRACKER.md
      Metric contract:     CLAUDE.md  (## Metric Target)
      Prior env answers:   <BUNDLE_DIR>/env.json (the bundle's own frozen config), .aris/setup-state.json

    Report each check as PASS | WARN | FAIL with file:line evidence:

    G. Command provenance — does run.template correspond to a command that
       demonstrably ran during baseline reproduction (cite the EXPERIMENT_TRACKER
       row or log), or was it synthesized? FAIL if synthesized with no evidence.
       When `baseline.kind == "simple"` (recorded in env.json; legacy "mock"
       values map to "simple"), the simple baseline's RUN_RESULT.json and
       run.log count as execution evidence — it is a real execution of
       the project's own entry point at reduced scale, launched by
       /experiment-env-configuration through the configured environment.
       A command with zero execution evidence still FAILs.
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
    K. Analysis honesty — the bundle must contain NO analysis logic (ops are
       process-invariant only). FAIL if any op interprets results instead of
       collecting facts; WARN if the collect-outputs receipt lacks the
       result_files manifest that /analyze-results depends on.

    Write the report to .aris/env-config/<project>/ENV_CONFIG_AUDIT.md and the
    machine-readable verdict to .aris/env-config/<project>/ENV_CONFIG_AUDIT.json
    (same schema as EXPERIMENT_AUDIT.json, with checks G–K added).
```

Write both files before Phase 1.5 starts. The execution checks append to
`ENV_CONFIG_AUDIT.json`, so it must already hold the static half.

### Type-A self-check: did the static half land?

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

### L. sync-code + build-env — environment is reachable AND changes propagate

Two sub-checks:

**L1. Basic reachability** — sync-code.sh and build-env.sh exit 0:

```bash
sh "$BUNDLE_DIR/scripts/ops/sync-code.sh" && sh "$BUNDLE_DIR/scripts/ops/build-env.sh"
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
   cd "$WORKTREE_DIR" && sh "$BUNDLE_DIR_ABS/scripts/ops/sync-code.sh" && sh "$BUNDLE_DIR_ABS/scripts/ops/build-env.sh"
   ```
   Note: sync-code.sh transfers code from the worktree, so the canary propagates.
   The scripts are referenced via absolute path because the promoted bundle
   is untracked/gitignored and does not exist inside the worktree.

4. **Run and check** from the worktree context.

5. **Cleanup** happens automatically via the EXIT trap (removes worktree).

The real working tree is never touched. No stash, no restore, no risk.

PASS if the canary string appears in the run output — the build pipeline
correctly propagates source changes into execution artifacts.
FAIL if the canary is absent — stale build artifacts are served despite
source code modification. `run.sh` must execute the compiled output produced
from the current source.

### M. run.sh + collect.sh — a smoke experiment completes

Run a minimal smoke experiment and verify it produces real output:

```bash
sh "$BUNDLE_DIR/scripts/ops/launch-job.sh" audit-smoke --args "" --gpu 0 2>&1
# wait for completion (foreground mode or poll via monitor.sh)
sh "$BUNDLE_DIR/scripts/ops/collect-outputs.sh" audit-smoke
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
INFO_OUT=$(sh "$BUNDLE_DIR/scripts/ops/env-info.sh")
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
   cd "$WORKTREE_DIR" && sh "$BUNDLE_DIR_ABS/scripts/ops/sync-code.sh" && sh "$BUNDLE_DIR_ABS/scripts/ops/build-env.sh"
   sh "$BUNDLE_DIR_ABS/scripts/ops/launch-job.sh" audit-dynamic --args "" --gpu 0 2>&1
   sh "$BUNDLE_DIR_ABS/scripts/ops/collect-outputs.sh" audit-dynamic
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
   sh "$BUNDLE_DIR/scripts/ops/launch-job.sh" audit-regression --args "" --gpu 0 2>&1
   sh "$BUNDLE_DIR/scripts/ops/collect-outputs.sh" audit-regression
   ```

2. Verify receipt exists with `status: "ok"` and non-null `primary_metric`.

3. If a prior simple baseline is available at `$BUNDLE_DIR/simple_baseline.json`,
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
  - `retry_prepare` — only prepare-related checks failed, re-running sync-code.sh + build-env.sh may help
  - `patch_config` — specific env.json fields need patching
  - `full_reconfigure` — too many failures, env-configuration should re-run from scratch
  - `ask_user` — failures require human input (auto_fixable is false)

---

## Phase 2: Settle the Verdict

By this point both halves are written into `ENV_CONFIG_AUDIT.json`: the static
checks from Phase 1 and the execution checks from Phase 1.5. Read the settled
value back:

```bash
VERDICT=$(jq -r '.overall_verdict' "$AUDIT_JSON" | tr 'A-Z' 'a-z')
```

| `overall_verdict` | Meaning |
|---|---|
| `pass` | Configuration is trustworthy. |
| `warn` | Trustworthy with caveats — action items should be surfaced. |
| `fail` | Configuration is not trustworthy — specific checks failed. |
| missing / unparseable | Audit did not complete. |

**Worst check wins.** Any FAIL among A–P makes the overall FAIL; any WARN with
no FAIL makes it WARN. There is no averaging and no discretion here — the
aggregation rule is arithmetic, which is why the same agent that formed the
per-check judgments is allowed to apply it.

**The verdict is settled once.** Do not revisit a FAIL as "really a warning"
after seeing the consequence, and do not re-run a check hoping for a better
answer. The bundle's author is a different model family from this agent
(Phase 0 step 5); that independence is spent if the verdict is negotiable.

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

## Critical Rules

1. **Cross-model host, verified before any check.** Phase 0 step 5 compares
   this agent's own provider against `executor_provider` and hard-stops on a
   family match. Every claim this skill makes rests on that check having run.
2. **Dispatched only by /experiment-env-manager.** This skill is never called
   directly by users, `/experiment-env-configuration`, or other workflow skills.
   Repair cycles are owned by `/experiment-env-manager`.
3. **No repair or retry.** This skill produces a verdict and stops. Repair
   is the caller's (env-manager's) responsibility.
4. **Never spawn a reviewer sub-agent.** This agent is the reviewer. A child
   on the reviewer leg shares this host's family; a child on the executor leg
   shares the bundle author's. `mcp__paseo__create_agent` is deliberately
   absent from `allowed-tools` — freshness comes from env-manager dispatching
   a new instance of this skill per audit, not from a nested child.
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

- `skills/experiment-audit/SKILL.md` — source of checks A-F. Read as a
  checklist reference, not dispatched; this skill adds G-K and L-P.
- `shared-references/acceptance-gate.md` — DRIVE/ACQUIT; the Type-A / Type-B
  split that this skill implements.
- `shared-references/reviewer-independence.md` — why the auditor reads the
  files itself and receives paths, not summaries.
- `shared-references/paseo-subagent-dispatch.md` — Rule 1 (one agent = one
  skill), Rule 3 (file-paths-only receipts), Rule 4 (Paseo MCP only).
