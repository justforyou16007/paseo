# Tester facility contract

`/aris-setup` dispatches `/tester-setup`. For every completed experiment or assembled workflow requiring publication, dispatch `/tester-test`, then `/tester-audit`, then `/result-to-claim`. Each phase uses its own Paseo worker and receipt; persistent external execution uses the existing heartbeat/watchdog pattern.

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

## Wiki handoff

```bash
node "$WIKI_SCRIPT" add_experiment "$WIKI_ROOT" --slug "$EXPERIMENT_ID" \
  --run-id "$RUN_ID" --iteration "$ITERATION" \
  --test-result "$RESULT" --test-audit "$AUDIT" \
  --verdict no --confidence high --reasoning "Observed regression"
```

Metrics are copied from the audited result. Do not type replacement numeric results into --metrics. Missing/failed/stale audits, wrong run/iteration/experiment, smoke tests, incomplete samples and changed evidence block writes, including low-level event append paths. Historical Wiki events stay readable; legacy tester results are not automatically certified for new export ranking.

For legacy promotion workflows an adapter may also emit `promotion: {conclusion, feedback}` in the raw output, using `tester-promotion-result.ts`'s binding schema. Promotion reads it through the same result/audit pair; setup and evaluation still use the three tester skills. The adapter derives these fields from the workflow's actual tester review/gate, never from a self-declared PASS.
