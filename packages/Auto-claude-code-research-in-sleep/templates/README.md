# Templates

`/aris-setup` reads these; you do not copy them by hand.

| Template | Used by |
| --- | --- |
| [TASK_TEMPLATE.md](TASK_TEMPLATE.md) | Both roles. Becomes `task.md`, the only statement of the task. |
| [ROLE_WORKER.md](ROLE_WORKER.md), [ROLE_VALIDATION.md](ROLE_VALIDATION.md) | Setup writes the matching one between the `ARIS ROLE` markers in `CLAUDE.md`. |
| [TESTER_FACILITY_CONFIG_TEMPLATE.json](TESTER_FACILITY_CONFIG_TEMPLATE.json) | Validation role. Starting point for the frozen benchmark. |
| [tester-benchmark/](tester-benchmark/) | Validation role. A worked lm-evaluation-harness deployment. |

The benchmark runner receives `ARIS_TEST_MODE` (`smoke` or `full`), `ARIS_ARTIFACT_REF`, `ARIS_ARTIFACT_SHA256`, `ARIS_ADAPTER_DIR`, `ARIS_TEST_DIR` and `ARIS_TEST_OUTPUT`, and writes the output JSON to `ARIS_TEST_OUTPUT`. Use `python` rather than `python3` in argv so the same config runs on Windows.
