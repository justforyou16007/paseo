---
name: experiment-env-configuration
description: 'Interactively configure a project''s experiment environment ONCE, then freeze the whole prepare → run → feedback loop into a reusable project-local skill at `.claude/skills/run-<project>-experiment/`. Covers experiment-file placement (local/remote), dependency environment, the run command/CLI, and the three feedback channels (error, result, analysis). The frozen configuration is cross-model audited by /experiment-audit before the skill is created. Every step becomes a script or CLI so the second and later runs are fully automatic with no re-configuration. Use when user says "configure experiment environment", "实验环境配置", "set up how experiments run", or when a baseline reproduction finishes and the flow must be made replayable.'
argument-hint: "[— project: <name>] [— reconfigure] [— non-interactive] [— reviewer: codex|oracle-pro|manual]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, AskUserQuestion, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__wait_for_agent, mcp__paseo__archive_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission
---

> **Paseo dispatch contract.** This skill satisfies the Global Agent Rules in
> [](shared-references/paseo-subagent-dispatch.md) (Rule 1: One Agent = One Skill;
> Rule 4: Paseo MCP Only, Strict). The Phase 5.5 audit is dispatched via
> `mcp__paseo__create_agent` — not the host `Skill` / `Agent` / `Task` tools.

> **Gate provenance** (`shared-references/acceptance-gate.md` step 5).
> This skill has one STOP gate: *may the project-local experiment skill be created?*
> It is **compound and therefore split, not averaged**:
> - **Type-A** (self-checkable, Phase 5 + Phase 5.5a): the bundle is syntactically
>   valid, `env.json` is complete, all four scripts dry-run clean, the audit **was
>   invoked**, and `ENV_CONFIG_AUDIT.json` exists and parses.
> - **Type-B** (**never self-judged**, Phase 5.5b): *is this frozen configuration
>   trustworthy — will it actually reproduce the run it claims to freeze?* This
>   verdict is produced by `/experiment-audit` on a different model family and is
>   **read verbatim**. This skill never forms its own opinion of it.
>
> Removing the cross-model reviewer must not leave this skill able to decide it
> may create the skill. It cannot: Phase 6 promotion keys off
> `ENV_CONFIG_AUDIT.json.overall_verdict`, and a missing file is a hard stop.

# Experiment Environment Configuration

Configure the experiment environment for: **$ARGUMENTS**

## Purpose

A research project runs the *same* experiment loop dozens of times: put the code
somewhere runnable, activate the right dependency environment, launch, then read
back errors / metrics / analysis. Today that knowledge lives in one agent's head
and is re-derived every round.

This skill runs the configuration **once**, interactively, and writes the answer
down as an executable project-local skill. After it completes, every later
stage (`/experiment-bridge`, `/run-experiment`, `/auto-research-loop`) invokes
the generated skill instead of re-asking anything.

```
Phase 0    Pre-flight: resolve roots, detect existing config, decide interactive vs derived
Phase 1    Experiment preparation — files (where the code must live, how it gets there)
Phase 2    Experiment preparation — environment (which dependency env, how it is verified)
Phase 3    Run — the single command/CLI that executes an experiment
Phase 4    Feedback — error channel, result channel, analysis channel
Phase 5    Emit the project-local skill bundle (SKILL.md + scripts/ + env.json) — DRAFT only
Phase 5.5  Trustworthiness audit (DRIVE/ACQUIT gate, cross-model, /experiment-audit)
Phase 6    Promote: verify dry-runs + audit verdict → finalize status, print summary
```

**What gets written (all inside the PROJECT, never the ARIS repo):**

| # | Path | Contents |
|---|------|----------|
| 1 | `.claude/skills/run-<project>-experiment/SKILL.md` | The replayable prepare→run→feedback procedure |
| 2 | `.claude/skills/run-<project>-experiment/scripts/prepare.sh` | Sync code + verify dependency env |
| 3 | `.claude/skills/run-<project>-experiment/scripts/run.sh` | Launch one experiment (takes a run-spec) |
| 4 | `.claude/skills/run-<project>-experiment/scripts/collect.sh` | Pull back logs + results |
| 5 | `.claude/skills/run-<project>-experiment/scripts/analyze.sh` | Produce the analysis artifact |
| 6 | `.claude/skills/run-<project>-experiment/env.json` | Frozen answers (the config of record) |
| 7 | `.aris/env-config/<project>/ENV_CONFIG_AUDIT.md` | Cross-model audit report (Phase 5.5) |
| 8 | `.aris/env-config/<project>/ENV_CONFIG_AUDIT.json` | Machine-readable verdict — the gate reads this |

Rows 1–6 are written to a **staging directory first** and only moved into
`.claude/skills/` after the Phase 5.5 audit returns a passing verdict. Nothing
becomes an invocable skill on the strength of this skill's own say-so.

> **This skill does NOT modify the ARIS repo.** Earlier versions of this flow
> (`add-compute-backend`) scaffolded a TypeScript `EnvBackend` subclass into
> `src/tools/experiment-env/`. That coupled every project's environment to an
> ARIS source edit + rebuild. The environment is project data, not ARIS code —
> it belongs in the project directory. The existing `EnvBackend` backends
> (`local`, `remote`, `vast`, `modal`, `docker`) are still used as the transport
> when one of them fits; anything they do not cover is expressed as a script in
> the generated skill.

---

## Phase 0: Pre-flight

1. **Resolve project root.**
   ```bash
   ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
   cd "$ROOT" || exit 1
   ```

2. **Derive the project slug.** `basename "$ROOT"`, lowercased, non-alphanumerics
   collapsed to `-`. This becomes `<project>` in `run-<project>-experiment`.
   Validate against `/^[a-z0-9][a-z0-9-]*$/`; if it fails, fall back to `project`.

3. **Idempotency check.** Compute `SKILL_DIR=".claude/skills/run-<project>-experiment"`
   and `STAGING_DIR=".aris/env-config/<project>/draft"`.

   | State | Action |
   |---|---|
   | `$SKILL_DIR/SKILL.md` exists AND `$ARGUMENTS` has no `— reconfigure` | Read `$SKILL_DIR/env.json`, run **Phase 6 verification only**, report `status: already_configured`, and STOP. |
   | `$SKILL_DIR/SKILL.md` exists AND `— reconfigure` given | Back up to `$SKILL_DIR.bak-<UTC timestamp>/`, then run all phases (fresh staging). |
   | absent | Run all phases. |

   This is what makes the second and later experiment rounds free of
   configuration: the skill short-circuits unless explicitly asked to redo.

4. **Harvest existing answers** — these seed the Phase 1–4 questions as
   pre-filled first options so the user usually just presses enter:
   - `CLAUDE.md` `## Remote Server` / `## Experiment Environment` blocks
   - `.aris/experiment-env.json` (written by `/run-experiment` Step 1)
   - `.aris/setup-state.json` (`gpu_type`, `conda_env`, answers from `/research-setup`)
   - The most recent `refine-logs/EXPERIMENT_TRACKER.md` rows — the commands that
     actually worked during baseline reproduction are the best possible default.

5. **Non-interactive mode.** If `$ARGUMENTS` contains `— non-interactive` (how
   `/auto-research-loop` calls this skill), do NOT call `AskUserQuestion` at all.
   Derive every answer from step 4's sources. If a **required** answer cannot be
   derived, write `$STAGING_DIR/env.json` with `"status": "incomplete"` and the list
   of missing keys, emit a clear warning, and stop — do not guess a run command.
   A wrong run command silently burns GPU hours.

6. **Parse reviewer override.** If `$ARGUMENTS` contains `— reviewer: <backend>`,
   set `REVIEWER_BACKEND = <backend>` (valid: `codex`, `oracle-pro`, `manual`).
   Otherwise default to `codex`. This is passed through to `/experiment-audit`.

---

## Phase 1: Preparation — Experiment Files

Goal: know **where the experiment code must physically be** for a run to work,
and **how it gets there**.

Use `AskUserQuestion` (skip in non-interactive mode; derive instead).

**Q1** — header: "Location", question: "Where do experiments actually execute?"
- `"Local machine"` — "Code runs from the project directory as-is; no transfer."
- `"Remote server (SSH)"` — "Code must be copied to a remote host before running."
- `"Container"` — "Code is mounted or baked into a container image."
- `"Managed/serverless"` — "A CLI uploads the code at submit time (Modal, etc.)."

**Q2** — header: "Remote path", question: "Absolute path on the execution machine where code must live?"
- Seed the first option from `.aris/experiment-env.json` `code_dir`, else
  `/workspace/<project>` for container/remote, else `$ROOT` for local.
- Skip this question entirely when Q1 = "Local machine".

**Q3** — header: "Transfer", question: "How does code get from here to there?"
- `"rsync over SSH"` — "rsync -avz --exclude .git ./ <alias>:<path>/"
- `"git push/pull"` — "Push here, pull on the execution machine."
- `"Shared filesystem"` — "Already visible on both sides; nothing to do."
- `"Uploaded by the CLI"` — "The submit CLI handles upload."

**Q4** — header: "Excludes", question: "Which paths must NOT be transferred?"
- Seed with `.git, __pycache__, results/, logs/, checkpoints/, *.pt, *.ckpt, data/`.
- Large checkpoints and datasets on the sync path are the single most common
  cause of a "hung" experiment launch.

**Record as:** `preparation.files = { location, remote_path, transfer, excludes[] }`.

---

## Phase 2: Preparation — Dependency Environment

Goal: the experiment code must be **runnable** — the right interpreter, the right
packages, and a way to *prove* it before launching.

**Q1** — header: "Env type", question: "What provides the dependency environment?"
- `"Conda"` — "conda activate <env> before running."
- `"venv / uv"` — "source <path>/bin/activate."
- `"Container image"` — "Dependencies baked into the image."
- `"System Python"` — "No isolation; run the interpreter directly."

**Q2** — header: "Env name", question: "Environment name or activation path?"
- Seed from `.aris/experiment-env.json` `conda_env`, else `.aris/setup-state.json`.

**Q3** — header: "Activation", question: "Exact activation line (the hook, if any)?"
- Seed from `conda_hook`, typically
  `source ~/miniconda3/etc/profile.d/conda.sh && conda activate <env>`.
- Getting the hook wrong is why `conda activate` fails under
  `ssh host 'command'` — a non-login shell has no `conda` function.

**Q4** — header: "Verify", question: "One command that proves the environment is usable?"
- Seed with `python -c "import torch; print(torch.__version__, torch.cuda.is_available())"`.
- This becomes the last line of `prepare.sh`. A run must never be launched into
  an environment that has not answered this successfully.

**Record as:** `preparation.environment = { type, name, activation, verify_cmd }`.

---

## Phase 3: Run — the Experiment Command

Goal: reduce "run an experiment" to **one command with parameters**, so later
stages never reconstruct it.

**Q1** — header: "Entry point", question: "Script or module that runs one experiment?"
- Seed from the baseline reproduction: grep `refine-logs/EXPERIMENT_TRACKER.md`
  and `.aris/runs/*.json` for the command that succeeded.

**Q2** — header: "Arguments", question: "How are experiment parameters passed?"
- `"CLI flags"` — "--lr 1e-4 --seed 0"
- `"Config file"` — "python train.py --config configs/exp.yaml"
- `"Environment variables"` — "LR=1e-4 SEED=0 python train.py"
- `"Positional"` — "python train.py 1e-4 0"

**Q3** — header: "Launch mode", question: "How is a long run kept alive?"
- `"screen/tmux detached"` — "screen -dmS <name> — survives SSH disconnect."
- `"nohup background"` — "nohup ... & — survives logout."
- `"Job scheduler"` — "sbatch / qsub / kubectl — the scheduler owns the lifetime."
- `"Foreground"` — "Blocks until done; only sane for short runs."

**Q4** — header: "GPU selection", question: "How is the GPU chosen?"
- `"CUDA_VISIBLE_DEVICES"` — "Set per run by the caller."
- `"Scheduler-assigned"` — "The job scheduler allocates."
- `"All available"` — "Multi-GPU / DDP; the script decides."
- `"CPU only"` — "No GPU."

**Record as:** `run = { entry_point, arg_style, launch_mode, gpu_selection, template }`
where `template` is the fully-assembled command with `{{placeholders}}` for the
per-run values, e.g.:

```
{{activation}} && cd {{remote_path}} && CUDA_VISIBLE_DEVICES={{gpu}} \
  screen -dmS {{exp_name}} bash -c 'python {{entry_point}} {{args}} 2>&1 | tee logs/{{exp_name}}.log'
```

---

## Phase 4: Feedback — the Three Channels

This is the part previous flows left implicit. An experiment is not "done" when
the process exits; it is done when all three channels have been read.

### 4a. Error feedback — did the run fail, and why?

**Q1** — header: "Failure signal", question: "How do you know a run failed?"
- `"Non-zero exit code"`
- `"Traceback in the log"`
- `"Missing result file"` — "Success is defined by the result artifact existing."
- `"Scheduler status"` — "squeue/kubectl reports FAILED."

Record `feedback.error = { signal, log_path, failure_patterns[] }`. Default
`failure_patterns`: `Traceback`, `CUDA out of memory`, `Killed`, `AssertionError`,
`RuntimeError`, `No such file`.

`collect.sh` greps these and surfaces matching lines. A silent failure that looks
identical to "still running" is the worst outcome — the pattern list must cover
crashes, not only the happy path.

### 4b. Result feedback — what did the run measure?

**Q1** — header: "Result file", question: "Where does the run write its metrics?"
- Seed from the baseline artifacts, e.g. `results/<exp_name>.json`.

**Q2** — header: "Format", question: "What format?" — `"JSON"` / `"CSV"` / `"Parsed from log"` / `"W&B"`.

**Q3** — header: "Primary metric", question: "Which key is the headline metric?"
- Seed from `CLAUDE.md` `## Metric Target` (`primary: <number> <unit>`) — the
  metric name there MUST match the key read here, or the loop's Type-A stop
  check silently compares nothing.

Record `feedback.result = { path_template, format, primary_metric_key, extra_keys[] }`.

### 4c. Analysis feedback — what do the numbers mean?

**Q1** — header: "Analysis", question: "How should results be analyzed?"
- `"Reuse an ARIS skill"` — "/analyze-results — comparison table + significance."
- `"Reuse a project script"` — "An existing script in this repo."
- `"Generate a new script"` — "Create one now from the described logic."
- `"Custom per-experiment"` — "Analysis differs each time; only record the inputs."

**Q2** — header: "Analysis logic", question: "What comparison or test is required?"
- e.g. "compare each run against the baseline row, bootstrap 95% CI over seeds".
- Free text; this becomes the body of `analyze.sh` (or its dispatch to a skill).

**Q3** — header: "Output", question: "Where does the analysis artifact go?"
- Seed with `refine-logs/EXPERIMENT_RESULTS.md` — where `/experiment-bridge`
  already looks. Diverging from that path means later stages will not find it.

Record `feedback.analysis = { mode, logic, script_path, output_path }`.

**Reuse before generate.** For `mode = "Reuse an ARIS skill"`, `analyze.sh` must
dispatch the skill rather than reimplement it. Only `"Generate a new script"`
writes fresh analysis code, and it writes it into the generated skill's
`scripts/` directory so it is version-controlled with the project.

---

## Phase 5: Emit the Project-Local Skill Bundle (DRAFT)

Everything below is written under `$STAGING_DIR` = `.aris/env-config/<project>/draft/`
in the **project**, NOT into `.claude/skills/` yet. The bundle is promoted only
after Phase 5.5's audit passes.

### 5a. `env.json` — the config of record

```json
{
  "version": 1,
  "project": "<project>",
  "generated": "<ISO-8601 UTC>",
  "source": "experiment-env-configuration",
  "status": "draft",
  "backend_hint": "<local|remote|vast|modal|docker|custom>",
  "preparation": {
    "files": { "location": "...", "remote_path": "...", "transfer": "...", "excludes": ["..."] },
    "environment": { "type": "...", "name": "...", "activation": "...", "verify_cmd": "..." }
  },
  "run": { "entry_point": "...", "arg_style": "...", "launch_mode": "...", "gpu_selection": "...", "template": "..." },
  "feedback": {
    "error": { "signal": "...", "log_path": "...", "failure_patterns": ["..."] },
    "result": { "path_template": "...", "format": "...", "primary_metric_key": "...", "extra_keys": ["..."] },
    "analysis": { "mode": "...", "logic": "...", "script_path": "...", "output_path": "..." }
  },
  "audit": { "status": "pending", "verdict": null, "report": null, "audited_at": null }
}
```

`status` is written as `"draft"` here and is flipped to `"complete"` **only** by
Phase 6, and only when the Phase 5.5 verdict allows it. Downstream skills gate on
`status == "complete"`, so an un-audited or failed configuration is inert rather
than silently authoritative.

`audit` is filled in by Phase 5.5 from `ENV_CONFIG_AUDIT.json`. Its `verdict` is
**transcribed, never computed** — see the Gate provenance note at the top.

`backend_hint` records whether an existing `EnvBackend` (`local`/`remote`/`vast`/
`modal`/`docker`) covers this environment. When it does, the generated scripts
call `env-helper.js` and inherit its retry/sync behavior. When it is `custom`,
the scripts issue the commands directly. **No ARIS source file is edited either way.**

### 5b. The four scripts

Each is POSIX `sh`, `set -eu`, reads `env.json` via `jq`, and accepts
`--dry-run` (print the command, execute nothing). All four must be executable
(`chmod +x`).

**`prepare.sh`** — transfer code per `preparation.files`, then run
`preparation.environment.verify_cmd` on the execution machine. Non-zero exit
means do not proceed to `run.sh`.

**`run.sh <exp_name> [--gpu N] [--args "..."]`** — substitute into
`run.template` and launch. Prints the resolved command before executing so the
log records exactly what ran.

**`collect.sh <exp_name>`** — pull back `feedback.error.log_path` and
`feedback.result.path_template`; grep the log for `failure_patterns`; print a
verdict line: `RESULT ok <primary_metric>=<value>` or `RESULT failed <first matching pattern>`.

**`analyze.sh`** — per `feedback.analysis.mode`: dispatch the ARIS skill, call
the project script, or run the generated analysis; write to
`feedback.analysis.output_path`.

### 5c. `SKILL.md` — the replayable procedure

Frontmatter:

```yaml
---
name: run-<project>-experiment
description: 'Run one experiment for the <project> research project: prepare (sync code + verify dependency environment), run (launch via the frozen command), and feed back (errors, metrics, analysis). Generated by /experiment-env-configuration from a verified baseline reproduction — do not re-answer configuration questions, the answers are frozen in env.json. Use whenever an experiment must be executed or re-executed for this project.'
argument-hint: "<exp_name> [— args: ...] [— gpu: N] [— skip-prepare]"
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob
---
```

Body sections, in order:

1. **Frozen configuration** — a human-readable rendering of `env.json`
   (where code lives, which env, the run command, the three feedback channels).
   Marked explicitly: *"These values were verified during baseline reproduction.
   Do not re-derive them. To change them, run `/experiment-env-configuration —
   reconfigure`."*
2. **Step 1 — Prepare** — `scripts/prepare.sh`; hard-stop on failure.
   Skippable with `— skip-prepare` when a run in the same session already prepared.
3. **Step 2 — Run** — `scripts/run.sh <exp_name>` with the resolved arguments.
4. **Step 3 — Error feedback** — `scripts/collect.sh <exp_name>`; on
   `RESULT failed`, report the matched pattern and the last 40 log lines, and stop.
5. **Step 4 — Result feedback** — read `primary_metric_key`; append a row to
   `refine-logs/EXPERIMENT_TRACKER.md`.
6. **Step 5 — Analysis feedback** — `scripts/analyze.sh`; the artifact lands at
   `feedback.analysis.output_path`.
7. **Receipt** — write `.aris/runs/<run_id>.experiment.<exp_name>.done.json`:
   ```json
   { "exp_name": "...", "status": "ok|failed", "primary_metric": <number|null>,
     "result_path": "...", "analysis_path": "...", "log_path": "...",
     "failure_reason": "<null or matched pattern>", "completed_at": "<ISO-8601>" }
   ```
   This is the file a dispatching parent reads. The agent's reply text is at most
   a one-line status (`paseo-subagent-dispatch.md` Rule 3, file-paths-only).

---

## Phase 5.5: Trustworthiness Audit (DRIVE/ACQUIT gate)

The draft bundle now *claims* to reproduce the baseline run. This skill is the
wrong party to believe that claim: it wrote the bundle, and the same reasoning
that produced a plausible-but-wrong run command would also find that command
plausible on review. Per `shared-references/acceptance-gate.md`, the acceptance
question is Type-B and is routed off this model.

> `/experiment-audit` is **advisory to its other callers and stays that way** —
> its own contract ("never block") is unchanged and `/research-pipeline` still
> continues on FAIL. The blocking behaviour lives **here, in the caller**. This
> skill declines to promote a bundle its auditor did not clear; the auditor is
> not made to halt anyone.

### 5.5a. Invoke the audit (Type-A — this skill may self-check this half)

Dispatch a **paseo sub-agent** per Rule 1 / Rule 4 — never the host `Skill` tool:

```
mcp__paseo__create_agent
  title:    "env-config audit: <project>"
  provider: claude
  cwd:      $ROOT
  initialPrompt: |
    Run the skill /experiment-audit — reviewer: <REVIEWER_BACKEND>
    scoped to the experiment-environment configuration draft, not to results.

    Audit target (paths only — read them yourself, they are not summarized here):
      Draft bundle:        .aris/env-config/<project>/draft/
      Frozen config:       .aris/env-config/<project>/draft/env.json
      Generated scripts:   .aris/env-config/<project>/draft/scripts/*.sh
      Generated skill:     .aris/env-config/<project>/draft/SKILL.md
      Baseline evidence:   refine-logs/EXPERIMENT_TRACKER.md
      Metric contract:     CLAUDE.md  (## Metric Target)
      Prior env answers:   .aris/experiment-env.json, .aris/setup-state.json

    Apply checklist A–F as written, PLUS these configuration-specific checks.
    Report each as PASS | WARN | FAIL with file:line evidence:

    G. Command provenance — does run.template correspond to a command that
       demonstrably ran during baseline reproduction (cite the EXPERIMENT_TRACKER
       row or log), or was it synthesized? FAIL if synthesized with no evidence.
    H. Metric key agreement — does feedback.result.primary_metric_key exist in a
       real result artifact AND match CLAUDE.md ## Metric Target? FAIL on mismatch:
       every downstream stop check silently compares nothing.
    I. Failure detectability — would feedback.error.failure_patterns actually fire
       on the crash modes this project exhibits? FAIL if a crash would be
       indistinguishable from "still running".
    J. Environment reachability — is preparation.environment.verify_cmd a real
       check of the env that runs the entry point, or a tautology (e.g. `true`,
       `echo ok`, `python --version` for a CUDA job)? FAIL if tautological.
    K. Analysis honesty — does feedback.analysis actually produce the artifact it
       claims at output_path, or is it a stub? WARN on stub, FAIL on a stub
       presented as complete.

    Write the report to .aris/env-config/<project>/ENV_CONFIG_AUDIT.md and the
    machine-readable verdict to .aris/env-config/<project>/ENV_CONFIG_AUDIT.json
    (same schema as EXPERIMENT_AUDIT.json, with checks G–K added).

    Reply with the two file paths only.
```

Then `mcp__paseo__wait_for_agent`, read the receipt file, and
`mcp__paseo__archive_agent` (用完即 archive). **Never poll `get_agent_status`.**

This half is Type-A — "the audit was invoked and its verdict file exists and
parses" is machine-checkable, so this skill may judge it:

```bash
AUDIT_JSON=".aris/env-config/<project>/ENV_CONFIG_AUDIT.json"
test -f "$AUDIT_JSON" && jq -e '.overall_verdict' "$AUDIT_JSON" >/dev/null
```

If the file is missing or unparseable, that is a **hard stop**: `audit.status =
"error"`, no promotion. A skill that promotes when the auditor failed to answer
is self-acquitting by omission.

### 5.5b. Read the verdict (Type-B — this skill MUST NOT form its own opinion)

Transcribe, do not evaluate:

```bash
VERDICT=$(jq -r '.overall_verdict' "$AUDIT_JSON" | tr 'A-Z' 'a-z')
```

| `overall_verdict` | Promotion | `env.json.status` | Behaviour |
|---|---|---|---|
| `pass` | **allowed** | `complete` | Phase 6 promotes the bundle. |
| `warn` | **allowed, tagged** | `complete` | Promote, and copy the WARN action items into the generated `SKILL.md` under a `## Known caveats (from audit)` section so every later run sees them. |
| `fail` | **refused** | `audit_failed` | Do **not** create `.claude/skills/run-<project>-experiment/`. The draft stays in staging. Print the failing checks and their action items. |
| missing / unparseable | **refused** | `audit_error` | As above; report that the audit did not return a verdict. |

Record into the draft `env.json`:

```json
"audit": {
  "status": "passed|passed_with_warnings|failed|error",
  "verdict": "<verbatim overall_verdict from the audit JSON>",
  "report": ".aris/env-config/<project>/ENV_CONFIG_AUDIT.md",
  "audited_at": "<ISO-8601 UTC>",
  "failing_checks": ["G", "H"]
}
```

**The `verdict` field is copied verbatim.** This skill does not reinterpret a
FAIL as "a warning really", does not average A–K into an overall of its own, and
does not re-run the audit hoping for a better answer. One audit, one verdict.

### 5.5c. On FAIL — repair, then re-audit (bounded)

A FAIL is actionable, not terminal. Up to **MAX_AUDIT_ROUNDS = 2** times:

1. Read the action items from `ENV_CONFIG_AUDIT.md`.
2. Fix the *specific* draft artifacts they name — re-derive the run command from
   the tracker, correct the metric key, widen the failure patterns, replace the
   tautological verify command.
3. Re-run 5.5a as a **fresh** sub-agent (a new audit, not a follow-up round — the
   reviewer must not be anchored on having already seen a broken draft).

If round 2 still returns FAIL, stop and report. Do **not** promote. In
non-interactive mode this returns `status: "audit_failed"` to the caller, which
is a legitimate outcome — `/auto-research-loop` treats it as "environment not
frozen this iteration" and proceeds without the generated skill.

**Never** loop unbounded, never re-audit for a third time, and never re-word the
audit prompt to make the failure go away. That is verdict shopping.

---

## Phase 6: Verify and Promote

Run in order; do not report success on a failure. Steps 1–3 verify the draft
**in staging**; only step 5 makes it an invocable skill.

1. **Scripts are valid shell:** `sh -n` each of the four scripts in `$STAGING_DIR/scripts/`.
2. **Dry-run each script:** `sh scripts/prepare.sh --dry-run`, `sh scripts/run.sh smoke --dry-run`,
   `sh scripts/collect.sh smoke --dry-run`, `sh scripts/analyze.sh --dry-run`. Each must exit 0
   and print a plausible command — no unsubstituted `{{placeholder}}` may survive.
3. **`env.json` parses and is structurally complete:**
   ```bash
   jq -e '.run.template != "" and .feedback.result.primary_metric_key != ""' \
     "$STAGING_DIR/env.json"
   ```

4. **Gate — the audit verdict permits promotion.** This is the STOP gate; it
   reads the Phase 5.5 verdict and does not re-derive it:
   ```bash
   jq -e '.audit.status == "passed" or .audit.status == "passed_with_warnings"' \
     "$STAGING_DIR/env.json"
   ```
   Non-zero exit ⇒ **do not promote**. Leave the draft in `$STAGING_DIR`, leave
   `.claude/skills/run-<project>-experiment/` absent, print the failing checks
   from `ENV_CONFIG_AUDIT.md`, and report `status: "audit_failed"` (or
   `"audit_error"`). Steps 1–3 passing does not override this: a bundle can be
   syntactically perfect and still freeze the wrong command.

5. **Promote.** Only when step 4 passes:
   ```bash
   mkdir -p "$(dirname "$SKILL_DIR")"
   cp -R "$STAGING_DIR" "$SKILL_DIR"
   chmod +x "$SKILL_DIR"/scripts/*.sh
   # flip draft → complete only now, in the promoted copy
   tmp=$(mktemp)
   jq '.status = "complete"' "$SKILL_DIR/env.json" > "$tmp" && mv "$tmp" "$SKILL_DIR/env.json"
   ```
   On `passed_with_warnings`, append the audit's WARN action items to
   `$SKILL_DIR/SKILL.md` under `## Known caveats (from audit)` before finishing.

6. **Skill is discoverable:** `$SKILL_DIR/SKILL.md` exists with valid frontmatter
   whose `name` matches the directory name, and
   `jq -e '.status == "complete"' "$SKILL_DIR/env.json"` exits 0.

Then print:

```
Experiment environment configured for "<project>".

Generated:
  .claude/skills/run-<project>-experiment/SKILL.md
  .claude/skills/run-<project>-experiment/env.json
  .claude/skills/run-<project>-experiment/scripts/{prepare,run,collect,analyze}.sh

Frozen configuration:
  Files:     <location> → <remote_path> via <transfer>
  Env:       <type> "<name>", verified by: <verify_cmd>
  Run:       <entry_point> (<launch_mode>, <gpu_selection>)
  Error:     <signal>, log at <log_path>
  Result:    <primary_metric_key> from <path_template>
  Analysis:  <mode> → <output_path>

Verification:
  Shell syntax:   PASS/FAIL
  Dry runs:       PASS/FAIL
  env.json:       PASS/FAIL
  Audit (Type-B): PASS/WARN/FAIL   ← cross-model, <REVIEWER_BACKEND>
  Promoted:       yes/no
  Discoverable:   PASS/FAIL

Audit report: .aris/env-config/<project>/ENV_CONFIG_AUDIT.md

Next: /run-<project>-experiment <exp_name>
Re-runs need no configuration. To change it: /experiment-env-configuration — reconfigure
```

When the gate refuses promotion, print this instead — and do not print a "Next:"
line, because there is no skill to invoke:

```
Experiment environment NOT configured for "<project>" — audit did not pass.

Draft (not promoted): .aris/env-config/<project>/draft/
Audit report:         .aris/env-config/<project>/ENV_CONFIG_AUDIT.md
Verdict:              FAIL  (rounds used: <n>/2)

Failing checks:
  <ID>. <check name> — <one-line action item from the report>
  ...

The project-local experiment skill was not created. Fix the items above, then:
  /experiment-env-configuration — reconfigure
```

---

## Constants

- **SKILL_DIR_TEMPLATE** = `.claude/skills/run-<project>-experiment`
- **STAGING_DIR_TEMPLATE** = `.aris/env-config/<project>/draft`
- **AUDIT_DIR_TEMPLATE** = `.aris/env-config/<project>`
- **CONFIG_VERSION** = 1
- **DEFAULT_EXCLUDES** = `.git, __pycache__, results/, logs/, checkpoints/, *.pt, *.ckpt, data/`
- **DEFAULT_FAILURE_PATTERNS** = `Traceback`, `CUDA out of memory`, `Killed`, `AssertionError`, `RuntimeError`, `No such file`
- **MAX_VERIFY_RETRIES** = 3
- **MAX_AUDIT_ROUNDS** = 2
- **REVIEWER_BACKEND** = `codex` (override with `— reviewer: oracle-pro|manual`)

## Critical Rules

1. **Never write to the ARIS repo.** Every artifact goes under the project's
   `.claude/skills/run-<project>-experiment/`. The environment is project data.
2. **Idempotent by default.** Existing `SKILL.md` + no `— reconfigure` = verify
   and stop. This is the property that makes later rounds fully automatic.
3. **Never guess a run command.** In non-interactive mode, an underivable
   required answer produces `status: "incomplete"` and a hard stop. A guessed
   command wastes GPU hours and produces results that look real.
4. **Prefer an existing backend.** If `local`/`remote`/`vast`/`modal`/`docker`
   covers the environment, set `backend_hint` and call `env-helper.js` from the
   generated scripts. Only fall back to `custom` direct commands when none fits.
5. **Reuse analysis before generating it.** `/analyze-results` and existing
   project scripts come first; generate new analysis code only when neither fits.
6. **The primary metric key must match `CLAUDE.md` `## Metric Target`.** A
   mismatch silently breaks every downstream Type-A stop check. Verify in Phase 6.
7. **Every generated script supports `--dry-run`** and is verified with it before
   this skill reports success.
8. **File-paths-only receipts.** The generated skill writes
   `.aris/runs/<run_id>.experiment.<exp_name>.done.json`; the dispatching parent
   reads that file, never the agent's prose.
9. **No promotion without a passing cross-model verdict.** The bundle is drafted
   in staging and copied into `.claude/skills/` only after Phase 5.5 returns
   `pass` or `warn`. Passing Phase 6 steps 1–3 is necessary and **not** sufficient
   — those are Type-A checks and cannot answer "is this configuration trustworthy".
10. **Never self-judge the audit result.** This skill may verify that the audit
    *ran* (Type-A) and must read `overall_verdict` verbatim (Type-B). It must not
    reinterpret, average, override, or re-run-until-favourable a verdict. At most
    `MAX_AUDIT_ROUNDS` audits, each after a real repair, each a fresh reviewer.
11. **The audit stays advisory to everyone else.** `/experiment-audit`'s own
    "never blocks" contract is untouched; the block is implemented here, in the
    caller. Do not edit `/experiment-audit` to halt pipelines — other flows
    depend on it continuing.

## External dependencies (reused, not modified)

- `src/tools/experiment-env/env-helper.ts` — `provision | sync | deploy | monitor | collect | destroy`.
  Used by generated scripts when `backend_hint != "custom"`.
- `src/tools/experiment-env/parse-env.ts` — `ENV_TYPES` / `ENV_SCHEMAS`; read to
  decide whether an existing backend covers the environment.
- `skills/experiment-audit/SKILL.md` — the Phase 5.5 auditor. Invoked as a paseo
  sub-agent; its non-blocking contract is respected (this skill blocks, not it).
- `skills/analyze-results/SKILL.md` — the default analysis implementation.
- `skills/run-experiment/SKILL.md` — the transport-level runner; the generated
  skill wraps it rather than replacing it.
- `skills/shared-references/acceptance-gate.md` — DRIVE/ACQUIT; the Type-A /
  Type-B split that Phase 5.5 implements.
- `skills/shared-references/reviewer-independence.md` — why the auditor reads the
  files itself and receives paths, not this skill's summary of them.
- `skills/shared-references/integration-contract.md` §2 — helper resolution chain.
- `skills/shared-references/paseo-subagent-dispatch.md` — Rule 1 (one agent = one
  skill), Rule 3 (file-paths-only receipts), Rule 4 (Paseo MCP only).
