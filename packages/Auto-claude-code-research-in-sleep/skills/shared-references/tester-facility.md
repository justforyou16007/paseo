# Tester facility contract

Unified `/aris-setup` reviews research, environment and tester configuration together, accepts grouped edits, refreshes the full sheet and obtains one final confirmation before executing `tester-facility-cli.js setup`. `/research-setup` and `/tester-setup` are compatibility names for that same procedure. For every completed experiment or assembled workflow requiring publication, dispatch `/tester-test`, then `/tester-audit`, then `/result-to-claim`. Each phase uses its own Paseo worker and receipt; persistent external execution uses the existing heartbeat/watchdog pattern.

The configuration, setup receipt, jobs and results live under the owning project's `.aris/`. The runtime has no special tester user, container, private path, signed receipt, search blocklist or exposure budget. Root/child knowledge scopes and run ownership still follow normal ARIS contracts.

## Runner interface

Setup declares local or SSH cwd, environment, setup argv commands, healthcheck, smoke and full-test commands. Use `templates/TESTER_FACILITY_CONFIG_TEMPLATE.json` as the shape. The same interface can wrap an installed benchmark CLI, model service, Docker command or custom evaluator.

The runtime supplies `ARIS_RUN_ID`, `ARIS_ITERATION`, `ARIS_EXPERIMENT_ID`, `ARIS_PROJECT_ID`, `ARIS_TEST_MODE`, `ARIS_TEST_ID`, `ARIS_TEST_DIR`, `ARIS_TEST_OUTPUT`, `ARIS_ARTIFACT_REF` and `ARIS_ARTIFACT_SHA256`. Create raw predictions and native benchmark results in `ARIS_TEST_DIR`. Write this JSON to `ARIS_TEST_OUTPUT` only after evaluation is complete:

```json
{
  "artifact_sha256": "<digest of the tested artifact>",
  "metrics": {"accuracy": 0.5},
  "samples": [
    {"id": "case-1", "status": "ok", "metrics": {"accuracy": 1}},
    {"id": "case-2", "status": "ok", "metrics": {"accuracy": 0}}
  ],
  "evidence_files": ["predictions.jsonl", "native-results.json", "evaluation-config.json"]
}
```

Use stable unique sample/repeat ids; retain failed samples explicitly. For mean/sum metrics every sample carries a finite score and the audit recomputes the aggregate. For external aggregators retain native score evidence and scoring source for independent review. Pin the dataset and exact evaluation subset; expected_samples is the full protocol count, never the smoke count. Include repeated evaluation observations in the declared count.

The helper captures stdout/stderr and hashes runner/data setup evidence and raw output evidence. Result edits or evidence changes invalidate the audit. Retry scripts may reuse checkpoints but must remove/rewrite the final output and expose the same frozen request. SSH tasks must enforce remote timeouts and stop/cancel their remote job before retrying after transport loss.

## Tested candidate and stop metric

Before testing, materialize the implementation and deployment files under
`.aris/runs/<run_id>/outputs/candidates/<revision>/`. Retain each revision.
Experiment-bridge writes `outputs/TEST_REQUEST.json`, returns its path as
`summary.test_request_path`, and tester-test receives it as `inputs.test_request`.

```json
{
  "schema_version": 1,
  "test_id": "root-run-iter-1-v1",
  "run_id": "root-run",
  "iteration": 1,
  "experiment_id": "iter-1-v1",
  "artifact": {"ref": "<absolute model/code path or versioned model URI>", "sha256": "<artifact digest>"},
  "deliverables": {
    "output_hashes": {
      "outputs/candidates/v1/model.py": "<file digest>",
      "outputs/candidates/v1/deploy.json": "<file digest>"
    },
    "execution_plan_ref": "outputs/candidates/v1/deploy.json"
  },
  "mode": "full"
}
```

Paths in `output_hashes` are relative to the owning run and must name actual
files. Include the tested local artifact itself. For a remote/versioned model,
deliver the implementation and deployment files identifying its ref and digest.
Include `interface_record_ref` when a downstream module needs it; both optional
refs must name hashed files. The manifest is part of the audited request.
Changed files require a new candidate revision and test id. Test ids are
project-wide keys under `.aris/tester/tests/`; include the owning run id so
root and child assessments cannot collide.

The root target names a declared facility metric with the same direction. A
child uses its parent's frozen local acceptance name, direction and threshold,
with zero tolerance. It inherits facilities and loop limits. Result-package
metrics use `primary.<name>`; parent acceptance resolves a benchmark name there,
with the historical raw key as a fallback.

Read the stopping measurement deterministically after audit:

```bash
node "$TESTER" measure --project "$ROOT" --run "$RUN_ID" \
  --iteration "$ITERATION" --metric "$TARGET_METRIC" \
  --result "$TEST_RESULT" --audit "$TEST_AUDIT"
```

Copy `metric_value` to the review receipt's `metric.current`; analysis/probe
readings cannot replace it. Supply `metric_name` as `--gate-metric-name` together
with `--gate-metric` on Wiki writes. The helper checks files, run and iteration.

## Stage state and recovery

| Entry | Stage helper | Durable state |
|---|---|---|
| Root/child Workflow | `workflow-cli tester-phase`, initially `--from workset` | `workflow-runtime.json` |
| Explicit depth-0 standalone | `tester-facility-cli stage`, initially `--from experiment-bridge` | `dashboard.json` |

Run test → audit → auto-review-loop through the helper for the selected entry.
Workflow collects the worker receipts as cycle evidence and advances through
its stage helper; it does not create or merge a standalone dashboard. For
standalone, merge bridge success before the first stage; no Workflow
ownership is created. The helper pins facility/target and assessment hashes.
Unchanged transition replay validates evidence and leaves state intact. Do not
manually set the next phase before calling the stage helper.

Use directories `<iteration>-tester-test-<test_id>` and
`<iteration>-tester-audit-<test_id>`. Reassessment uses a new directory and
receipt; replay uses the original immutable receipt. Changed review outputs
also use a new review attempt directory. In nested auto-review reassessment,
collect tester receipts without dashboard-merge, like nested analyze-results;
the owning orchestrator records the final assessment before completing review.

## Wiki and result handoff

```bash
node "$WIKI_SCRIPT" add_experiment "$WIKI_ROOT" --slug "$EXPERIMENT_ID" \
  --project "$ROOT" --run-id "$RUN_ID" --iteration "$ITERATION" \
  --test-result "$RESULT" --test-audit "$AUDIT" \
  --verdict no --confidence high --reasoning "Observed regression"
```

Metrics are copied from the audited result. Do not type replacement numeric results into --metrics. Missing/failed/stale audits, wrong run/iteration/experiment, smoke tests, incomplete samples and changed evidence block writes, including low-level event append paths. Historical Wiki events stay readable; legacy tester results are not automatically certified for new export ranking.

Use `result.request.experiment_id` as the slug. An already judged experiment is
reusable only with identical result/audit digests and binding. Changed evidence,
including an equal score for a different model, requires a new experiment
revision and corresponding test request. Retain old claims and evidence. Export
selects the final recorded assessment for each iteration, then ranks iterations
and publishes the winner's checked output files and refs.

For legacy promotion workflows an adapter may also emit `promotion: {conclusion, feedback}` in the raw output, using `tester-promotion-result.ts`'s binding schema. Promotion reads it through the same result/audit pair; setup and evaluation still use the three tester skills. The adapter derives these fields from the workflow's actual tester review/gate, never from a self-declared PASS.
