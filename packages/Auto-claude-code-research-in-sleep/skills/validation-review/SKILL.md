---
name: validation-review
description: 'Review one ARIS validation submission end to end: read USAGE.md, write the adapter, run the frozen benchmark, check for cheating, write the verdict and desensitized feedback, finalize. The validation service starts one agent per submission with this skill.'
allowed-tools: Read, Write, Edit, Bash(*)
---

# Validation Review

You review one submission on the validation machine. The prompt names the submission id and its directory; the project root is your working directory. The helper is `node .aris/dist/tools/validation-cli.js` (see [integration-contract.md](../shared-references/integration-contract.md)).

The worker never sees anything you write except what `finalize` publishes: the verdict, the score measured by the frozen benchmark, and `feedback.md` after the leak check.

## Rules

- Do not edit `.aris/tester-config.json`, `.aris/validation/`, the files the benchmark pins, or the hidden data. A changed benchmark stops the service.
- Treat `unpacked/` as the worker's product. Never fix its bugs, retrain it or tune it. If it does not run as `USAGE.md` says, that is the verdict.
- Do not contact the worker or anyone else about the submission.
- The score comes from the benchmark result, not from you. Your judgement is the verdict.

## 1. Read

```bash
node .aris/dist/tools/validation-cli.js status --project . --submission <id>
```

Then read `task.md`, the submission's `unpacked/USAGE.md`, `adapter_contract` in `.aris/validation/config.json` and the runner named by `.aris/tester-config.json`.

## 2. Inspect before running

Read the deliverable's code, scripts and configs before you execute any of them. Look for:

- reads of benchmark data, labels or reference outputs, by path, by download, or by searching the disk;
- answers built in: lookup tables or files that match benchmark inputs, outputs keyed on sample ids;
- behaviour that changes under evaluation: checks on `ARIS_*` variables, host names, the adapter directory, timing;
- writes outside its own output: to `ARIS_TEST_OUTPUT`, the runner, the benchmark files, or other submissions;
- install steps that do more than install (downloading unexplained payloads, editing system files).

Write what you find to `inspection.md` in the submission directory as you go.

## 3. Install and adapt

Install what `USAGE.md` asks for inside the submission directory (for example a venv in `<dir>/env`), not globally. Write the adapter in `<dir>/adapter` exactly as `adapter_contract` describes. The adapter only calls the deliverable the documented way.

Iterate on the adapter with the smoke subset:

```bash
node .aris/dist/tools/validation-cli.js smoke --project . --submission <id>
```

Each run gets a new directory under `<dir>/smoke/`. A smoke failure caused by the adapter is yours to fix; one caused by the deliverable is a finding.

## 4. Evaluate

```bash
node .aris/dist/tools/validation-cli.js evaluate --project . --submission <id>
```

Long runs go in the background; poll the log in the new `<dir>/evaluation/<n>/` directory. `finalize` scores the latest evaluation, which must cover every sample with no failures. If the deliverable cannot complete a full run, the verdict is `unusable`.

Then read the predictions and per-sample output. Compare with what you saw in step 2: predictions identical to the labels, scores that depend on sample ids, smoke and full behaviour that disagree, or outputs the documented method could not produce.

## 5. Verdict

Write `<dir>/review.json`:

```json
{ "verdict": "valid", "reasons": ["Ran as documented; no access to benchmark data found."] }
```

| Verdict | When |
| --- | --- |
| `valid` | It ran as documented and earned its score honestly. A low score is still valid. |
| `cheating` | The score does not measure what `task.md` asks for: benchmark data reached it, answers are built in, it behaves differently under evaluation, or it tampered with the harness. The score is voided. |
| `unusable` | It cannot be run from `USAGE.md` with reasonable effort, or no complete evaluation was possible. |

`reasons` stay on this machine. Be specific; the owner reads them.

## 6. Feedback

Write `<dir>/feedback.md` for the worker. Say what kind of problem you saw and how often, with examples you invent to show the pattern. Never include:

- benchmark inputs, labels, reference outputs, sample ids or per-sample scores;
- hidden file names or paths;
- text copied from the hidden data, even reformatted.

An invented example shows the shape of the problem ("a question asking for a date got a full sentence instead of `2021-03-04`"), not a real case.

## 7. Finalize

```bash
node .aris/dist/tools/validation-cli.js finalize --project . --submission <id>
```

- `FEEDBACK_LEAKS_HIDDEN_DATA`: rewrite `feedback.md` without the matched passages and run finalize again. After the configured number of rewrites the result is published with no feedback.
- `EVALUATION_REQUIRED`, `TESTER_COVERAGE_INCOMPLETE` and similar: a `valid` verdict needs a clean full evaluation. Rerun `evaluate` if the failure was on our side; otherwise the verdict is `unusable`.
- `BENCHMARK_CHANGED`: stop and tell the owner.

Report the verdict and score in your final message and stop.
