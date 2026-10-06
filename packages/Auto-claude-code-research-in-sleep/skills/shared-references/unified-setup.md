# Unified setup configuration and artifacts

Read with `/aris-setup` and its compatibility names. There is one editable
draft, one refresh loop and one final confirmation of the current full
configuration. Display the modules together, not as a sequential interview.
CLI output is the base sheet; enrich recommendations with known project
files and available model choices before presenting it.

## Draft and edits

`.aris/setup-draft.json` has this envelope:

```json
{
  "schema_version": 1,
  "project_root": "<actual absolute project path>",
  "configuration": {
    "project": {}, "research": {}, "metric": {}, "baseline": {},
    "environment": {}, "tester": null, "models": {}, "run": {}
  }
}
```

The helper discovers current CLAUDE.md, RESEARCH_BRIEF.md, environment
PRD/env.json, tester config, root answers/input and legacy setup answers.
Check other visible notes, successful tracker commands and locale-specific
brief headings too. If discovery cannot parse them, patch in their actual
information and show its source; do not quietly replace it with defaults.
Existing drafts are authoritative for ongoing edits.

The owner can say “目标改成 0.9，benchmark 改为 X，跑 8 轮” in one reply or
edit the draft directly. Example grouped patch, only when these changes
are requested by the owner:

```json
{
  "metric": {"target": 0.9},
  "run": {"max_iterations": 8},
  "research": {"reference_documents": ["docs/baseline.md"]}
}
```

Objects merge recursively; arrays replace; `[]` clears an optional list;
`null` clears a value and required values then fail validation. Display every
module after refresh, including unchanged modules. Do not write deployed files
from an unconfirmed draft. `configuration_sha256` identifies the version the
owner reviewed for stale-edit detection, rather than tester isolation.

## Field recommendations

| Module / fields | Options or text guidance |
| --- | --- |
| project.name / language | Current project name; `zh` or `en`, recommend the collaboration language |
| project.constraints / non_goals | Known engineering constraints and explicitly excluded research directions |
| research.field / sub_area / problem | Concrete subject, approach gap, why it matters and measured evidence that closes it |
| research.work_type | `new_direction`, `improve_existing`, `diagnostic`; recommend improvement when baseline work exists |
| research.venue / timeline | Known venue and actual timeline; unspecified is permitted, no fictional submission date |
| research.compute_budget | Actual owner budget as prose; no default GPU-hour allocation |
| research.key_papers / prior_attempts / failures / existing_results | Known references and experiments including negative results; optional empty values are explicit |
| research.domain_knowledge / reference_skills / reference_documents / reference_knowledge | Domain intuitions and lists of actual skill names, paths and constraints |
| metric.name / target / direction / tolerance | A facility metric, finite target, `higher_better` or `lower_better`; suggest accuracy/F1 higher and loss/latency lower; suggest 0.01 relative tolerance or 0 strict |
| metric.constraints | Real hard metric constraints; `[]` explicitly means none |
| baseline.method / code_ref / expected_metric / tolerance | Existing method and runnable code location; known score/tolerance or explicitly unknown score |
| environment.backend | `local`, `remote`, `docker`, `vast`, `modal`; recommend the existing execution environment |
| environment.prd | Complete shape below, with commands from successful runs or proposed scripts |
| tester | Full `TESTER_FACILITY_CONFIG_TEMPLATE.json` shape; benchmark details below |
| models.*_provider | List available providers/models and retain valid current choices; recommend a different reviewer family |
| models.executor_mode / reviewer_mode | Executor `bypassPermissions`, `auto`, `plan`; reviewer `full-access`, `auto`, `read-only`. Recommend writable modes for setup; read-only modes cannot generate required artifacts |
| models.*_thinking | Available reasoning options for the selected model; retain valid current values or omit for model default |
| models.notify_on_finish / subagent_workspace | `true` / `false`, recommend true; `current` / `worktree`, recommend current for shared facilities |
| models.dispatch_heartbeat_cron / dispatch_heartbeat_expires / max_phase_idle | Current watchdog settings; recommend 30-minute window and 24h expiry, with matching idle timeout |
| models.heartbeat_cron / heartbeat_max_runs | Existing overnight driver cadence or `off`; optional run count, distinct from watchdog |
| models.model_usage | Owner's prose naming model roles and independent reviewer/judge conditions; no structured frozen model policy |
| run.run_id / task_id / workflow_id / setup_revision | Concrete identities; changed sealed setup requires a new run/revision |
| run.expected_output | Candidate implementation/deployment files, measured output and evidence expected |
| run.max_iterations / max_repair_attempts / max_depth | Explicit integer round limit, suggest 10; repair/depth suggest 3/2, allowing 0 where supported |
| run.owner_limits | Actual graph, bundle and compute-per-candidate limits, including max_bundled_positions_per_graph |
| run.resource_inventory | Actual platforms, access references, devices, memory, quota, paths, endpoints and time window; probes supply observations, never invented capacity |
| run.baseline_scope | W_0 graph, code/artifact hashes, initial validation and optimizable positions (`independent` / `bundled`) |

Show limits as editable values with recommendations, never hidden defaults.
Setup confirmation and runtime readiness are separate: valid configuration
can still have installation failures.

## Complete environment PRD

Propose commands from current files without executing installation. Put all
required values and optional empty/null values on the same sheet. The project
slug comes from the directory name, independently of friendly project.name.
`prepare` copies the exact reviewed PRD without rewriting it.

```json
{
  "version": 1, "mode": "fresh", "project": "<discovered slug>",
  "preparation": {
    "files": {"location": "local", "remote_path": null, "transfer": null, "excludes": [], "ssh_alias": null},
    "environment": {"type": "venv", "name": "<actual or proposed name>", "activation": "<activation command, or empty for system>", "build_cmd": "<installation command or null>", "verify_cmd": "<concrete verification command>"}
  },
  "browser": {"required": false, "mode": "extract", "uses": [], "browser_type": "chrome", "browser_id": null, "smoke_url": null},
  "resources": {"type": "<gpu|cpu|node|custom>", "ids": [], "label": "<observed label>", "bind_env": "<actual binding>", "bind_mode": "env", "free_check": null, "exhaustion_patterns": []},
  "run": {"entry_point": "<script/module>", "arg_style": "cli", "launch_mode": "nohup", "gpu_selection": "<actual selection>", "template": "<complete launch template>"},
  "feedback": {
    "error": {"signal": "both", "log_path": "logs/${EXP_NAME}.log", "task_type": "<task>", "failure_patterns": []},
    "result": {"path_template": "results/${EXP_NAME}.json", "format": "json", "primary_metric_key": "<metric.name>", "extra_keys": []}
  },
  "monitor": {"interval_cron": "*/20 * * * *", "escalate_cron": "23 * * * *", "max_hours": 48, "early_stop": {"enabled": false}, "stall": {"no_log_growth_minutes": 45, "gpu_idle_threshold_pct": 5, "consecutive_alert_ticks": 3}},
  "baseline": {"kind": "real", "simple_args": null, "evidence_source": "<brief/code path>"}
}
```

These are examples/proposals, not confirmed values. Replace placeholders
and resource IDs before final confirmation. Remote files need remote_path,
ssh_alias and transfer; transfer options are rsync/git/shared. Dependency
options are conda/venv/docker/system. Resource types are gpu/cpu/node/custom,
bindings env/prefix. free_check is explicitly null or has cmd, threshold,
unit, compare (lt/gt/eq), index_by (physical/positional). Run options are
cli/config/env and screen/nohup/scheduler/foreground. Keep `{{activation}}`,
`{{entry_point}}`, `{{exp_name}}`, `{{args}}`, plus `{{remote_path}}` for remote
and `{{gpu}}` for GPU binding in launch templates. Error signals are
exit_code/log_pattern/both; result formats json/csv/log/wandb, with the result
key agreeing with metric.name.
When baseline.kind is simple, show and require baseline.simple_args as a
concrete reduced-scale run of the real entry point. Missing arguments return
to this sheet before confirmation; the generator never starts another interview.

Browser is optional. If required, show extract/session, chrome/chrome-direct/
stealth, actual uses, session ID when needed and a real smoke URL. Install
browser-act using `tools/ensure_browser_act.sh` (installed `.aris/tools`)
only after confirmation when browser.required is true. Required login is a
separate platform interaction, not another configuration questionnaire.
Retain real early-stop/stall criteria; changes appear in the sheet.
`/experiment-env-manager` consumes the confirmed PRD, configures and audits
it, returning failures without asking setup questions.

## Benchmark facility module

Use `templates/TESTER_FACILITY_CONFIG_TEMPLATE.json` as the schema, replacing
example identities, revision pins and sample counts. The full confirmed JSON
is configuration.tester. Pin benchmark source/revision, dataset revision/split
and full expected sample count including repeats. Metrics declare name,
higher_better/lower_better and mean/sum/external. Document failure handling,
seeds, prompts, judge and baseline comparison conditions in pinned scoring/
config files listed in evidence_files.

Execute local/ssh under the current account and endpoints; Docker is an
optional dependency command. Declare explicit argv arrays/timeouts for
idempotent setup, healthcheck, smoke and full test. execution.env has only
nonsecret settings; use inherited environment or existing service credentials.
Retain runner/scoring/data-manifest evidence. Protocol and publication order
are in [tester-facility.md](tester-facility.md). For a real framework deployment
adapt `templates/tester-benchmark/lm-eval-adapter.py` and its pinned profile/
README. Prepare these files only after configuration confirmation.
Installation/healthcheck/smoke must pass; setup scores do not enter Wiki.

## Apply confirmed project artifacts

Read `.aris/setup-inputs/configuration.json`, not later unconfirmed edits.
Use installed `.aris/templates` or package templates for new files. Merge
owned sections in existing files; preserve unknown sections, user notes,
baseline history and Wiki records.

CLAUDE.md mapping:

- Title/language, Project Constraints, Non-Goals and Compute Budget from
  project/research. Preserve Pipeline Status execution history.
- Model Usage gets models.model_usage verbatim as prose. ARIS Paseo gets
  reviewed providers/settings/lifecycle, omitting explicitly unset optional
  thinking/count settings. Render setup-attempt Paseo config through
  `render_w_agent_prompt.sh --emit-config --run-id <attempt> --root <root>`;
  use its executor provider/mode/optional thinking, notification setting and
  same --paseo-config for env-manager. Do not hardcode another provider.
- Reference Knowledge gets research.reference_skills/documents/knowledge as
  YAML lists; early-stop configuration mirrors environment.prd.monitor.
- Environment/Experiment Skill deployment metadata stays owned by env-manager
  and env-configuration.
- Write an active uncommented primary metric block, with no example values:

  ```yaml
  ## Metric Target
  primary: <configuration.metric.target> <configuration.metric.name>
  direction: <configuration.metric.direction>
  baseline: ""
  tolerance: <configuration.metric.tolerance>
  ```

  direction is exactly higher_better or lower_better. Preserve any known
  baseline already in this block; setup never invents a measured baseline.

RESEARCH_BRIEF.md maps research fields to Problem Statement, Background,
Constraints, work type, Domain Knowledge and Existing Results. Write:

```markdown
## Baseline Reproduction (first experiment)

The first experiment MUST reproduce this baseline before exploring improvements.

**Method**: <configuration.baseline.method>
**Code / run location**: <configuration.baseline.code_ref>
**Expected metric**: <known expected reading, or explicitly unknown>
**Tolerance**: <configuration.baseline.tolerance or configuration.metric.tolerance>
```

Do not dispatch any agent in this phase. Setup describes the baseline;
`/auto-research-loop` iteration 1 reproduces it through experiment, tester-test,
tester-audit and review. Initial validation and position hashes in
run.baseline_scope come from known work or explicit reviewed setup declarations,
not a smoke measurement.

Initialize Wiki through its helper only if absent. Read/query the existing
root problem before adding it:

```bash
node "$WIKI_SCRIPT" init research-wiki/ --direction "$RESEARCH_DIRECTION"
node "$WIKI_SCRIPT" add_problem research-wiki/ --slug "root" \
  --title "$ROOT_PROBLEM_TITLE" --status open --severity high \
  --statement "$CONFIRMED_PROBLEM" --origin "root problem created by /aris-setup from Metric Target"
```

On resume preserve the root problem and history; use supported updates when
context changes. Setup creates no claim nodes or test-result entries. Optional
explicit paper sync uses the Wiki helper; never hand-write Wiki records.
Append missing ARIS trace/runtime rules to .gitignore, preserving existing
rules. State is owned by the review helper, not a research-setup wizard.

## Execution and recovery

Review → grouped edits → refresh → final confirm → prepare → project artifacts
→ environment configure/audit → tester install/healthcheck/smoke → root seal.
Only unchanged successful evidence is reused. If installation needs a changed
command, benchmark or resource, return all defects to the sheet and confirm
the new configuration. Unchanged technical retries need no new confirmation.
Sealed root changes use a new run/revision, without overwriting charter.json.
Runtime evaluations are tester-test then tester-audit before result-to-claim;
setup is never dispatched as an iteration worker.
