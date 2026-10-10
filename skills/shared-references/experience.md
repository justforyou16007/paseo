# Cross-project experience

The worker maintains `Experience.md` at the root of the owner's local ARL source checkout on branch `arl`. This is shared guidance across projects; it does not change `task.md` or replace project records in `research-wiki/`. The validation agent never writes this file.

## Location and reuse

During worker setup, resolve the local ARL source checkout from the owner's project instructions or an available source checkout. Record its absolute path and the `Experience.md` location in the worker's `CLAUDE.md` (Claude) or `AGENTS.md` (Codex), outside the setup-owned `ARIS ROLE` block. An installed `.aris/` directory is not the source checkout. Keep the source repository's `CLAUDE.md` linked to its root `Experience.md`.

Before starting a task, read the relevant saved experience. Before writing, verify that the destination is the ARL source repository and that `git -C <checkout> branch --show-current` reports `arl`. Use an existing `arl` worktree when available; do not switch a working project's branch or overwrite unrelated edits. If the location is missing, ambiguous or unwritable, report that experience saving is pending and what is needed; never claim it was saved or silently write into another project or branch.

## After each completed worker → validation cycle

A cycle ends when `query` for the submission returns a published verdict (`valid`, `cheating` or `unusable`), including its score and available feedback. Upload acceptance, queued/reviewing status and infrastructure failures are not completed cycles. Save experience before the next iteration or final response, including when the service reaches `completed` or `closed`.

1. Use only the worker's own work and the verdict, measured score and leak-checked feedback published by `query`. Do not access validation files, reconstruct hidden samples, or treat a local score or an untested fix as validated evidence. A cheating result supports a lesson about the rejected practice, not a claim of improvement.
2. Keep only an observed lesson that still gives a useful action after removing project names, datasets, paths, submission ids and exact scores. State its scope; one result does not prove a method always improves performance. Exclude secrets, hidden benchmark details, logs, project summaries and unsupported speculation.
3. Read the existing file, merge duplicates and shorten outdated wording. Add at most three bullets per cycle, each one or two short sentences stating **when it applies → what to do (or avoid)**. Keep only distinct useful lessons; if none qualifies, leave the file unchanged.
4. Report the saved path and briefly identify the new or merged lesson, or state that no new reusable experience qualified. Keep submission details and results in the project wiki. Saving is local; it does not require committing, pushing or contacting validation.
