# Deploy a real benchmark facility

Copy `lm-eval-adapter.py` and `lm-eval-profile.json` into the selected evaluation cwd. Fill the exact harness and dataset commit SHAs, model backend/settings and pinned smoke-model path. This single-task example deploys [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) with a local HellaSwag snapshot, original prompt/scoring and retained native sample logs. Validate task inheritance and the dataset size against the pinned revisions during setup; other tasks need their own task profile and metric mapping.

Configure `TESTER_FACILITY_CONFIG_TEMPLATE.json` with that cwd, benchmark/data revisions and the same expected sample count. Set command argv to:

| Facility command | argv |
| --- | --- |
| setup | `["python", "lm-eval-adapter.py", "setup"]` |
| healthcheck | `["python", "lm-eval-adapter.py", "check"]` |
| smoke | `["python", "lm-eval-adapter.py", "run"]` |
| test | `["python", "lm-eval-adapter.py", "run"]` |

Pin `lm-eval-adapter.py`, `lm-eval-profile.json`, `tasks/task.yaml`, `data-manifest.json`, `requirements-installed.txt` and `harness/lm_eval/evaluator.py` in `evidence_files`. Setup creates the environment, installs the pinned framework, downloads the pinned dataset and checks smoke inference. Execution works locally or through the same SSH command interface; the adapter enforces its timeout on the evaluation host. Model service deployment can be another setup command when the chosen backend needs it.

Full tests receive the artifact path from `ARIS_ARTIFACT_REF`, run without `--limit`, and retain native aggregate/sample evidence for audit. Choose a model artifact with a verifiable revision/manifest digest; the reviewer checks the deployment actually used that artifact. Credentials come from inherited environment or the remote service, not `execution.env` or profile files. Dependency versions are recorded after installation; use a project lockfile when recreating an identical environment on another host.

The adapter converter has fixture coverage; downloading this benchmark and running a real model requires the project's selected revisions, model and compute resources. It is an example deployment, not a preinstalled benchmark or a passing evaluation.
