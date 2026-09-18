# Bridge Expansion Handoff

Use this handoff for the bridge paths and preparation command used by both loop
skills. Do not search sibling directories or choose another filename.

`PROJECT_ROOT` comes from the absolute `project root` value in the Paseo
dispatch contract. That value is the directory containing `.aris/runs/`; it is
not a field in `RunRecord`. The dispatch contract is
[`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md), and its prompt
names this value on the `project root` line.

For the current run, the two durable files are:

```text
$PROJECT_ROOT/.aris/runs/$OUTER_RUN_ID/run.json
$PROJECT_ROOT/.aris/runs/$OUTER_RUN_ID/workflow-runtime.json
```

Read `workflow-runtime.json.outer_iteration` as `OUTER_ITERATION` and
`workflow-runtime.json.execution_root` as `EXECUTION_ROOT`. The runtime file
fields are the existing outer-runtime record; this handoff does not add them
to `run.json`.

The worker manifest layout is defined by
[`worker-manifest.md`](worker-manifest.md). The single production source for
the workflow outer-cycle worker root is `workflowCycleWorkerDirectory` in
`src/tools/workflow-state.ts`; the runtime creates its parent cycle directory,
`bridge-input` validates against it, and `review-submit` reads workflow workers
from it. The dispatch branch in
[`paseo-subagent-dispatch.md`](paseo-subagent-dispatch.md) creates the direct
worker child and sets `IDEA_DISCOVERY_MANIFEST_PATH` before starting the worker.
Preserve that exact value through this hand-off; do not reconstruct it here.

That path must be a direct child of this verified root:

```text
$PROJECT_ROOT/.aris/runs/$OUTER_RUN_ID/cycles/${OUTER_ITERATION}/workers/<directory-containing-the-runtime-manifest>/input-manifest.json
```

The placeholder is deliberately not a directory-name convention. Per
`worker-manifest.md:66-68`, the worker directory is `dirname` of the manifest
path. Derive the hand-off paths from that runtime-owned value:

```bash
IDEA_DISCOVERY_WORKER_DIR="$(dirname "$IDEA_DISCOVERY_MANIFEST_PATH")"
IDEA_DISCOVERY_JSON="$IDEA_DISCOVERY_WORKER_DIR/outputs/idea-discovery.json"
BRIDGE_INPUT_JSON="$IDEA_DISCOVERY_WORKER_DIR/outputs/bridge-input.json"
BRIDGE_EVIDENCE_PATH="$IDEA_DISCOVERY_WORKER_DIR/receipt.json"
```

The upstream phase writes `idea-discovery.json` under its declared output
directory and writes its receipt beside that worker directory. The preparation
command reads the upstream artifact plus the current run's frozen charter,
baseline and resource inventory, maps each candidate ID to one charter
position, and writes `bridge-input.json`. It does not guess a resource request
from the inventory; the bridge classifies a position without one as
unavailable. A missing file is a hard stop. Do not substitute `IDEA_REPORT.md`,
a different worker's output, or a guessed directory name.

Run this command once before `bridge-expand`. It is the only documented usage
of the new preparation command; the two loop skills reference this block.

```bash
node "$WORKFLOW_CLI" bridge-input \
  --execution-root "$EXECUTION_ROOT" \
  --project "$PROJECT_ROOT" \
  --run "$OUTER_RUN_ID" \
  --idea-discovery-manifest "$IDEA_DISCOVERY_MANIFEST_PATH"
```

The command reads the six run identity fields from the canonical `run.json`;
a missing contract stops the command. It reads `workflow-runtime.json.outer_iteration` for the cycle
number and writes the exact `BRIDGE_INPUT_JSON` path above. Its output is the
bridge input document; pass that unchanged to the existing `bridge-expand`
command.
