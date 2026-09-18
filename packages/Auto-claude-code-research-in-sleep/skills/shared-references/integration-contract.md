# Integration Contract

ARIS skills communicate through one helper and one observable artifact.
The caller must not invent a second implementation when the helper is
missing or fails.

## Rules

Every cross-skill integration must define:

1. An explicit activation condition.
2. One canonical helper.
3. One output artifact or receipt.
4. A verifier when the result affects research correctness.

When an active integration is enabled, its helper is required. A missing
helper or a non-zero exit writes a failed receipt and stops the current
phase. The caller must not:

- search another directory;
- call another source, model, transport, or command;
- write the result inline;
- warn and continue;
- label the output partial and claim success.

The only automatic recovery kept by this contract is the experiment
failure repair loop owned by `/experiment-env-manager`. It may classify a
failed operation, repair the environment, and retry according to its own
contract. External environment detection may use its approved alternate
detectors. Feishu notification timeout may continue according to
`skills/feishu-notify/SKILL.md`.

## Canonical runtime location

Installed projects use `.aris/dist/`. Development runs inside this
repository use `dist/`. Skills must resolve exactly one of these locations
through the shared resolver; they must not add a repository, home-directory,
Python, CLI, or inline implementation fallback.

```bash
_find_project_root() {
  if [ -n "${CLAUDE_SKILL_DIR:-}" ]; then
    local root="${CLAUDE_SKILL_DIR%/.claude/skills/*}"
    [ "$root" != "$CLAUDE_SKILL_DIR" ] && { echo "$root"; return; }
    root="${CLAUDE_SKILL_DIR%/skills/*}"
    [ "$root" != "$CLAUDE_SKILL_DIR" ] && { echo "$root"; return; }
  fi

  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) && { echo "$root"; return; }

  local dir
  dir=$(pwd)
  while [ "$dir" != "/" ]; do
    [ -f "$dir/.aris/installed-skills.txt" ] && { echo "$dir"; return; }
    dir=$(dirname "$dir")
  done
  return 1
}

PROJECT_ROOT="$(_find_project_root)" || {
  echo "ERROR: cannot find the ARIS project root" >&2
  exit 1
}
cd "$PROJECT_ROOT" || exit 1

HELPER=".aris/dist/tools/<helper>"
[ -f "$HELPER" ] || HELPER="dist/tools/<helper>"
[ -f "$HELPER" ] || {
  echo "ERROR: required helper is not installed: <helper>" >&2
  echo "       Run /aris-update or build the ARIS runtime." >&2
  exit 1
}
```

This two-location lookup is an installation distinction, not a failure
fallback. Once a path resolves, every invocation must use that path.

Shell helpers use the equivalent pair:

```text
.aris/tools/<helper> → tools/<helper>
```

## Helper policy assignments

Every helper used by an active skill is listed here with the rule that applies
when it is missing or fails. A new helper must be added before a skill invokes it.

| Helper (canonical name) | Policy | Rationale |
| --- | --- | --- |
| `verify_paper_audits.sh` | A (gate) | Submission readiness cannot be inferred from prose. |
| `save_trace.sh` | A (gate) | A review without its trace is incomplete. |
| `research-wiki.js` | A (gate) | `seal-worker-manifest` freezes the run Wiki binding once; `query --manifest` checks identity and the sealed head. Scoped Signal writes require `--project-root` and `--run-id`. Outer readers set `--consumer outer-gate`, `stop-gate`, or `candidate-selection`; standalone evidence is refused. See [worker manifest fields](worker-manifest.md#worker-behavior-on-startup). |
| `workflow-cli.js` | A (outer) | Owns the serial outer lifecycle, child and budget reconciliation, validation recording and stop decisions. |
| `workflow-tools-cli.js` | A (gate) | Validates and records setup, artifact, workspace and review operations; a failed command cannot be replaced with a direct JSON edit. |
| `project-setup-cli.js` | A (gate) | Reports which of the six project setup stages are configured and turns the owner's confirmed answers into the root setup input. It seals nothing: `workflow-tools-cli.js root-setup` stays the only writer of the setup record, and this helper runs the same `collectMissingSetupItems` check early so a missing item is named during the questionnaire instead of at the sealing command. `status` exits non-zero while any stage is unconfigured, so a failed or missing helper leaves the setup state unknown and `/aris-setup` stops rather than guessing. It prints search-guard counts and digests only, never a blocked term. |
| `tester-agent-cli.js` | A (gate) | Deploys the tester agent on its own machine, fetches the contract that agent declares, submits one artifact pair through `paseo --host ssh://...` and verifies the signed receipt fetched back. The submission binds the tester definition, harness hash, case manifest digest, input distribution, model assignment and the reference/candidate artifact hashes. The response contains only a terminal public receipt or fixed coarse error categories; it never contains cases, prompts, answers, scores, observations or private URIs. |
| `search-audit-cli.js` | A (gate) | Compiles the tester's signed search exclusions into the project's search policy, installs the PreToolUse guard that refuses those network calls, and verifies the hash-chained ledger of every network call the round made. `tester-agent-cli.js submit` refuses when the ledger is missing, broken, or was written under a different contract's policy. The gate is keyword and domain matching, not a sandbox, and the ledger shares the research process's uid: it detects edits to written history, not a ledger forged whole. |
| `tester-public-receipt-cli.js` | A (gate) | Verifies the remote tester's signed conclusion and imports only its public terminal status into the prebuilt tester run; it never imports cases, observations or private result content. |
| `evidence-check.js` | A (gate) | Claims stop when their evidence cannot be checked. |
| `verify-papers.js` | A (gate) | Unverified papers cannot support cited claims. |
| `metric-gate.js` | A (gate) | The loop needs a validated stop decision. |
| `dashboard-merge.js` | A (gate) | State advancement requires a validated receipt. |
| `render_w_agent_prompt.sh` | A (gate) | Sub-agent dispatch requires the run configuration. |
| `experiment-env/env-helper.js` | A (gate) | Environment operations use the experiment repair contract. |
| `feishu-notify` | C (notification) | Notification failure may continue as defined by its own contract. |

When a SKILL invokes a helper not listed above, add the row here as part of the
same change and state its failure rule.

## Artifacts and failure

A successful phase must leave its declared artifact. A failed phase must
leave a receipt with:

```json
{
  "status": "failed",
  "phase": "<phase>",
  "error": "<action and reason>",
  "next_action": "Fix the dependency, then run the phase again"
}
```

Do not turn a failure into an empty result, an `UNVERIFIED` success, or a
partial report unless the phase was explicitly configured for a partial
research outcome before it started.

## Explicit choices are not fallbacks

These remain valid because the user chooses them before execution:

- `RENDER_HTML=false`;
- `CODE_REVIEW=false`;
- an explicit `--source` or `--sources` list;
- an explicit AlphaXiv depth;
- an explicit draft or submission assurance level;
- an explicit `resume`, `retry`, or `fresh` run.

An unavailable requested choice fails. The system does not silently select
another choice.

## Integrations

| Integration | Required helper/artifact | Failure rule |
| --- | --- | --- |
| Research Wiki ingest | `research-wiki.js`, paper page, log entry | Stop the active paper phase |
| Evidence check | `evidence-check.js`, evidence result | Stop claim generation |
| Paper verification | `verify-papers.js`, verification result | Stop cited-claim generation |
| Reviewer call | selected reviewer and trace | Stop the review phase |
| Run state | `run-state.js`, state receipt | Stop the resumable loop |
| Metric gate | `metric-gate.js`, gate result | Stop the iteration loop |
| Dashboard merge | `dashboard-merge.js`, merged receipt | Stop state advancement |
| Experiment operation | generated operation helper | Delegate to the environment repair contract |
| Feishu notification | configured notification bridge | Follow the notification auto-continue contract |

## Forbidden patterns

Reject new or modified skill text containing any of these behaviors unless
it belongs to the three retained contracts above:

- “try X, then Y” after an execution failure;
- “if unavailable, skip and continue”;
- “warn and produce the main result”;
- “search an undeclared path if the declared path is absent”;
- “use another model/provider/CLI if the selected one fails”;
- “write the artifact manually if the helper is absent”;
- “mark it unverified and continue”.

## See also

- `shared-references/wiki-helper-resolution.md`
- `shared-references/output-versioning.md`
- `shared-references/worker-manifest.md`
- `shared-references/resumable-runs.md`
- `shared-references/reviewer-routing.md`
