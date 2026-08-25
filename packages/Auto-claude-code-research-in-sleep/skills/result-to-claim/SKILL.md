---
name: result-to-claim
description: Use when experiments complete to judge what claims the results support, what they don't, and what evidence is still missing. The Paseo codex reviewer evaluates results against intended claims and records the required next action for an explicit user decision. Use after experiments finish — before writing the paper or running ablations.
argument-hint: [experiment-description-or-wandb-run]
allowed-tools: Bash(*), Read, Grep, Glob, Write, Edit, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent

---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill; Rule 4: Paseo MCP Only, Strict). Spawn any sub-skill or sub-phase via `mcp__paseo__create_agent` — do **not** use the host `Skill` / `Agent` / `Task` tools.

> **Paseo substrate.** This skill runs inside a paseo claude sub-agent; its cross-model claim reviewer is a paseo codex sub-agent (fresh round 1, continued for follow-ups). See `shared-references/paseo-reviewer-dispatch.md`..

# Result-to-Claim Gate

> 🔒 **Do not wrap this skill in `/loop`, `/schedule`, or `CronCreate`.** It is
> verdict-bearing — it judges whether results support a claim. Re-running that
> verdict on a wall-clock timer adds no new signal (the verdict changes only
> when the _results_ change, not when the clock ticks). What you actually want
> to schedule is the _external wait that precedes it_ — experiments done → then
> run this gate **once**. See
> [`shared-references/external-cadence.md`](../shared-references/external-cadence.md).

Experiments produce numbers; this gate decides what those numbers _mean_. Collect results from available sources, get a Codex judgment, then auto-route based on the verdict.

## Context: $ARGUMENTS

## When to Use

- After a set of experiments completes (main results, not just sanity checks)
- Before committing to claims in a paper or review response
- When results are ambiguous and you need an objective second opinion

## Workflow

### Step 1: Collect Results

Gather experiment data from whatever sources are available in the project:

1. **W&B** (preferred): `wandb.Api().run("<entity>/<project>/<run_id>").history()` — metrics, training curves, comparisons
2. **EXPERIMENT_LOG.md**: full results table with baselines and verdicts
3. **EXPERIMENT_TRACKER.md**: check which experiments are DONE vs still running
4. **Log files**: `ssh server "tail -100 /path/to/training.log"` if no other source
5. **docs/research_contract.md**: intended claims and experiment design

Assemble the key information:

- What experiments were run (method, dataset, config)
- Main metrics and baseline comparisons (deltas)
- The intended claim these experiments were designed to test
- Any known confounds or caveats

### Step 1.5: Deterministic evidence pre-check (before spending a Codex call)

For every claim that cites a specific number + a source file, verify the evidence
_exists_ mechanically — no model call — to catch **hallucinated evidence** before
the jury runs (see [`shared-references/evidence-precheck.md`](../shared-references/evidence-precheck.md)).

**1. Build the claims list.** From the cited numbers and their result files, write
`[{"id", "value", "source"}, ...]` to `.aris/claims.json` (`source` is the result
file/glob relative to the project root; `value` is the cited number or string).

**2. Run the pre-check — this is a real step, not a suggestion.** Execute the block
below. The helper is required; an unresolved or failed helper blocks claim
generation.

```bash
# The helper is load-bearing. Its absence or failure blocks this phase.
_pr=$(git rev-parse --show-toplevel 2>/dev/null) || { _d=$(pwd); while [ "$_d" != "/" ]; do [ -f "$_d/.aris/installed-skills.txt" ] && { _pr=$_d; break; }; _d=$(dirname "$_d"); done; }
cd "${_pr:-$(pwd)}" || exit 1
EVIDENCE_CHECK=".aris/dist/tools/evidence-check.js"
[ -f "$EVIDENCE_CHECK" ] || EVIDENCE_CHECK="dist/tools/evidence-check.js"
[ -f "$EVIDENCE_CHECK" ] || {
  echo "ERROR: evidence-check.js is required for claim generation." >&2
  exit 1
}

mkdir -p .aris
node "$EVIDENCE_CHECK" . --batch .aris/claims.json > .aris/evidence_precheck.json 2>.aris/evidence_precheck.err || {
  echo "ERROR: evidence-check.js failed; claim generation is blocked." >&2
  exit 1
}
python3 -c "import json;json.load(open('.aris/evidence_precheck.json'))" || {
  echo "ERROR: evidence-check.js produced invalid JSON." >&2
  exit 1
}
cat .aris/evidence_precheck.json
```

The output is `{"results": [{id, value, source, status, ...}], "summary": {status: n}}`
with `status ∈ {verified, value_not_found, path_missing, source_unreadable, unparseable}`.

**3. Act on the statuses.** Any claim returned `value_not_found`, `path_missing`,
`source_unreadable`, or `unparseable` blocks claim generation. Record the
failed pre-check and fix `.aris/claims.json`; do not spend a Codex call
defending a number that cannot be tied to readable evidence.

**4. Carry the per-claim status into Step 2.** Feed a small
`evidence pre-check: <id> → verified | value_not_found | path_missing | source_unreadable | unparseable`
table (from `.aris/evidence_precheck.json`) into the Step-2 Codex prompt so the jury knows
which claims have real evidence to read.

`verified` here means only that the cited evidence **exists** — whether it
**supports** the claim is still the Codex jury's call in Step 2 (a deterministic
gate DRIVES, it does not ACQUIT).

### Step 2: Codex Judgment

Spawn a paseo codex reviewer sub-agent (fresh) per `shared-references/paseo-reviewer-dispatch.md` to evaluate the results objectively. A new invocation after user-requested experiments starts a fresh review; this skill does not automatically launch a supplementary round.

```
  config: {"model_reasoning_effort": "xhigh"}
  prompt: |
    RESULT-TO-CLAIM EVALUATION

    I need you to judge whether experimental results support the intended claim.

    Intended claim: [the claim these experiments test]

    Experiments run:
    [list experiments with method, dataset, metrics]

    Results:
    [paste key numbers, comparison deltas, significance]

    Evidence pre-check (deterministic, from Step 1.5):
    [per-claim: <id> → verified | value_not_found | path_missing.
     A value_not_found/path_missing means the cited number is NOT in its result
     file — treat that claim as having no evidence; do not defend it. `verified`
     means the number exists in the file — YOU still judge whether it supports
     the claim.]

    Baselines:
    [baseline numbers and sources — reproduced or from paper]

    Known caveats:
    [any confounding factors, limited datasets, missing comparisons]

    Please evaluate:
    1. claim_supported: yes | partial | no
    2. what_results_support: what the data actually shows
    3. what_results_dont_support: where the data falls short of the claim
    4. missing_evidence: specific evidence gaps
    5. suggested_claim_revision: if the claim should be strengthened, weakened, or reframed
    6. next_experiments_needed: specific experiments to fill gaps (if any)
    7. confidence: high | medium | low

    Be honest. Do not inflate claims beyond what the data supports.
    A single positive result on one dataset does not support a general claim.
```

### Step 3: Parse and Normalize

Extract structured fields from Codex response:

```markdown
- claim_supported: yes | partial | no
- what_results_support: "..."
- what_results_dont_support: "..."
- missing_evidence: "..."
- suggested_claim_revision: "..."
- next_experiments_needed: "..."
- confidence: high | medium | low
```

### Step 3.5: Check Experiment Integrity (if audit exists)

The experiment audit is required when the project enables experiment-integrity
checking. A missing requested audit blocks claim generation.

```
if EXPERIMENT_AUDIT.json exists:
    read integrity_status from file
    attach to verdict output:
        integrity_status: pass | warn | fail

    if integrity_status in {"warn", "fail"}:
        append to the failed receipt: "experiment audit did not PASS; see EXPERIMENT_AUDIT.md"
        stop claim generation. Do not lower confidence and continue with a
        claim that depends on an unresolved integrity result.
else:
    fail the claim phase with a missing-audit receipt
```

See `shared-references/experiment-integrity.md` for the full integrity protocol.

### Step 4: Route Based on Verdict

#### `no` — Claim not supported

1. Record postmortem in findings.md (Research Findings section):
   - What was tested, what failed, hypotheses for why
   - Constraints for future attempts (what NOT to try again)
2. Update CLAUDE.md Pipeline Status
3. Record that the claim is unsupported and stop this stage. A pivot or new approach requires an explicit new invocation; do not select one automatically.

#### `partial` — Claim partially supported

1. Update the working claim to reflect what IS supported
2. Record the gap in findings.md — Step 5 also files it as an open `problem`
   entity so the next iteration's idea discovery reads it as a search seed
3. Record the required supplementary experiments as a proposal and stop this stage
4. Run a new `/result-to-claim` invocation only after the user explicitly requests those experiments
5. **Multiple rounds of `partial` on the same claim** → record analysis in findings.md; the user decides whether to narrow the claim scope or switch ideas

#### `yes` — Claim supported

1. Record confirmed claim in project notes
2. If ablation studies are incomplete → trigger `/ablation-planner`
3. If all evidence is in → ready for paper writing

### Step 5: Update Research Wiki (if active)

**Skip this step entirely if `research-wiki/` does not exist.**

If `research-wiki/` exists, resolve `$WIKI_SCRIPT` per the canonical
chain documented in
[`shared-references/wiki-helper-resolution.md`](../shared-references/wiki-helper-resolution.md)
(The helper is required when `research-wiki/` exists.) The verdict / idea-outcome
page edits below run on raw markdown, but edges, problem entities, query-pack
rebuild, and the log line must still succeed. **This skill never
edits a claim's `status` field and never creates a claim node** — claims are
born (and their proof `status` set) by `/proof-checker`; here we only attach
experiment edges. It IS a birth point for `problem` entities: an unresolved
cause found in a `partial` / `no` verdict becomes a child of the run's root
problem (see #4 below).

```bash
_pr=$(git rev-parse --show-toplevel 2>/dev/null) || { _d=$(pwd); while [ "$_d" != "/" ]; do [ -f "$_d/.aris/installed-skills.txt" ] && { _pr=$_d; break; }; _d=$(dirname "$_d"); done; }
cd "${_pr:-$(pwd)}" || exit 1
WIKI_SCRIPT=".aris/dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || WIKI_SCRIPT="dist/tools/research-wiki.js"
[ -f "$WIKI_SCRIPT" ] || {
  echo "ERROR: research-wiki.js is required for claim integration." >&2
  exit 1
}
```

```
if research-wiki/ exists:
    # Placeholder values → the caller must pin these; when dispatched from
    # /auto-review-loop's termination step they arrive in the dispatch prompt:
    #   <active_idea> = the idea's canonical node id EXACTLY as carried by
    #     dashboard.best_idea.id / manifest.context.chosen_idea_id (already idea:<slug>).
    #     Pass it through verbatim → add_experiment adds the idea: prefix only when
    #     missing, so pre-pending one here produces idea:idea:<slug> and a dangling edge.
    #   <exp_id> = the stable slug of the experiment being judged. From
    #     /auto-review-loop it is iter-<iteration> (one experiment node per loop
    #     iteration); standalone runs use the experiment's own slug from the tracker.
    #
    # 1. Create/refresh the experiment node FIRST (verdict OWNER → --update-on-exist so
    #    a re-judge overwrites the stale verdict). The supports/invalidates edges in #2
    #    point FROM exp:<id>, so this operation must succeed before edges are written.
    node "$WIKI_SCRIPT" add_experiment research-wiki/ \
      --slug "<exp_id>" --idea "<active_idea>" \
      --verdict "<yes|partial|no>" --confidence "<high|medium|low>" \
      --date "<date>" --hardware "<hw>" --duration "<dur>" \
      --metrics "<key metrics>" --reasoning "<one-line why this verdict>" \
      --provenance "<EXPERIMENT_AUDIT.md / run dir>" --update-on-exist || exit 1

    # 2. Record empirical support as EDGES ONLY. Never edit the
    #    claim page's `status`: that is the PROOF axis (verified / refuted / unproven /
    #    sound-modulo-imports / drafted / retracted), owned by /proof-checker (the claim
    #    birth point) — "supported"/"invalidated" are NOT valid claim statuses. The claim
    #    target should ALREADY be born by /proof-checker; add_edge does not verify it.
    for each claim resolved by this verdict:
        if verdict == "yes":
            node "$WIKI_SCRIPT" add_edge research-wiki/ --from "exp:<id>" --to "claim:<cid>" --type supports --evidence "<metric>" || exit 1
        elif verdict == "partial":
            node "$WIKI_SCRIPT" add_edge research-wiki/ --from "exp:<id>" --to "claim:<cid>" --type supports --evidence "partial: <metric>" || exit 1
        else:
            node "$WIKI_SCRIPT" add_edge research-wiki/ --from "exp:<id>" --to "claim:<cid>" --type invalidates --evidence "<why>" || exit 1

    # 3. Update idea outcome (raw markdown, helper-free)
    Update research-wiki/ideas/<idea_id>.md:
      - outcome: positive | mixed | negative
      - If negative: fill "Failure / Risk Notes" and "Lessons Learned"
      - If positive: fill "Actual Outcome" and "Reusable Components"

    # 4. Problem entities: the failure analysis becomes the next iteration's search seed.
    #    Sub-problems attach to the run's root problem via --parent, so /idea-creator's
    #    Phase 0 read of query_pack's "Open Problems" section picks them up next round.
    #    Every problem is born here or at /research-setup (root) or /kill-argument
    #    (attack-derived) — never freehand markdown.
    if verdict == "partial" or verdict == "no":
          # one call per distinct unresolved cause named in the Codex reasoning /
          # missing_evidence / next_experiments_needed fields (do NOT emit one per metric)
          node "$WIKI_SCRIPT" add_problem research-wiki/ \
            --slug "<stable-kebab-slug>" --title "<what is unsolved, one line>" \
            --parent "problem:root" --status open \
            --severity "<high|medium|low>" \
            --statement "<what is unsolved and why it blocks the metric>" \
            --origin "to close <parent problem>, idea:<idea_id> was tested by exp:<exp_id>; verdict=<partial|no>" \
            --evidence "<evidence paths + the concrete values that show the failure>" \
            --what-would-solve "<the measurable result that would close or refute this>" \
            --caveats "<confounders; what NOT to conclude from this run>" \
            || exit 1
      elif verdict == "yes":
          # Close ONLY the problems whose what-would-solve condition THIS experiment's
          # evidence actually meets (per the Codex judgment's what_results_support),
          # NEVER every target problem by default.
          # problem:root is NEVER closed here: it is the run-level metric gap, and a
          # supported claim is not a met target (iteration 1 reproducing the baseline
          # is a yes verdict with the metric still below target). Root is closed once
          # per run by the summary worker, after the metric gate reports metric_met.
          for each problem id in idea page's `target_problems` where the Codex
          judgment names its closing condition as met, EXCLUDING problem:root:
              node "$WIKI_SCRIPT" add_problem research-wiki/ \
                --slug "<slug>" --status solved \
                --evidence "<closing evidence path + value>" --update-on-exist \
                || exit 1
                # title/statement/origin/what-would-solve/caveats/severity/parent are
                # NOT passed on close: add_problem's update path preserves them from
                # the existing page, so closing never rewrites history.

    # 5. Rebuild + log
    node "$WIKI_SCRIPT" rebuild_query_pack research-wiki/ || exit 1
    node "$WIKI_SCRIPT" log research-wiki/ "result-to-claim: exp:<id> verdict=<verdict> for idea:<idea_id>" || exit 1

    # 6. Re-ideation suggestion
    Count failed/partial ideas since last /idea-creator run.
    If >= 3: print "💡 3+ ideas tested since last ideation. Consider re-running /idea-creator — the wiki now knows what doesn't work."
```

## Rules

- **Codex is the judge, not CC.** CC collects evidence and routes; Codex evaluates. This prevents post-hoc rationalization.
- Do not inflate claims beyond what the data supports. If Codex says "partial", do not round up to "yes".
- A single positive result on one dataset does not support a general claim. Be honest about scope.
- If `confidence` is low, treat the judgment as inconclusive and add experiments rather than committing to a claim.
- If the selected Codex reviewer is unavailable or its call fails, write a
  failed receipt. CC must not replace the independent judgment.
- Always record the verdict and reasoning in findings.md, regardless of outcome.

## Review Tracing

After each paseo codex reviewer sub-agent call (fresh `create_agent`,
continuation `send_agent_prompt`), save the trace with the required
`save_trace.sh` helper from `shared-references/review-tracing.md`. If the
helper is missing or fails, fail the claim phase; do not write a second trace
format inline.
