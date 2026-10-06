---
name: aris-setup
description: 'Configure research, metrics, execution environment, tester facilities, models and root run through one editable modular review. Use for aris setup, 配置项目 or missing root configuration.'
allowed-tools: Read, Write, Bash(*), AskUserQuestion, mcp__paseo__list_models, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission, mcp__paseo__archive_agent, mcp__paseo__create_heartbeat, mcp__paseo__delete_heartbeat
---

# ARIS Setup

> **Dispatch watchdog (mandatory).** Follow the global dispatch rules and §"The dispatch watchdog" in [paseo-subagent-dispatch.md](../shared-references/paseo-subagent-dispatch.md).

Use `project-setup-cli.js` through the [runtime integration contract](../shared-references/integration-contract.md), with the actual research project root. The helper owns the draft, review state and confirmed inputs; do not write those records manually.

## Configuration review

- Run `review` to discover current values. Present all eight modules together: project, research, metric, baseline, environment, tester, models and run. Show value/source for every field, all options and a recommendation for choices, and a concrete suggestion for text/JSON. Use the project language.
- Use the available model catalogue for provider/model options. Add all unavailable selections or catalogue failures to the same conflict list; the helper checks structure, not live availability. Distinguish proposed settings from observed hardware, quota, revision pins and measurements.
- Accept multiple edits in one reply or direct edits to `.aris/setup-draft.json`. Apply `refresh` and redisplay every module plus all gaps/conflicts. Objects merge, arrays replace and `null` clears. Recommendations become values only when accepted.
- When complete, show the latest full sheet and its `configuration_sha256`, then obtain one final confirmation before execution. No field-by-field or module-by-module interview. Edits invalidate earlier confirmation; a request to edit is not approval.

| Helper command | Contract |
| --- | --- |
| `review --project <root>` / `refresh --project <root> [--input <patch.json>]` | Editable draft and `.aris/setup-review.md`; exit 0 does not imply completeness |
| `confirm --project <root> --digest <reviewed digest>` | Requires the current complete review and the owner's explicit approval |
| `prepare --project <root>` | Writes confirmed `.aris/setup-inputs/` and `.aris/root-setup-answers.json`; installs and seals nothing |
| `verify --project <root> --configuration <snapshot> --environment <prd>` | Rejects stale or changed worker inputs |
| `assemble` / `status` | Root input assembly / actual five-stage readiness |

Consult [unified-setup.md](../shared-references/unified-setup.md) only for missing PRD schema or confirmed artifact mapping; choices and recommendations come from the helper, not a second questionnaire.

## Confirmed execution and handoff

Apply the confirmed artifact mapping, preserving existing research notes and Wiki history. Setup describes baseline reproduction; iteration 1 runs it. Setup and smoke never publish metrics.

Reuse only an environment matching the confirmed PRD/backend and passing audit. Otherwise dispatch `/experiment-env-manager` with both prepared PRD and configuration snapshots. The worker returns defects to this review without asking setup questions or offering `user_override`.

Prepare the declared runner/data/service files, then use `tester-facility-cli.js migrate` and `tester-facility-cli.js setup` with the confirmed facility input. Require matching installation, healthcheck and smoke evidence. Use shared facilities under the existing account.

Use `assemble` and `workflow-tools-cli.js root-setup` to seal the root. The latter remains the only root writer and requires:

`tester`, `tester_facility`, `thresholds`, `limits`, `resource`, `baseline`

Keep model usage as CLAUDE.md prose; no loop `budget` or structured `model_usage_policy`. Require all five readiness stages and `blocking: []`, then hand off `/auto-research-loop`.

Retry technical failures with unchanged confirmed inputs. Configuration changes return to the full edit/refresh/confirm loop; changed sealed answers require a new run ID and setup revision. Subsequent evaluations run `/tester-test` → `/tester-audit` before Wiki publication and reuse the same facilities; see [tester-facility.md](../shared-references/tester-facility.md).
