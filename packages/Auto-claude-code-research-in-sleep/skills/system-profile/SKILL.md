---
name: system-profile
description: 'Profile a target (script, process, GPU, memory, interconnect) for performance analysis. Use when user says "profile", "benchmark", "bottleneck", or wants performance analysis.'
argument-hint: <target, e.g. "train.py", "gpu", "pid 1234", "vllm serving">
---

# System Profile

Profile `$ARGUMENTS` using probes appropriate to the target. Ask for a target only when it cannot be inferred from the request or project.

Keep commands, workload, hardware, sampling conditions and raw traces/logs in `profile_output/`. Base bottleneck claims on measured evidence and rank proposed improvements by expected impact. Include CPU, memory, GPU and communication measurements when relevant; tool selection and implementation are left to the agent.

Instrumentation must be reversible. Prefer wrappers; mark necessary inline changes with `[PROFILE]` and account for measurement overhead. Deliver a changelog listing every created/modified file, changed lines and how to revert the instrumentation.

Report the measured results, bottlenecks, limitations and recommended next experiments alongside the artifact paths.
