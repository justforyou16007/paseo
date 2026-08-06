---
name: analyze-results
description: 'Iterative experiment analysis driver. Runs analyze.sh to collect results, dispatches a cross-model verifier to evaluate completeness, then iterates: modifying analyze.sh and/or triggering supplementary experiments until the verifier passes. Produces comparison tables, statistical tests, insights, and a completeness verdict. Use when user says "analyze results", "分析结果", "compare experiments", "结果分析", or after experiments complete and results need interpretation.'
argument-hint: "[— project: <name>] [— max-rounds: N] [— method: <existing-analysis-script-or-command>]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, AskUserQuestion, WebSearch, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__wait_for_agent, mcp__paseo__archive_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission
---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in
> [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill;
> Rule 4: Paseo MCP Only, Strict). The Phase 3 verifier is dispatched via
> `mcp__paseo__create_agent` — not the host `Skill` / `Agent` / `Task` tools.

> **Gate provenance** (`shared-references/acceptance-gate.md` step 5).
> This skill has one STOP gate: *is the analysis sufficiently complete and rigorous?*
> - **Type-A** (self-checkable): tables parse, statistics are computed, files exist.
> - **Type-B** (never self-judged): *is the analysis thorough enough to support
>   claims?* This verdict is produced by a fresh cross-model verifier and read
>   verbatim. This skill never forms its own opinion of completeness.

# Analyze Results

Iterative experiment analysis for: **$ARGUMENTS**

## Purpose

Experiment analysis is not a one-shot operation. The first pass often reveals
gaps: missing experiments, insufficient seeds, uncovered error modes, or shallow
insights. This skill drives an iterative loop:

1. Run analysis (using an existing method or analyze.sh)
2. Dispatch a cross-model verifier to evaluate completeness
3. If incomplete: fix analyze.sh / trigger supplementary experiments
4. Repeat until the verifier passes or the user accepts

```
Phase 0    Resolve project + locate generated skill
Phase 1    Bootstrap — use existing method or analyze.sh for first analysis
Phase 2    Analysis — comparison tables, statistics, insights
Phase 3    Dispatch verifier (Type-B gate) — cross-model completeness audit
Phase 4    Iteration loop — address verifier gaps, re-analyze, re-verify
Phase 5    Final output — complete analysis report
```

---

## Phase 0: Resolve Project

1. **Derive project slug.**
   ```bash
   ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
   PROJECT=$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')
   ```

2. **Locate generated skill.**
   ```bash
   SKILL_DIR=".claude/skills/run-${PROJECT}-experiment"
   [ -d "$SKILL_DIR/scripts" ] || { echo "ERROR: experiment skill not found at $SKILL_DIR. Run /experiment-env-configuration first." >&2; exit 1; }
   ```

3. **Read config.** Parse `$SKILL_DIR/env.json` for `feedback.analysis` and
   `feedback.error` settings.

4. **Parse `— method`** argument if provided. Record as `initial_method`
   (a script path or shell command the user already uses for analysis).

---

## Phase 1: Bootstrap

The first analysis run uses either the user's existing method or the standard
analyze.sh path.

**If `— method: <path-or-command>` is provided:**

- Execute the user's specified method/script/command
- Capture its output (stdout + any files it writes)
- This output seeds the first round — what it already covers doesn't need
  re-analysis; what it misses becomes the iteration target
- If the method produces structured output (JSON/CSV), parse it into the
  same format as analyze.sh would produce
- Incorporate the method into `analyze.sh` Stage 2 if not already there
  (so future rounds don't lose what it already does)

**Otherwise (standard path):**

- Execute `sh "$SKILL_DIR/scripts/analyze.sh"`
- Read `<output_dir>/error_report.md` (Stage 1 error collection)
- Read the Stage 2 analysis output at `feedback.analysis.output_path`

In both cases, collect all result files from `results/`, `logs/`, and any
other directories referenced in `env.json`.

---

## Phase 2: Analysis

Build the structured analysis from collected data. This is **Type-A work** —
the skill can judge whether tables are correct and stats are computed properly.

### Step 2a: Build Comparison Table

Organize results by:
- Independent variables: model type, hyperparameters, data config, seed
- Dependent variables: primary metric, secondary metrics
- Delta vs baseline: always compute relative improvement
- Group by experiment purpose (from EXPERIMENT_PLAN.md if available)

### Step 2b: Statistical Analysis

- Multiple seeds → mean ± std, check reproducibility
- Parameter sweep → identify trends (monotonic, U-shaped, plateau)
- Flag outliers or suspicious results (>3σ from mean)
- Compute p-values for key comparisons when seeds ≥ 3

### Step 2c: Generate Insights

For each finding, structure as:
1. **Observation**: what the data shows (with numbers)
2. **Interpretation**: why this might be happening
3. **Implication**: what this means for the research question
4. **Next step**: what experiment would test the interpretation

### Step 2d: Write Analysis Artifact

Write to `feedback.analysis.output_path` (default `refine-logs/EXPERIMENT_RESULTS.md`).

---

## Phase 3: Dispatch Verifier (Type-B Gate)

**The completeness question is Type-B.** This skill produced the analysis —
the same reasoning that finds its own work adequate would also miss its own
blind spots. A fresh cross-model verifier evaluates completeness.

Dispatch a **paseo sub-agent** per Rule 1 / Rule 4:

```
mcp__paseo__create_agent
  title:    "analysis completeness audit: <project>"
  provider: claude
  cwd:      $ROOT
  initialPrompt: |
    Review the experiment analysis for completeness and rigor.

    Artifacts to read (paths only — read them yourself):
      Analysis output:     <feedback.analysis.output_path>
      Error report:        <output_dir>/error_report.md
      Experiment plan:     refine-logs/EXPERIMENT_PLAN.md
      Experiment tracker:  refine-logs/EXPERIMENT_TRACKER.md
      Result files:        results/
      analyze.sh:          <SKILL_DIR>/scripts/analyze.sh
      env.json:            <SKILL_DIR>/env.json

    Evaluate against these criteria — report each as PASS | WARN | FAIL:

    A. Coverage — are all planned experiments represented in results?
       FAIL if experiment plan exists and >20% of entries have no result.
    B. Statistical rigor — do claims have sufficient statistical support?
       FAIL if single-seed results are presented as conclusive.
    C. Comparison completeness — are all critical baselines compared?
       FAIL if the primary baseline comparison is missing.
    D. Error coverage — does the error report capture all anomalies?
       WARN if log files contain unmatched suspicious patterns.
    E. Insight depth — are findings evidence-backed, not just numbers?
       WARN if insights lack interpretation or next-step reasoning.
    F. Reproducibility — could someone replicate from this report?
       WARN if key hyperparameters or configs are omitted.

    Output:
      .aris/env-config/<project>/ANALYSIS_AUDIT.md (human-readable report)
      .aris/env-config/<project>/ANALYSIS_AUDIT.json:
      {
        "overall_verdict": "pass|warn|fail",
        "checks": { "A": "pass|warn|fail", "B": "...", ... },
        "gaps": [
          { "check": "A", "description": "...",
            "suggested_action": "run_experiment|modify_analyze_sh|add_analysis" }
        ]
      }

    Reply with the two file paths only.
```

Then `mcp__paseo__wait_for_agent`, read the receipt, `mcp__paseo__archive_agent`.

**Type-A self-check:** `ANALYSIS_AUDIT.json` exists and parses.
**Type-B read:** transcribe `overall_verdict` and `gaps[]` verbatim.

---

## Phase 4: Iteration Loop

Read `ANALYSIS_AUDIT.json`:

**If `overall_verdict == "pass"` or `"warn"`:** proceed to Phase 5.
On `"warn"`, carry the WARN items as caveats in the final report.

**If `overall_verdict == "fail"`:** present gaps to the user, then iterate.

1. `AskUserQuestion`:
   - header: "分析审计未通过"
   - question: "Verifier 发现以下不足：\n<gaps with descriptions and suggested actions>\n\n请选择："
   - options:
     - `"执行全部补充"` — auto-execute all suggested actions
     - `"选择性补充"` — user picks which gaps to address
     - `"分析已足够，跳过"` — accept current analysis, set `user_override`

2. For each gap to address:

   **`suggested_action: run_experiment`**
   - Dispatch `run-<project>-experiment` via paseo sub-agent with the
     specific experiment parameters from the gap description
   - Wait for completion (monitor.sh)
   - Re-run Phase 1 → 2 → 3

   **`suggested_action: modify_analyze_sh`**
   - Edit `$SKILL_DIR/scripts/analyze.sh` to address the identified gap
     (e.g., add error patterns, broaden log scanning)
   - Re-run Phase 1 → 2 → 3

   **`suggested_action: add_analysis`**
   - Add missing analysis logic to analyze.sh Stage 2 or write it inline
     (e.g., add a missing comparison, compute a missing statistic)
   - Re-run Phase 1 → 2 → 3

3. Each iteration dispatches a **fresh** verifier (not a continuation —
   the reviewer must not be anchored on the previous round).

4. Continue until `overall_verdict != "fail"` or user chooses "跳过".

Default `— max-rounds: 5` (user can override). If max rounds reached,
present the remaining gaps and ask whether to continue or accept.

User override sets `analysis_audit.status = "user_override"`.

---

## Phase 5: Final Output

When analysis is complete (verifier passes or user accepts):

Write `refine-logs/EXPERIMENT_RESULTS.md`:

```markdown
# Experiment Results — <project>

## Analysis Status
- Verifier verdict: <pass|warn|user_override>
- Iterations: <N> rounds
- Method: <initial_method or "standard analyze.sh">

## Raw Data Tables
<all experiments, all metrics, organized by experiment group>

## Comparison Tables
<vs baseline, vs ablations, with deltas and significance>

## Statistical Summary
<mean ± std, p-values, confidence intervals>

## Key Findings
1. <finding with evidence>
2. ...

## Analysis Iteration Log
- Round 1: <what was analyzed, what gaps found>
- Round 2: <what was supplemented>
- ...

## Caveats
<any WARN items from verifier, any gaps user chose to skip>
```

Update `refine-logs/EXPERIMENT_TRACKER.md` with analysis status column.

Write receipt `.aris/runs/<run_id>.analyze-results.<project>.done.json`:
```json
{
  "skill": "analyze-results",
  "project": "<project>",
  "verdict": "pass|warn|user_override",
  "iterations": 0,
  "output": "refine-logs/EXPERIMENT_RESULTS.md",
  "audit_report": ".aris/env-config/<project>/ANALYSIS_AUDIT.md",
  "completed_at": "<ISO-8601>"
}
```

---

## Constants

- **DEFAULT_MAX_ROUNDS** = 5
- **AUDIT_DIR** = `.aris/env-config/<project>`
- **DEFAULT_OUTPUT** = `refine-logs/EXPERIMENT_RESULTS.md`

## Critical Rules

1. **Never self-judge completeness.** The verifier (Type-B) decides whether
   the analysis is thorough. This skill executes the analysis and reads the
   verdict — it does not form its own opinion of adequacy.
2. **Fresh verifier per round.** Each verification dispatches a new sub-agent.
   Never continue a prior verification thread.
3. **User controls iteration.** On verifier FAIL, the user chooses what to
   supplement. The skill never autonomously decides to stop iterating.
4. **`— method` seeds, doesn't replace.** An existing analysis method becomes
   the starting point; the iterative process may extend beyond it.
5. **Modify analyze.sh, don't bypass it.** When adding analysis logic, write
   it into the generated scripts so it persists for future runs — don't run
   one-off commands that aren't captured.
6. **File-paths-only receipts.** The receipt carries paths; the dispatching
   parent reads the files themselves.

## External dependencies (reused, not modified)

- `.claude/skills/run-<project>-experiment/` — the generated experiment skill
  (scripts + env.json). Must exist before this skill runs.
- `shared-references/acceptance-gate.md` — DRIVE/ACQUIT; the Type-A / Type-B
  split that Phase 3 implements.
- `shared-references/reviewer-independence.md` — why the verifier reads files
  itself.
- `shared-references/paseo-subagent-dispatch.md` — Rule 1, Rule 3, Rule 4.
- `refine-logs/EXPERIMENT_PLAN.md` — the experiment roadmap (read by verifier
  to check coverage).
- `refine-logs/EXPERIMENT_TRACKER.md` — run-by-run status (updated at end).
