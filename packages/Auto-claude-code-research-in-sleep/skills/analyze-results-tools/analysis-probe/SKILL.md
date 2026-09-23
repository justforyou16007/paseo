---
name: analysis-probe
description: 'Deep experiment analysis that goes beyond the run own logs: recomputes statistics from saved artifacts, patches a copy of the experiment code with instrumentation and runs short probe jobs, replays a window from a checkpoint, or runs a minimal controlled variant. Every probe is hypothesis-first and falsifiable, deduplicated against a run-scoped evidence ledger, and carries no metric authority. Use when the log-reading analysis sub-skills leave a mechanistic question the existing data cannot answer.'
argument-hint: "[— manifest: <path>] [— open-questions: <path>] [— exp: <name>]"
allowed-tools: Bash(*), Read, Grep, Glob, Write, Edit, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

# Analysis Sub-Skill: Probe

One focused job: **get the evidence the run never recorded.**

The other four sub-skills read what training happened to log. This one asks the
experiment for something new — a statistic recomputed from a checkpoint, a
tensor dumped by an inserted hook, a replayed window, a controlled variant.

Dispatched exclusively by `/analyze-results` as a paseo sub-agent. You produce
evidence and an artifact; the accepting verdict is the hub's cross-model
verifier, never this skill.

## Inputs

Read from the input manifest (worker mode) or arguments (direct):

- `open_questions` — the `open_questions[]` entries collected by the hub from
  `analysis-convergence`, `analysis-training-dynamics`, and
  `analysis-comparison`. This is your work queue.
- `results` / `tracker` — the run's result manifest. You read these to compute
  the evidence key; you never restate their numbers as your own findings.
- `experiment_skill` — path to the generated experiment skill's `env.json`.
  Its parent gives you `scripts/ops/`, the only way you launch anything.
- `code_root` — the experiment source tree (`preparation.files.location`).
- `artifacts_dir` — checkpoints and saved intermediates, when the run wrote any.
- `run_id`, `iteration` — for the ledger and probe job names.

## Step 1: Compute the evidence key, read the ledger

The ledger is `.aris/runs/<run_id>.probes.json`. It is run-scoped on purpose:
the same experiment is analyzed more than once per iteration (experiment-bridge
Phase 5.6, then auto-review-loop's termination analysis, plus once more per
bridge-repair round), and without a shared ledger each of those would re-derive
the same mechanism at full GPU cost.

```
evidence_key = sha256 over the sorted (path, sha256(content)) pairs of
               manifest.inputs.results + manifest.inputs.tracker
```

Machine-checkable by construction — a shell script computes the same value.

Create the ledger with `{"run_id": "...", "entries": []}` when absent.

## Step 2: Turn open questions into probe records

For each open question, write a probe record **before** deciding to run it:

```json
{
  "id": "P1",
  "question": "<the open question, verbatim from the source sub-skill>",
  "hypothesis": "<one falsifiable statement about the mechanism>",
  "observable": "<the concrete quantity to measure>",
  "mode": "offline|instrument|replay|controlled",
  "discriminating_outcome": {
    "supports": "<what measurement would support the hypothesis>",
    "refutes":  "<what measurement would refute it>"
  }
}
```

`hypothesis_id = sha256(normalized(question, observable, mode))`.

**A probe whose `discriminating_outcome` cannot be filled in is not run.**
Record it as `status: "dropped"`, `drop_reason: "not falsifiable"`. This is the
only thing that bounds the probe set — there is no GPU budget cap, so
falsifiability is what keeps this from becoming open-ended digging.

## Step 3: Ledger gate

Look up each probe before executing it:

| Lookup | Action | Cost |
|---|---|---|
| `(evidence_key, hypothesis_id)` present | Reuse the recorded evidence; `status: "reused"` | none |
| `evidence_key` present, `hypothesis_id` new | Do not run it; `status: "dropped"`, `drop_reason: "evidence already probed"` | none |
| `evidence_key` absent from the ledger | Execute; append a record per probe | the probe's real cost |

Row two is the rule that matters: **a new hypothesis may only be opened when
the evidence itself is new.** Unchanged evidence means some earlier analysis
already probed this exact result set, and re-probing it buys nothing.

Within a single invocation this costs you nothing — your P1…Pn have distinct
`hypothesis_id`s, and the hub's Phase 4 may open more. The gate only bites when
a *second* invocation faces the *same* evidence.

When a probe is reused or dropped under row two, the artifact says which worker
and round originated it and what that probe concluded. A reader must never see
silence where a question was answered elsewhere.

## Step 4: Execute

### `offline` — recompute from what is already on disk

Load checkpoints, prediction dumps, or saved intermediates from
`artifacts_dir` and compute the observable: per-sample loss distribution,
per-layer error, representation similarity, calibration, whatever the
hypothesis names. No job launch, no patch.

### `instrument` — patch a copy, run a short job

1. Copy the relevant source out of `code_root` into
   `$OUTPUT_DIR/probe/<id>/src/`. **Never edit `code_root` in place** — a run's
   own code path is not yours to modify.
2. Insert the instrumentation: forward/backward hooks, attention/gradient/
   activation dumps, per-sample logging. Follow `/system-profile`'s
   instrumentation discipline (`skills/system-profile/SKILL.md`) — sample
   rather than instrument tight inner loops, keep every change revertible.
3. Emit the diff to `$OUTPUT_DIR/probe/<id>.patch`. The patch file is the
   artifact the verifier audits; a probe with no recorded patch is not
   admissible evidence.
4. Launch through the ops contract, shortened to what the observable needs
   (few steps, one seed, a data subset):
   ```bash
   sh "$OPS/sync-code.sh"
   sh "$OPS/launch-job.sh" "probe-<run_id>-<id>" --args "<probe args>"
   sh "$OPS/job-status.sh" "probe-<run_id>-<id>"
   sh "$OPS/collect-outputs.sh" "probe-<run_id>-<id>"
   ```
   Op failures route through the generated skill's unified failure contract,
   same as every other caller. Do not hand-write per-op error handling.
5. For anything long enough to outlive the turn, arm a monitoring heartbeat
   exactly as `/run-experiment` Step 5.5 does, and end the turn. Never busy-poll.

### `replay` — resume a checkpoint with instrumentation

Same as `instrument`, but the probe job resumes from a checkpoint and replays
one window (the few hundred steps where the loss exploded, the epoch where the
train/eval gap opened). Use this when the behavior is localized in time and
re-running from scratch would waste the checkpoint you already have.

### `controlled` — a minimal controlled variant

Change exactly one thing the hypothesis names — ablate a module, swap one
hyperparameter — and run the shortened job. This is what separates a causal
claim from a correlation seen in a curve. Everything else is held fixed; state
in the artifact what was held fixed and how you verified it.

## Step 5: Write the artifact and append to the ledger

`$OUTPUT_DIR/analysis-probe.md`, one section per probe:

> Hypothesis → Observable → What was measured (numbers, with the evidence file
> path) → Supports / Refutes / Inconclusive, against the
> `discriminating_outcome` you committed to in Step 2.

Label every probe result with the evaluation type from
`shared-references/experiment-integrity.md` (`real_gt`, `synthetic_proxy`,
`self_supervised_proxy`, `simulation_only`, `human_eval`). An instrumented
probe measuring an internal quantity is not a performance measurement and must
not read like one.

Then append each executed probe to the ledger, keyed by
`(evidence_key, hypothesis_id)`, carrying `originated_by` (`<worker>@<iteration>`),
`round`, `status`, and the evidence path.

## Output contract

```json
{
  "skill": "analysis-probe",
  "metric_authority": "none",
  "evidence_key": "<sha256>",
  "ledger": ".aris/runs/<run_id>.probes.json",
  "probes": [
    {
      "id": "P1",
      "mode": "instrument",
      "status": "supports|refutes|inconclusive|reused|dropped",
      "drop_reason": null,
      "observable": "...",
      "evidence": "<OUTPUT_DIR>/probe/P1/...",
      "originated_by": "<worker>@<iteration>"
    }
  ],
  "patches": ["<OUTPUT_DIR>/probe/P1.patch"],
  "probe_runs": ["probe-<run_id>-P1"],
  "artifact": "<OUTPUT_DIR>/analysis-probe.md"
}
```

`metric_authority: "none"` is a constant, not a computed field. Nothing this
skill produces may become `dashboard_patch.metric.current` — the run's headline
metric stays sourced from the original `result_files`, always.

## Rules

- **No metric authority.** You measure mechanism, not performance. A probe
  number never replaces, adjusts, or reinterprets the run's primary metric.
- **Never patch `code_root` in place.** Patches apply to a copy under
  `$OUTPUT_DIR/probe/<id>/src/` and are archived as `.patch` files.
- **Never reuse a production experiment name.** Probe jobs are
  `probe-<run_id>-<id>`, so no probe output can be mistaken for a run result.
- **A patch that touches metric computation, evaluation data, or the loss that
  gets reported is forbidden** (`shared-references/experiment-integrity.md`).
  Instrumentation observes; it does not change what is being measured. The
  hub's verifier reads your patches and fails the analysis if one does.
- **Falsifiability before execution.** No `discriminating_outcome`, no probe.
- **The ledger gate is not advisory.** Never execute a probe the gate dropped,
  and never skip writing a ledger record for one you did execute — the next
  analyzer's zero-cost reuse depends on it.
- Report file paths, not inline numbers, in the final reply.
