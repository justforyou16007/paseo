# Output Versioning

Each phase writes to its declared stage directory. Readers use that path and
do not search other locations.

## Current paths

| Artifact | Current path |
| --- | --- |
| Idea report | `idea-stage/IDEA_REPORT.md` |
| Idea candidates | `idea-stage/IDEA_CANDIDATES.md` |
| Review report | `review-stage/AUTO_REVIEW.md` |
| Review state | `review-stage/REVIEW_STATE.json` |
| Run state | `.aris/runs/<run_id>/state.json` |
| Worker receipt | `$WORKER_DIR/receipt.json` |

## Missing artifacts

Skills read only the declared stage path. If the artifact is missing, stop and
report the exact path and producing skill. An operator must choose `fresh` or
`retry` explicitly after cleaning the stage.

## State handling

`resume`, `retry`, and `fresh` are explicit user choices. A stale or
missing state file is an error for a requested resume; it is not a reason to
silently delete state or start from scratch.

Do not delete timestamped history, append-only logs, or applied receipts.
They describe completed work and are not input to a new phase.
