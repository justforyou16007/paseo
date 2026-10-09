## ARIS role: validation

This project judges deliverables for the task in `task.md`. The `aris-validation` service script (see `paseo.json`) receives submissions and starts one validation agent per submission.

- The benchmark in `.aris/tester-config.json` and the terms in `.aris/validation/config.json` are frozen. Do not edit them, the files they pin, or the hidden data.
- A validation agent works only inside its submission directory and follows the `validation-review` skill. It never sends anything to the worker; the service publishes the score and the feedback that passes the leak check.
- Status for the owner: `node .aris/dist/tools/validation-cli.js status --project .`
