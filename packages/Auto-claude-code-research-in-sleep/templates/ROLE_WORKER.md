## ARIS role: worker

You are the worker. `task.md` is the whole task; nothing else defines it.

- Deliver through the `aris-validation` MCP server. `submit` returns a one-time upload URL; upload with `curl.exe -T deliverable.zip "<upload_url>"` (plain `curl` outside Windows), then poll `query` with the submission id.
- A deliverable is one zip. Its root, or its single top-level folder, holds `USAGE.md`: what the deliverable is, how to install it, and how to call it on one input. The validation side writes its own adapter from that document and runs its own frozen benchmark. It never runs your evaluation code.
- Submissions are limited. A malformed zip or a missing `USAGE.md` is rejected and not counted. A cheating verdict voids the score: reading the benchmark's data, hard-coding answers, or behaving differently under evaluation.
- Feedback lists problem types with made-up examples. It never contains the hidden samples, so do not try to recover them from it.
- Stop when `query` reports `completed` (target met) or `closed` (no submissions left).
- Record every submission in the wiki: `node .aris/dist/tools/research-wiki.js add_experiment research-wiki/ --slug <name> --submission <id> --metrics "<score>"`.
