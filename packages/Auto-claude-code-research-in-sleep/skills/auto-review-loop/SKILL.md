---
name: auto-review-loop
description: Autonomous multi-round research review loop. Repeatedly reviews via external reviewer backend (Codex or manual), implements fixes, and re-reviews until positive assessment or max rounds reached. Use when user says "auto review loop", "review until it passes", or wants autonomous iterative improvement.
argument-hint: [topic-or-scope]
allowed-tools: Bash(*), Read, Grep, Glob, Write, Edit, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__archive_agent, mcp__manual_review__review, mcp__manual_review__review_reply
---

> **Paseo substrate.** This workflow (W2) runs as ONE paseo claude agent looping rounds 1→N internally; round 1 spawns a fresh codex reviewer sub-agent and round 2+ continues it with `send_agent_prompt` when reviewer memory is required. See `shared-references/paseo-subagent-dispatch.md` (fence) + `paseo-reviewer-dispatch.md` (fresh-vs-continuation). **Strict mode**: Paseo MCP is required; if unavailable, the run BLOCKS (per `paseo-subagent-dispatch.md`).

# Auto Review Loop: Autonomous Research Improvement

> 🔒 **Do not wrap this skill in `/loop`, `/schedule`, or `CronCreate`.** It
> already loops internally (review → fix → re-review) and the reviewer carries
> round-to-round memory in one Paseo agent ID. An external timer
> re-enters from the top each tick — fresh `threadId`, reviewer memory reset —
> firing the verdict on wall-clock time instead of on artifact change: zero new
> signal, full token cost. If you want to schedule something, schedule the
> _external wait that precedes it_ (experiments done → then run this once). See
> [`shared-references/external-cadence.md`](../shared-references/external-cadence.md).

Autonomously iterate: review → implement fixes → re-review, until the external reviewer gives a positive assessment or MAX_ROUNDS is reached.

## Context: $ARGUMENTS

## Constants

- MAX_ROUNDS = 4
- POSITIVE_THRESHOLD: score >= 6/10 **AND** verdict ∈ {"ready", "almost"}. Both conditions must hold; a `not ready` verdict always continues the loop.
- REVIEW*DOC: `$OUTPUT_DIR/AUTO_REVIEW.md` (cumulative log)
- REVIEWER_MODEL = `gpt-5.5` — Default model for the Codex backend. Must be an OpenAI model (e.g., `gpt-5.5`, `o3`, `gpt-4o`). Manual backend uses whatever model the user chooses.
- **REVIEWER_BACKEND = `codex`** — Default: paseo codex sub-agent (xhigh). Override with
  `— reviewer: oracle-pro` or `— reviewer: manual` explicitly. If the selected
  reviewer is unavailable, stop and print the install/configuration action.
- **OUTPUT_DIR** — Supplied by the worker manifest. All review outputs stay in
  this directory.
- **HUMAN_CHECKPOINT = false** — When `true`, pause after each round's review (Phase B) and present the score + weaknesses to the user. Wait for user input before proceeding to Phase C. The user can: approve the suggested fixes, provide custom modification instructions, skip specific fixes, or stop the loop early. When `false` (default), the loop runs fully autonomously.
- **COMPACT = false** — When `true`, (1) read `EXPERIMENT_LOG.md` and `findings.md` instead of parsing full logs on session recovery, (2) append key findings to `findings.md` after each round.
- **REVIEWER_DIFFICULTY = medium** — Controls how adversarial the reviewer is. Three levels:
  - `medium` (default): MCP-based review; the executor controls what context the reviewer sees.
  - `hard`: Adds **Reviewer Memory** (the reviewer tracks its own suspicions across rounds) + **Debate Protocol** (the executor can rebut, the reviewer rules).
  - `nightmare`: Everything in `hard` + the paseo codex reviewer reads the repo
    directly in `full-access` mode and independently checks claims.
- **RENDER_HTML = true** — When `true` (default), render `$OUTPUT_DIR/AUTO_REVIEW.md`
  to HTML on loop termination via `/render-html`. Set `false` explicitly to
  disable this artifact.

> ⚠️ **Nightmare + Manual incompatibility**: If `REVIEWER_BACKEND = manual` and `REVIEWER_DIFFICULTY = nightmare`, STOP with:
> "difficulty: nightmare requires the Paseo Codex reviewer and is not compatible
> with --reviewer: manual. Use difficulty: hard, or switch reviewer to codex."

> 💡 Override: `/auto-review-loop "topic" — compact: true, human checkpoint: true, difficulty: hard`

## Reviewer Calling Convention

When calling the reviewer, branch on REVIEWER_BACKEND:

**If REVIEWER_BACKEND = `codex`** (default):
Round 1 (fresh): spawn a paseo codex reviewer sub-agent (fresh) per `shared-references/paseo-reviewer-dispatch.md`; persist its agent-id to `REVIEW_STATE.json`'s `threadId` field.
Round 2+ (continuation): continue the SAME paseo codex reviewer sub-agent via `send_agent_prompt` per `paseo-reviewer-dispatch.md` so the reviewer checks resolution against its OWN prior critique.
Store the paseo codex agent-id in `threadId`; use it as the continuation handle for the Debate rebuttal step.
Paseo MCP is required for reviewer dispatch; the run BLOCKS if unavailable.

**If REVIEWER_BACKEND = `manual`:**
Use `mcp__manual_review__review` for new review threads with:
prompt: [exact same prompt that would go to Codex]
config: {"model_reasoning_effort": "xhigh"}
Save the returned `threadId`.
Use `mcp__manual_review__review_reply` for follow-up rounds with:
threadId: [saved manual-review threadId]
prompt: [follow-up prompt]
config: {"model_reasoning_effort": "xhigh"}

Prompt fidelity: the manual prompt must be exactly the same text that Codex would receive.
Review tracing applies equally to both backends.

## State Persistence (Compact Recovery)

Long-running loops may hit the context window limit, triggering automatic compaction. To survive this, persist state to `$OUTPUT_DIR/REVIEW_STATE.json` after each round:

```json
{
  "round": 2,
  "threadId": "019cd392-...",
  "status": "in_progress",
  "difficulty": "medium",
  "last_score": 5.0,
  "last_verdict": "not ready",
  "pending_experiments": ["screen_name_1"],
  "timestamp": "2026-03-13T21:00:00"
}
```

**Write this file at the end of every Phase E** (after documenting the round). Overwrite each time — only the latest state matters.

**On completion** (positive assessment or max rounds), set `"status": "completed"` so future invocations don't accidentally resume a finished loop.

## Output Protocols

> Follow these shared protocols for all output files:
>
> - **[Output Versioning Protocol](../shared-references/output-versioning.md)** — write timestamped file first, then copy to fixed name
> - **[Output Manifest Protocol](../shared-references/output-manifest.md)** — log every output to MANIFEST.md
> - **[Output Language Protocol](../shared-references/output-language.md)** — respect the project's language setting

## Manifest Protocol (Worker Mode)

When invoked with `— manifest: <path>`, this skill runs as a worker under an
orchestrator (`/research-pipeline` or `/auto-research-loop`). The manifest
provides all inputs; the skill writes its receipt to the manifest's directory.

**Startup check:**
```
if "$ARGUMENTS" contains "— manifest:"; then
    MANIFEST_PATH=<extracted path>
    MANIFEST=$(cat "$MANIFEST_PATH")
    WORKER_DIR=$(dirname "$MANIFEST_PATH")
    OUTPUT_DIR=$(jq -r '.output_dir' <<< "$MANIFEST")
    mkdir -p "$OUTPUT_DIR"
    # Read inputs from manifest.inputs (file paths)
    # Read context from manifest.context (scalar values)
fi
```

In worker mode, begin from `manifest.inputs.results`,
`manifest.inputs.tracker`, and `manifest.inputs.analysis`. These are the
experiment-bridge artifacts for the current iteration. Do not treat files
under this worker's own future `final-inputs/` or `final-analysis/` directories
as startup inputs; those paths are created only during termination after all
review fixes and reruns finish.

**Receipt (write last to `$WORKER_DIR/receipt.json`):**
```json
{
  "worker": "auto-review-loop",
  "iteration": 1,
  "run_id": "<run-id>",
  "status": "done",
  "error": null,
  "primary_output": "AUTO_REVIEW.md",
  "summary": { "rounds": 2, "final_score": 7.0, "final_verdict": "ready", "analysis_verdict": "pass" },
  "dashboard_patch": {
    "last_review.verdict": "ready",
    "last_review.score": 7,
    "last_review.reviewer_id": "codex-agent-id",
    "metric.current": 0.84,
    "metric.delta": 0.07,
    "statistical_significance": true
  },
  "completed_at": "<ISO-8601>",
  "has_errors": false,
  "error_count": 0
}
```

> **Boundary note.** `dashboard_patch` carries the iteration's quality verdict
> (`verdict` ∈ {ready, almost, not ready}, `score`, `reviewer_id`) and, for a
> metric-target run, the final metric copied from the termination analysis. It does
> **not** include `metric_progress`, `stop`, `continue`, or `pivot` - those
> concepts do not exist in this skill's vocabulary. The loop-stop decision is
> made by the research-loop orchestrator based on dashboard arithmetic alone.

On failure, write receipt with `"status": "failed"` and structured `error` object
per `worker-manifest.md`. Append system errors to `$WORKER_DIR/progress_error.md`.

**Worker mode is required.** The manifest supplies all inputs and
`$OUTPUT_DIR`; the skill writes its receipt beside the manifest. There is no
manifest-scoped output path.

## Workflow

### Initialization

1. **Check for `$OUTPUT_DIR/REVIEW_STATE.json`**:
   - If it does not exist: **fresh start**
   - If it exists AND `status` is `"completed"`: **fresh start** (previous loop finished normally)
   - If it exists AND `status` is `"in_progress"` AND `timestamp` is older than 24 hours: fail with a stale-state receipt and ask the user to invoke an explicit fresh run
   - If it exists AND `status` is `"in_progress"` AND `timestamp` is within 24 hours: **resume**
     - Read the state file to recover `round`, `threadId`, `last_score`, `pending_experiments`
     - Read `$OUTPUT_DIR/AUTO_REVIEW.md` to restore full context of prior rounds
     - If `pending_experiments` is non-empty, check if they have completed (e.g., check screen sessions)
     - Resume from the next round (round = saved round + 1)
     - Log: "Recovered from context compaction. Resuming at Round N."
2. Read project narrative documents, memory files, and any prior review documents. **When `COMPACT = true`**: read `findings.md` + `EXPERIMENT_LOG.md` in addition to `$OUTPUT_DIR/AUTO_REVIEW.md`.
3. Read recent experiment results (check output directories, logs)
4. Identify current weaknesses and open TODOs from prior reviews
5. Initialize round counter = 1 (unless recovered from state file)
6. Create/update `$OUTPUT_DIR/AUTO_REVIEW.md` with header and timestamp

### Loop (repeat up to MAX_ROUNDS)

#### Phase A: Review

**Route by REVIEWER_DIFFICULTY:**

##### Medium (default) — MCP Review

Send comprehensive context to the external reviewer using the selected backend. Dispatch per the Reviewer Calling Convention above — round 1 spawns a fresh paseo codex reviewer sub-agent via `mcp__paseo__create_agent`, round 2+ continues it via `mcp__paseo__send_agent_prompt` (per `paseo-reviewer-dispatch.md`).

_For codex backend:_

```
  config: {"model_reasoning_effort": "xhigh"}
  prompt: |
    [Round N/MAX_ROUNDS of autonomous review loop]

    Review the work directly from its artifacts — executor notes are not
    evidence, so read the files yourself rather than trusting my framing:
    - Claims / paper draft: <path>
    - Methods / code under review: <path(s)>
    - Raw results (verbatim files, not a summary): <path(s)>
    - Changed since last round: <changed-file paths> — read the diff, not my description

    Please act as a senior ML reviewer (NeurIPS/ICML level).

    1. Score this work 1-10 for a top venue
    2. List remaining critical weaknesses (ranked by severity)
    3. For each weakness, specify the MINIMUM fix (experiment, analysis, or reframing)
    4. State clearly: is this READY for submission? Yes/No/Almost

    Be brutally honest. If the work is ready, say so clearly.
```

_For manual backend:_ use `mcp__manual_review__review` with the `prompt` text above and `config: {"model_reasoning_effort": "xhigh"}`. Save the returned `threadId`.

If this is round 2+, continue the SAME paseo codex reviewer sub-agent via `mcp__paseo__send_agent_prompt` per `paseo-reviewer-dispatch.md`, or `mcp__manual_review__review_reply` (manual) with the saved threadId.

##### Hard — MCP Review + Reviewer Memory

Same as medium, but **prepend Reviewer Memory** to the prompt. Use the selected backend.

_For codex backend:_

```
  config: {"model_reasoning_effort": "xhigh"}
  prompt: |
    [Round N/MAX_ROUNDS of autonomous review loop]

    ## Your Reviewer Memory (persistent across rounds)
    [Paste full contents of REVIEWER_MEMORY.md here]

    IMPORTANT: You have memory from prior rounds. Check whether your
    previous suspicions were genuinely addressed or merely sidestepped.
    The author (Claude) controls what context you see — be skeptical
    of convenient omissions.

    Review directly from the artifacts (paths below) — read the files yourself:
    - Claims / methods / code: <path(s)>
    - Raw results: <path(s)>
    - Changed since last round: <changed-file paths> (read the raw diff)

    Please act as a senior ML reviewer (NeurIPS/ICML level).
    1. Score this work 1-10 for a top venue
    2. List remaining critical weaknesses (ranked by severity)
    3. For each weakness, specify the MINIMUM fix
    4. State clearly: is this READY for submission? Yes/No/Almost
    5. **Memory update**: List any new suspicions, unresolved concerns,
       or patterns you want to track in future rounds.

    Be brutally honest. Actively look for things the author might be hiding.
```

##### Nightmare — Paseo Codex full-access review

Use `mcp__paseo__create_agent` with the reviewer dispatch contract and
`full-access` mode. Continue the same reviewer with
`mcp__paseo__send_agent_prompt` in later rounds. Paseo MCP is required; a
missing reviewer is a failed review phase.

The reviewer reads code, result files, and logs itself and returns the same
structured score, verdict, verified claims, weaknesses, and memory update as
the medium and hard modes.

#### Phase B: Parse Assessment

**CRITICAL: Save the FULL raw response** from the external reviewer verbatim (store in a variable for Phase E). Do NOT discard or summarize — the raw text is the primary record.

Then extract structured fields:

- **Score** (numeric 1-10)
- **Verdict** ("ready" / "almost" / "not ready")
- **Action items** (ranked list of fixes)

**STOP CONDITION**: If score >= 6 AND verdict ∈ {"ready", "almost"} (exact match — "not ready" does NOT qualify) → stop loop, document final state.

#### Phase B.5: Reviewer Memory Update (hard + nightmare only)

**Skip entirely if `REVIEWER_DIFFICULTY = medium`.**

After parsing the assessment, update `REVIEWER_MEMORY.md` in the project root:

```markdown
# Reviewer Memory

## Round 1 — Score: X/10

- **Suspicion**: [what the reviewer flagged]
- **Unresolved**: [concerns not yet addressed]
- **Patterns**: [recurring issues the reviewer noticed]

## Round 2 — Score: X/10

- **Previous suspicions addressed?**: [yes/no for each, with reviewer's judgment]
- **New suspicions**: [...]
- **Unresolved**: [carried forward + new]
```

**Rules**:

- Append each round, never delete prior rounds (audit trail)
- If the reviewer's response includes a "Memory update" section, copy it verbatim
- This file is passed back to the reviewer in the next round's Phase A — it is the reviewer's persistent memory

#### Phase B.6: Debate Protocol (hard + nightmare only)

**Skip entirely if `REVIEWER_DIFFICULTY = medium`.**

After parsing the review, the executor gets a chance to **rebut**:

**Step 1 — Executor Rebuttal:**

For each weakness the reviewer identified, the executor writes a structured response:

```markdown
### Rebuttal to Weakness #1: [title]

- **Accept / Partially Accept / Reject**
- **Argument**: [why this criticism is invalid, already addressed, or based on a misunderstanding]
- **Evidence**: [point to specific code, results, or prior round fixes]
```

Rules for the executor's rebuttal:

- Must be honest — do NOT fabricate evidence or misrepresent results
- Can point out factual errors in the review (reviewer misread code, wrong metric, etc.)
- Can argue a weakness is out of scope or would require unreasonable effort
- Maximum 3 rebuttals per round (pick the most impactful to contest)

**Step 2 — Reviewer Rules on Rebuttal:**

Send the executor's rebuttal back to the reviewer for a ruling:

_Hard mode — continue the SAME reviewer (continuation, reviewer memory) for the rebuttal step per the Reviewer Calling Convention:_

_For codex:_ continue the paseo codex reviewer sub-agent via `mcp__paseo__send_agent_prompt` to its persisted agent-id (`threadId`) — the reviewer rules on the rebuttal against its OWN prior critique:

```

  threadId: [saved]
  config: {"model_reasoning_effort": "xhigh"}
  prompt: |
    The author rebuts your review:
```

_For manual:_ use `mcp__manual_review__review_reply` with the same `threadId` and prompt.

The prompt content:

```
    The author rebuts your review:

    [paste executor's rebuttal]

    For each rebuttal, rule:
    - SUSTAINED (author's argument is valid, withdraw this weakness)
    - OVERRULED (your original criticism stands, explain why)
    - PARTIALLY SUSTAINED (revise the weakness to a narrower scope)

    Then update your score if any weaknesses were withdrawn.
```

_Nightmare mode:_ continue the same Paseo Codex reviewer in `full-access`
mode via `mcp__paseo__send_agent_prompt`. The reviewer verifies the author's
evidence claims itself before ruling on each rebuttal.

**Step 3 — Update score and action items** based on the ruling:

- SUSTAINED weaknesses: remove from action items
- OVERRULED: keep as-is
- PARTIALLY SUSTAINED: revise scope

Append the full debate transcript to `$OUTPUT_DIR/AUTO_REVIEW.md` under the round's entry.

#### Human Checkpoint (if enabled)

**Skip this step entirely if `HUMAN_CHECKPOINT = false`.**

When `HUMAN_CHECKPOINT = true`, present the review results and wait for user input:

```
📋 Round N/MAX_ROUNDS review complete.

Score: X/10 — [verdict]
Top weaknesses:
1. [weakness 1]
2. [weakness 2]
3. [weakness 3]

Suggested fixes:
1. [fix 1]
2. [fix 2]
3. [fix 3]

Options:
- Reply "go" or "continue" → implement all suggested fixes
- Reply with custom instructions → implement your modifications instead
- Reply "skip 2" → skip fix #2, implement the rest
- Reply "stop" → end the loop, document current state
```

Wait for the user's response. Parse their input:

- **Approval** ("go", "continue", "ok", "proceed"): proceed to Phase C with all suggested fixes
- **Custom instructions** (any other text): treat as additional/replacement guidance for Phase C. Merge with reviewer suggestions where appropriate
- **Skip specific fixes** ("skip 1,3"): remove those fixes from the action list
- **Stop** ("stop", "enough", "done"): terminate the loop, jump to Termination

#### Feishu Notification (if configured)

After parsing the score, check if `~/.claude/feishu.json` exists and mode is not `"off"`:

- Send a `review_scored` notification: "Round N: X/10 — [verdict]" with top 3 weaknesses
- If **interactive** mode and verdict is "almost": send as checkpoint, wait for user reply on whether to continue or stop
- If config absent or mode off: skip entirely (no-op)

#### Phase C: Implement Fixes (if not stopping)

For each action item (highest priority first):

1. **Code changes**: Write/modify experiment scripts, model code, analysis scripts
2. **Run experiments**: Deploy to GPU server via SSH + screen/tmux
3. **Analysis**: Run evaluation, collect results, update figures/tables
4. **Documentation**: Update project notes and review document

> When `run-<project>-experiment` skill exists, use its op interface instead of manual SSH:
> 1. `sh .claude/skills/run-<project>-experiment/scripts/ops/sync-code.sh` — sync code
> 2. `sh .claude/skills/run-<project>-experiment/scripts/ops/build-env.sh` — build + verify
> 3. `sh .claude/skills/run-<project>-experiment/scripts/ops/launch-job.sh <exp_name> --args "..."` — launch
> If the generated experiment skill is missing, stop and request
> `/experiment-env-manager — mode: setup`.

Prioritization rules:

- Skip fixes requiring excessive compute (flag for manual follow-up)
- Skip fixes requiring external data/models not available
- Prefer reframing/analysis over new experiments when both address the concern
- Always implement metric additions (cheap, high impact)

#### Phase D: Wait for Results

If experiments were launched:

- Monitor remote sessions for completion
- Collect results from output files and logs

> When the `run-<project>-experiment` skill exists, poll via:
> `sh .claude/skills/run-<project>-experiment/scripts/ops/job-status.sh <exp_name>`
> Read `status` from the JSON output. Collect results via `ops/collect-outputs.sh`.
> If the launcher armed a monitoring heartbeat, the job's terminal tick
> already wrote the receipt — read `.aris/runs/<run_id>.experiment.<exp>.done.json`
> instead of polling.

- **Training quality signals** — read the experiment receipts and
  `.aris/runs/<run_id>.monitor.jsonl` (suspected NaN/divergence markers,
  early-stop reasons, `wandb` fields). You do NOT judge training quality
  here — suspected signals are flagged into the next review round as facts;
  the verdict belongs to `/analyze-results` and its cross-model verifier.

#### Phase E: Document Round

Append to `$OUTPUT_DIR/AUTO_REVIEW.md`:

```markdown
## Round N (timestamp)

### Assessment (Summary)

- Score: X/10
- Verdict: [ready/almost/not ready]
- Key criticisms: [bullet list]

### Reviewer Raw Response

<details>
<summary>Click to expand full reviewer response</summary>

[Paste the COMPLETE raw response from the external reviewer here — verbatim, unedited.
This is the authoritative record. Do NOT truncate or paraphrase.]

</details>

### Debate Transcript (hard + nightmare only)

<details>
<summary>Click to expand debate</summary>

**Executor Rebuttal:**
[paste rebuttal]

**Reviewer Ruling:**
[paste ruling — SUSTAINED / OVERRULED / PARTIALLY SUSTAINED for each]

**Score adjustment**: X/10 → Y/10

</details>

### Actions Taken

- [what was implemented/changed]

### Results

- [experiment outcomes, if any]

### Status

- [continuing to round N+1 / stopping]
- Difficulty: [medium/hard/nightmare]
```

**Write `$OUTPUT_DIR/REVIEW_STATE.json`** with current round, threadId, score, verdict, and any pending experiments.

**Append to `findings.md`** (when `COMPACT = true`): one-line entry per key finding this round:

```markdown
- [Round N] [positive/negative/unexpected]: [one-sentence finding] (metric: X.XX → Y.YY)
```

Increment round counter → back to Phase A.

### Termination

When loop ends (positive assessment or max rounds):

1. Update `$OUTPUT_DIR/REVIEW_STATE.json` with `"status": "completed"`
2. Write final summary to `$OUTPUT_DIR/AUTO_REVIEW.md`
3. Update project notes with conclusions
4. **Write method/pipeline description** to `$OUTPUT_DIR/AUTO_REVIEW.md` under a `## Method Description` section — a concise 1-2 paragraph description of the final method, its architecture, and data flow. This serves as input for `/paper-illustration` in Workflow 3.
5. **Publish the final metric in worker mode.** This step is mandatory before
   writing the outer receipt, even when no fix launched a new experiment:
   - Copy the latest result and tracker snapshots to
     `$OUTPUT_DIR/final-inputs/EXPERIMENT_RESULTS.md` and
     `$OUTPUT_DIR/final-inputs/EXPERIMENT_TRACKER.md`. If no review round changed
     them, copy the two corresponding manifest inputs.
   - Write `$WORKER_DIR/internal/final-analyze/input-manifest.json` for
     `/analyze-results`, using the same run id and iteration, the final-inputs
     paths, the outer manifest's `experiment_plan` and `experiment_skill`
     inputs, prior metric history, and output_dir `$OUTPUT_DIR/final-analysis`.
     Pass a final error report path too when one exists.
   - Read executor provider/mode/thinking from the run's
     `.paseo-config.json`, dispatch `/analyze-results — manifest: <path>`, wait,
     read its receipt, and archive it. Do not merge this nested receipt.
   - Preserve analyze-results' existing behavior when its verifier fails: it
     asks the user what to supplement or whether to accept. This parent waits;
     it must not auto-override that question.
   - Require a done receipt with matching run/iteration and finite
     `metric.current`. Copy metric current/delta/significance verbatim into the
     auto-review receipt. A failed or missing final analysis makes this worker
     fail. Reject an analysis that used project-root result files instead of the
     final-inputs paths in its manifest.

   The outer dashboard therefore receives two same-iteration metric writes:
   experiment-bridge's initial analyzed value, then auto-review-loop's final
   value. `dashboard-merge` replaces that iteration's history entry instead of
   appending another one, so resume cannot double-count it.
6. **Generate claims from results** — dispatch a paseo claude sub-agent for `/result-to-claim` per `shared-references/paseo-subagent-dispatch.md` to convert experiment results from `$OUTPUT_DIR/AUTO_REVIEW.md` into structured paper claims. Output: `CLAIMS_FROM_RESULTS.md`.

   **Worker mode: this step is MANDATORY, not optional.** `/auto-research-loop` relies
   on this dispatch as the ONLY path that writes the iteration's experiment node,
   supports/invalidates edges, idea outcome, failure-derived problems, and the rebuilt
   query pack into the research wiki. Skipping it silently starves the next iteration's
   idea discovery (no open problems, no failed-ideas banlist). If the `/result-to-claim`
   sub-agent errors or its output is missing, write the outer receipt with
   `"status": "failed"` and a structured error naming the failed dispatch — never a done
   receipt with the wiki write silently skipped.

   The dispatch prompt must hand over the data Step 5 of `/result-to-claim` needs, so it
   does not have to guess or scan the project root:
   - Results: `$OUTPUT_DIR/final-analysis/EXPERIMENT_RESULTS.md` and
     `$OUTPUT_DIR/final-inputs/EXPERIMENT_TRACKER.md` (the step-5 snapshots, not raw logs).
   - Active idea: `manifest.context.chosen_idea_id` — passed through verbatim; it is
     already a canonical node id (`idea:<slug>`), so tell the sub-agent NOT to prepend
     another `idea:` prefix.
   - Experiment identity: `exp_id = iter-<iteration>` — one experiment node per loop
     iteration (`exp:iter-<iteration>`), so a re-judged iteration overwrites its own node
     instead of accumulating duplicates.
   - Intended claims: the outer manifest's `experiment_plan` input path.

   The worker manifest is required for this dispatch. If `/result-to-claim`
   fails or its output is missing, the outer receipt is failed.
7. If stopped at max rounds without positive assessment:
   - List remaining blockers
   - Estimate effort needed for each
   - Suggest whether to continue manually or pivot
8. **Feishu notification** (if configured): Send `pipeline_done` with final score progression table
9. **Render HTML view** (if `RENDER_HTML = true`, default): dispatch a paseo claude sub-agent for `/render-html` per `shared-references/paseo-subagent-dispatch.md` on the cumulative review log:
   ```
   /render-html "$OUTPUT_DIR/AUTO_REVIEW.md" --no-review --state "$OUTPUT_DIR/REVIEW_STATE.json"
   ```
   Pass `--state` explicitly. HTML lands at `$OUTPUT_DIR/AUTO_REVIEW.html` with
   embedded source SHA256. If `/render-html` fails, fail the worker. Set
   `RENDER_HTML = false` before the run to omit this artifact.

## Key Rules

- **Large file handling**: A write failure is a worker failure. Do not switch
  to another writer inside this skill.

- ALWAYS use `config: {"model_reasoning_effort": "xhigh"}` for maximum reasoning depth
- Save the paseo codex reviewer agent-id (round 1) to `threadId`; continue the SAME agent via `send_agent_prompt` for subsequent rounds (or `mcp__manual_review__review_reply` for the manual backend) per the Reviewer Calling Convention
- **Anti-hallucination citations**: When adding references during fixes, NEVER fabricate BibTeX. Use the same DBLP → CrossRef → `[VERIFY]` chain as `/paper-write`: (1) `curl -s "https://dblp.org/search/publ/api?q=TITLE&format=json"` → get key → `curl -s "https://dblp.org/rec/{key}.bib"`, (2) if not found, `curl -sLH "Accept: application/x-bibtex" "https://doi.org/{doi}"`, (3) if both fail, mark with `% [VERIFY]`. Do NOT generate BibTeX from memory.
- Be honest — include negative results and failed experiments
- Do NOT hide weaknesses to game a positive score
- Implement fixes BEFORE re-reviewing (don't just promise to fix)
- **No automatic alternative paths** — apply the permitted fix once. If the concern remains,
  record the unresolved issue and stop the run; a new baseline, experiment, or argument needs
  an explicit new invocation.
- If an experiment takes > 30 minutes, launch it and continue with other fixes while waiting
- Document EVERYTHING — the review log should be self-contained
- Update project notes after each round, not just at the end

## Prompt Template for Round 2+

Use the selected backend. _For codex:_ continue the SAME paseo codex reviewer sub-agent via `mcp__paseo__send_agent_prompt` to the saved `threadId` (paseo codex agent-id) per `paseo-reviewer-dispatch.md`; the reviewer checks resolution against its OWN prior critique. _For manual:_ `mcp__manual_review__review_reply` with the saved threadId.

```
[For codex:] mcp__paseo__send_agent_prompt:
  threadId: [saved from round 1]
  config: {"model_reasoning_effort": "xhigh"}
  prompt: |
    [Round N update]

    Since your last review these files changed — read them yourself; do not
    take my word for what changed or whether it worked:
    - Changed files: <paths>
    - Raw diff: <path, or the `git diff` range>
    - Updated raw results: <result-file paths> (verbatim files, not a pasted table)

    Please re-score and re-assess. Are the remaining concerns addressed?
    Same format: Score, Verdict, Remaining Weaknesses, Minimum Fixes.
```

## Review Tracing

After each reviewer call (`mcp__paseo__create_agent` fresh /
`mcp__paseo__send_agent_prompt` continuation or the explicitly selected
manual reviewer), save the trace using the required `save_trace.sh` helper
from `shared-references/review-tracing.md`. If the helper is missing or fails,
fail the worker; do not write a second trace format inline.
