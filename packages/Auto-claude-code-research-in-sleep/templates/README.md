# Templates

`/aris-setup` reads these; you do not copy them by hand.

| Template | Used by |
| --- | --- |
| [TASK_TEMPLATE.md](TASK_TEMPLATE.md) | Both roles. Becomes `task.md`, the only statement of the task. |
| [ROLE_WORKER.md](ROLE_WORKER.md), [ROLE_VALIDATION.md](ROLE_VALIDATION.md) | Setup writes the matching one between the `ARIS ROLE` markers in `CLAUDE.md`. |
| [TESTER_FACILITY_CONFIG_TEMPLATE.json](TESTER_FACILITY_CONFIG_TEMPLATE.json) | Validation role. Starting point for the frozen benchmark. |
| [tester-benchmark/](tester-benchmark/) | Validation role. A worked lm-evaluation-harness deployment. |

## Benchmark runner protocol

The frozen benchmark's `setup`, `healthcheck`, `smoke` and `test` entries are argv arrays with timeouts. Use `python` rather than `python3` so the same config runs on Windows. Runners receive:

| Variable | Value |
| --- | --- |
| `ARIS_TEST_MODE` | `smoke` or `full` |
| `ARIS_TEST_ID`, `ARIS_PROJECT_ID` | Identity of this run |
| `ARIS_ARTIFACT_REF`, `ARIS_ARTIFACT_SHA256` | The unpacked deliverable and its digest |
| `ARIS_ADAPTER_DIR` | The validation agent's adapter for this deliverable |
| `ARIS_TEST_DIR` | Where to write predictions and native benchmark output |
| `ARIS_TEST_OUTPUT` | Where to write the result JSON, only after evaluation finishes |

```json
{
  "artifact_sha256": "<ARIS_ARTIFACT_SHA256>",
  "metrics": {"accuracy": 0.5},
  "samples": [
    {"id": "case-1", "status": "ok", "metrics": {"accuracy": 1}},
    {"id": "case-2", "status": "ok", "metrics": {"accuracy": 0}}
  ],
  "evidence_files": ["predictions.jsonl", "native-results.json"]
}
```

- Sample ids are stable and unique; repeats get their own ids. A sample the deliverable failed on stays in the list with `status: "failed"`; the helper rejects runs that drop or fail samples, so a crash on one input must still produce a scored (zero) entry.
- `dataset.expected_samples` is the full protocol count including repeats, never the smoke count.
- For `mean`/`sum` metrics every sample carries a finite score and the helper recomputes the aggregate. For `external` aggregation keep the native score file in `evidence_files`.
- Files listed in the config's `evidence_files` are hashed at setup. Changing one stops the validation service until setup runs again.
