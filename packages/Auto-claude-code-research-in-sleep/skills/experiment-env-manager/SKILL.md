---
name: experiment-env-manager
description: 'Sole entry point for experiment environment lifecycle: baseline creation, runtime error handling, and on-demand audit. Dispatches /experiment-env-configuration for script generation and /experiment-env-audit for validation. Manages repair loops until the environment passes or requires human intervention. Use when user says "set up experiment environment", "fix experiment env", "env error", "环境管理", "环境出错", "configure environment", or when experiment agents report environment failures.'
argument-hint: "[— project: <name>] [— mode: setup|error-report|audit] [— error-report: <path>]"
allowed-tools: Bash(*), Read, Write, Grep, Glob, AskUserQuestion, WebSearch, mcp__paseo__create_agent, mcp__paseo__send_agent_prompt, mcp__paseo__wait_for_agent, mcp__paseo__archive_agent, mcp__paseo__list_agents, mcp__paseo__get_agent_status, mcp__paseo__list_pending_permissions, mcp__paseo__respond_to_permission
---

> **Paseo dispatch contract (Rules 1-5).** This skill is a thin orchestrator.
> It dispatches `/experiment-env-configuration` for all script generation and
> `/experiment-env-audit` for all validation via `mcp__paseo__create_agent` --
> never the host `Skill` / `Agent` / `Task` tools. It writes PRD, patch, and
> state files. It never generates experiment scripts, never judges audit
> verdicts, and never summarizes worker output. Every sub-skill invocation is
> a separate paseo agent (Rule 1: One Agent = One Skill; Rule 4: Paseo MCP
> Only, Strict; Rule 5: Bounded Context via State File).
>
> See: `shared-references/paseo-subagent-dispatch.md`,
> `shared-references/worker-manifest.md`

> **Sole entry point.** All environment initialization, repair, and audit
> requests go through this skill. No downstream skill dispatches
> `/experiment-env-configuration` or `/experiment-env-audit` directly.

# Experiment Environment Manager

Manage the experiment environment for: **$ARGUMENTS**

## Purpose

Experiment environments break in three distinct ways at three distinct times:

1. **Setup** -- first-time configuration before any experiment runs.
2. **Runtime error** -- a running experiment hits an environment failure
   (SSH dropped, conda broken, stale build artifact).
3. **Drift** -- the environment worked yesterday but something changed.

Each case needs different diagnosis, different repair, and a different
verification bar. This skill is the single dispatcher for all three. It
owns the repair loop and the escalation path; the two worker skills
(`/experiment-env-configuration` and `/experiment-env-audit`) own script
generation and verdict production respectively.

```
Mode A: Setup        User / /research-setup / /auto-research-loop Phase 0
Mode B: Error Report /run-experiment / /experiment-bridge / /experiment-queue
Mode C: Audit        User wanting a diagnostic
```

## Slug Algorithm

All project slug derivation in this skill and all callers uses this algorithm:

```bash
PROJECT_NAME=$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-//; s/-$//')
```

`Foo__Bar!` → `foo-bar` (consecutive non-alphanumerics collapse to one `-`,
leading/trailing `-` stripped). This matches env-configuration's algorithm.

## Dispatch Pattern

Every sub-skill dispatch follows the same cycle. Each mode section below
specifies what differs (inputs, dispatch prompt, post-processing).

```
1. Write state to .aris/env-config/<project>/env-manager-state.json

2. Dispatch via mcp__paseo__create_agent:
   title:          "env-<mode>: <project> round <N>"
   provider:       "claude/claude-sonnet-4-6"
   initialPrompt:  "/<skill-name> <arguments>"
   notifyOnFinish: true

3. Wait for completion notification.

4. Read receipt file (file path only -- never the agent's prose).

5. Archive the worker: mcp__paseo__archive_agent
   (用完即 archive -- Rule 1)

6. Update env-manager-state.json with results.
```

---

## Phase 0: Pre-flight (shared across all modes)

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 1
```

1. **Derive project slug** using the slug algorithm above.
   Override with `— project: <name>`.

2. **Set paths.**
   ```
   SKILL_DIR=".claude/skills/run-<project>-experiment"
   CONFIG_DIR=".aris/env-config/<project>"
   STATE_FILE="$CONFIG_DIR/env-manager-state.json"
   ```

3. **Initialize state file.**
   ```bash
   mkdir -p "$CONFIG_DIR"
   ```
   Write `env-manager-state.json`:
   ```json
   {
     "project": "<project>",
     "mode": "<parsed from arguments>",
     "status": "running",
     "prd_path": null,
     "config_dispatches": 0,
     "audit_dispatches": 0,
     "current_round": 0,
     "dispatch_timestamp": null,
     "last_action": "phase-0-preflight",
     "updated_at": "<ISO-8601>"
   }
   ```

4. **Parse mode.** Default to `setup` if `— mode` is absent.
   - `— mode: setup` --> Mode A
   - `— mode: error-report` --> Mode B (requires `— error-report: <path>`)
   - `— mode: audit` --> Mode C

5. **Detect existing config.**
   ```bash
   if [ -f "$SKILL_DIR/env.json" ]; then
       EXISTING_STATUS=$(jq -r '.status' "$SKILL_DIR/env.json")
   fi
   ```

---

## Mode A: Setup

Triggered by: user, `/research-setup`, `/auto-research-loop` Phase 0.

### Phase 1: Collect Requirements — Complete PRD Generation

This phase asks the user all questions needed to produce a complete PRD.
Every field in the PRD must be filled — env-configuration cannot ask the user.

**Seed sources** (read before asking questions to pre-fill defaults):
- `CLAUDE.md` `## Experiment Environment` section
- `.aris/setup-state.json` (from `/research-setup`)
- `refine-logs/EXPERIMENT_TRACKER.md` (commands that actually worked)
- `skills/experiment-env-configuration/references/index.md` (prior experience)

```bash
# Harvest context (all optional -- missing files are skipped)
CLAUDE_MD_ENV=$(awk '/^## Experiment Environment/,/^## [^#]/' CLAUDE.md 2>/dev/null)
SETUP_STATE=$(cat .aris/setup-state.json 2>/dev/null)
TRACKER=$(cat refine-logs/EXPERIMENT_TRACKER.md 2>/dev/null)
PRIOR_EXP=$(cat skills/experiment-env-configuration/references/index.md 2>/dev/null)
```

#### Step 1.1 — Environment Overview

`AskUserQuestion` — header: "环境描述" / "Environment"
question: "请描述你的实验环境 CLI 使用方式（如何连接、在哪里运行、用什么工具）"
(en): "Describe your experiment environment CLI workflow (how to connect, where it runs, what tools)"

After answer: search `references/index.md` for matching prior experience.
If match found, ask user whether to reuse it.

#### Step 1.2 — File Location

`AskUserQuestion` — header: "Location"
question: "Where do experiments actually execute?"
options: `["本机 (local)"]` / `["远程 SSH 服务器"]` / `["Docker 容器"]` / Other

`AskUserQuestion` — header: "Remote path"
question: "Absolute path on the execution machine where code must live?"
(skip if local)

`AskUserQuestion` — header: "Transfer"
question: "How does code get from here to there?"
options: `["rsync"]` / `["git push/pull"]` / `["Shared filesystem"]` / Other
(skip if local)

`AskUserQuestion` — header: "Excludes"
question: "Which paths must NOT be transferred?"
Seed: `["data/", "checkpoints/", "__pycache__/", ".git/", "*.pyc"]`

When location is "远程 SSH 服务器" (remote):

`AskUserQuestion` — header: "SSH Alias"
question: "SSH alias or hostname for the remote server? (from ~/.ssh/config or raw host)"
Seed: read from `~/.ssh/config` host entries or CLAUDE.md

Record as `preparation.files.ssh_alias` in the PRD. This field flows through
to env-configuration → env.json → info.sh `connection.ssh_alias` → experiment-queue.

#### Step 1.3 — Dependency Environment

`AskUserQuestion` — header: "Env type"
question: "What provides the dependency environment?"
options: `["conda"]` / `["venv"]` / `["Docker/container"]` / `["System packages"]` / Other

`AskUserQuestion` — header: "Env name"
question: "Environment name or activation path?"

`AskUserQuestion` — header: "Activation"
question: "Exact activation line (including conda hook if needed)?"
Seed: probe via `ssh <host> 'conda env list'` or local detection

`AskUserQuestion` — header: "Verify"
question: "One command that proves the environment is usable?"
Seed: `python -c "import torch; print(torch.__version__, torch.cuda.is_available())"`

`AskUserQuestion` — header: "Build"
question: "What build/install steps are needed after code is synced? (Leave blank if code runs directly)"
options: `["无需构建"]` / Other

#### Step 1.4 — Compute Resources

`AskUserQuestion` — header: "Compute Resource"
question: "实验调度到什么类型的计算资源上？"
options: `["GPU 显卡"]` / `["集群节点"]` / `["CPU 核心"]` / Other

Auto-detect:
- GPU: run `nvidia-smi --query-gpu=index,name --format=csv,noheader` on target
- CPU: run `nproc` on target
- Cluster: ask for node list or `scontrol show nodes`

Present detected config for confirmation.

For GPU resources, auto-fill and present for confirmation:
- `bind_env: "CUDA_VISIBLE_DEVICES"`, `bind_mode: "env"`
- `free_check: { "cmd": "nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits", "threshold": 500, "unit": "MiB", "compare": "lt", "index_by": "physical" }`
- `exhaustion_patterns: ["CUDA out of memory", "torch.OutOfMemoryError"]`
- `label: "<from nvidia-smi detection>"`

For CPU: `bind_env: "taskset -c"`, `bind_mode: "prefix"`, `free_check: null`,
`exhaustion_patterns: []`. Construct `ids` from `nproc`:
```bash
CPU_COUNT=$(nproc)
# ids = [0, 1, ..., CPU_COUNT-1]
```
Present for confirmation.

For node: ask user for bind mechanism, probe command, and exhaustion patterns.
Collect ALL `free_check` members or explicitly set `free_check: null`:
```
AskUserQuestion — header: "Node probe"
question: "Command to check if a node is free? (leave blank if none)"
If non-blank:
  AskUserQuestion — header: "Threshold"
  question: "Threshold value for free check?"
  AskUserQuestion — header: "Unit"
  question: "Unit for the threshold value? (e.g., MiB, %, count)"
  AskUserQuestion — header: "Compare"
  question: "How to compare against threshold?"
  options: ["lt (less than)", "gt (greater than)", "eq (equal)"]
  → compose free_check: { cmd, threshold, unit, compare, index_by: "positional" }
If blank:
  → free_check: null
```

For custom: ask user for all resource fields explicitly. Collect the full
`free_check` object or explicitly set it to `null`. Do not emit `{}`.

#### Step 1.5 — Run Command

`AskUserQuestion` — header: "Entry point"
question: "Script or module that runs one experiment?"
Seed: grep EXPERIMENT_TRACKER for the last successful command

`AskUserQuestion` — header: "Arguments"
question: "How are experiment parameters passed?"
options: `["CLI flags (--seed 42)"]` / `["Config file (config.yaml)"]` / `["Environment vars"]` / Other

`AskUserQuestion` — header: "Launch mode"
question: "How is a long run kept alive?"
options: `["screen"]` / `["nohup"]` / `["Scheduler (SLURM/PBS)"]` / `["Foreground"]`

`AskUserQuestion` — header: "GPU selection"
question: "How is the GPU chosen?"
options: `["CUDA_VISIBLE_DEVICES"]` / `["Scheduler-assigned"]` / `["All available"]` / `["CPU only"]`

Compose the run template using the generator's `{{...}}` placeholder syntax.
The template MUST include `{{activation}}`, `{{remote_path}}` (if remote),
`{{entry_point}}`, `{{exp_name}}`, and `{{args}}`. Include `{{gpu}}` when
GPU binding is used.

Example:
```
{{activation}} && cd {{remote_path}} && CUDA_VISIBLE_DEVICES={{gpu}} \
  screen -dmS {{exp_name}} bash -c '{{entry_point}} {{args}} 2>&1 | tee logs/{{exp_name}}.log'
```

#### Step 1.6 — Error Collection

`AskUserQuestion` — header: "Failure signal"
question: "How do you know a run failed?"
options: `["Non-zero exit code"]` / `["Error pattern in log"]` / `["Both"]`

`AskUserQuestion` — header: "Task type"
question: "What type of experiment task? (e.g., PyTorch training, inference, data processing)"

WebSearch: `"<task_type> common error patterns failure modes"`
Parse results to extract known error patterns.

`AskUserQuestion` — header: "Error patterns"
question: "以下是合并后的错误模式列表（来自你的输入 + 搜索结果）。需要增减吗？\n<list>"
Present merged list (user input + web search) for confirmation.

Also ask for log path: `AskUserQuestion` — header: "Log path"
question: "Where does the run write its log?"
Seed: `logs/${EXP_NAME}.log`

#### Step 1.7 — Result Collection

`AskUserQuestion` — header: "Result file"
question: "Where does the run write its metrics?"
Seed: `results/${EXP_NAME}.json`

`AskUserQuestion` — header: "Format"
question: "What format?"
options: `["JSON"]` / `["CSV"]` / `["Parsed from log"]` / `["W&B"]`

`AskUserQuestion` — header: "Primary metric"
question: "Which key is the headline metric?"

#### Step 1.8 — Analysis

`AskUserQuestion` — header: "Analysis"
question: "实验结果需要什么样的分析？"
options: `["Compare against baseline"]` / `["Aggregate across seeds"]` / `["Custom analysis script"]`

`AskUserQuestion` — header: "Analysis logic"
question: "What comparison or test is required?"

`AskUserQuestion` — header: "Output"
question: "Where does the analysis artifact go?"
Seed: `analysis/comparison.md`

#### Step 1.9 — Baseline info

`AskUserQuestion` — header: "Baseline"
question: "Is there an existing baseline run, or should we create a mock?"
options: `["Existing baseline (in EXPERIMENT_TRACKER)"]` / `["Create mock baseline"]`

#### Step 1.10 — Write PRD

Assemble the complete PRD JSON (full schema, all fields filled):

```json
{
  "version": 1,
  "mode": "fresh",
  "project": "<project>",
  "preparation": {
    "files": {
      "location": "...",
      "remote_path": "...",
      "transfer": "...",
      "excludes": ["..."],
      "ssh_alias": "<collected in Step 1.2, or null for local>"
    },
    "environment": { "type": "...", "name": "...", "activation": "...", "build_cmd": "...", "verify_cmd": "..." }
  },
  "resources": {
    "type": "...", "ids": ["..."], "label": "...",
    "bind_env": "...", "bind_mode": "...",
    "free_check": { "cmd": "...", "threshold": 500, "unit": "MiB", "compare": "lt", "index_by": "physical" },
    "exhaustion_patterns": ["..."]
  },
  "run": { "entry_point": "...", "arg_style": "...", "launch_mode": "...", "gpu_selection": "...", "template": "..." },
  "feedback": {
    "error": { "signal": "...", "log_path": "...", "task_type": "...", "failure_patterns": ["..."] },
    "result": { "path_template": "...", "format": "...", "primary_metric_key": "...", "extra_keys": ["..."] },
    "analysis": { "mode": "...", "logic": "...", "output_path": "..." }
  },
  "baseline": { "kind": "real|mock", "evidence_source": "..." }
}
```

Write to `$CONFIG_DIR/prd.json`.

If existing config is present and `— mode: setup` was explicit (not a
re-entry from error-report), set `"mode": "fresh"`.

Update state: `last_action: "phase-1-prd-written"`.

### Phase 2: Dispatch /experiment-env-configuration

Record the dispatch timestamp for stale-verdict prevention:
```bash
DISPATCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

```
mcp__paseo__create_agent
  title:          "env-config: <project>"
  provider:       "claude/claude-sonnet-4-6"
  initialPrompt:  |
    /experiment-env-configuration — project: <project> — prd: <CONFIG_DIR>/prd.json

    This dispatch comes from /experiment-env-manager. Read the PRD file
    for the complete requirements (all fields are filled — no interactive
    Q&A needed). Generate the experiment skill bundle.
  notifyOnFinish: true
```

Wait --> read receipt --> archive.

Update state: `config_dispatches += 1`, `dispatch_timestamp: "$DISPATCH_TS"`,
`last_action: "phase-2-config-dispatched"`.

### Phase 3: Read env-configuration receipt

```bash
RECEIPT=$(ls -t .aris/runs/*.experiment-env-configuration.${PROJECT}.done.json 2>/dev/null | head -1)
test -f "$RECEIPT" || {
    echo "ERROR: env-configuration did not produce a receipt."
    # Update state: status = "failed"
    exit 1
}
jq -e '.status' "$RECEIPT" >/dev/null || {
    echo "ERROR: receipt is not valid JSON."
    exit 1
}
```

If `status` is `"pending_audit"` (expected), proceed to Phase 4.
If `status == "failed"`, stop and report.

Update state: `last_action: "phase-3-config-receipt-read"`.

### Phase 4: Dispatch /experiment-env-audit

Record the dispatch timestamp and clear stale audit output:
```bash
AUDIT_DISPATCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Clear stale audit files before dispatch — defense in depth with audit's own clearing
rm -f "$CONFIG_DIR/ENV_CONFIG_AUDIT.md" \
      "$CONFIG_DIR/ENV_CONFIG_AUDIT.json" \
      "$CONFIG_DIR/ENV_CONFIG_AUDIT_STRUCTURED.json"
```

```
mcp__paseo__create_agent
  title:          "env-audit: <project> round <current_round>"
  provider:       "claude/claude-sonnet-4-6"
  initialPrompt:  |
    /experiment-env-audit — project: <project> — target: promoted — report-format: structured

    Audit the experiment environment configuration at:
      Bundle:  .claude/skills/run-<project>-experiment/
      Config:  .claude/skills/run-<project>-experiment/env.json

    Write the structured verdict to:
      .aris/env-config/<project>/ENV_CONFIG_AUDIT_STRUCTURED.json

    Reply with the file paths only.
  notifyOnFinish: true
```

Wait --> read receipt --> archive.

Update state: `audit_dispatches += 1`, `last_action: "phase-4-audit-dispatched"`.

### Phase 5: Repair Loop

**No fixed upper limit.** The loop terminates only on resolution.

```
WHILE TRUE:
  1. Read and validate verdict:
     AUDIT_JSON="$CONFIG_DIR/ENV_CONFIG_AUDIT_STRUCTURED.json"

     # Verify the verdict is not stale — audited_at must be strictly after dispatch
     AUDITED_AT=$(jq -r '.audited_at // empty' "$AUDIT_JSON")
     if [ -z "$AUDITED_AT" ]; then
       echo "ERROR: audit verdict has no audited_at timestamp. Re-dispatching..."
       → Re-dispatch env-audit (Phase 4) and continue loop.
     fi
     if [ -n "$AUDIT_DISPATCH_TS" ]; then
       # Strictly greater than — equal means the verdict was not produced after dispatch
       if [ "$AUDITED_AT" \< "$AUDIT_DISPATCH_TS" ] || [ "$AUDITED_AT" = "$AUDIT_DISPATCH_TS" ]; then
         echo "ERROR: audit verdict is stale (audited_at=$AUDITED_AT <= dispatch=$AUDIT_DISPATCH_TS)"
         echo "Re-dispatching audit..."
         → Re-dispatch env-audit (Phase 4) and continue loop.
       fi
     fi

     # If patch-id was provided, verify the audit echoed it
     if [ -n "$CURRENT_PATCH_ID" ]; then
       ECHOED_PATCH_ID=$(jq -r '.patch_id // empty' "$AUDIT_JSON")
       if [ "$ECHOED_PATCH_ID" != "$CURRENT_PATCH_ID" ]; then
         echo "ERROR: audit verdict patch_id mismatch (expected=$CURRENT_PATCH_ID, got=$ECHOED_PATCH_ID)"
         → Re-dispatch env-audit with correct patch-id and continue loop.
       fi
     fi

     VERDICT=$(jq -r '.overall_verdict' "$AUDIT_JSON" | tr 'A-Z' 'a-z')

  2. Route on verdict:

     CASE "pass" | "warn":
       → Break loop. Proceed to Phase 6 (finalize).

     CASE "fail":
       Read auto-fixable flag:
       AUTO_FIX=$(jq -r '.auto_fixable // false' "$AUDIT_JSON")

       IF auto_fixable == true:
         a. **Collect failing checks with their per-check targets.**
            ```bash
            # Extract each failing check's fix_hint and patch_targets
            FAILING_CHECKS=$(jq -r '
              [.checks | to_entries[]
               | select(.value.status == "fail")
               | {
                   check: .key,
                   fix_hint: .value.fix_hint,
                   patch_targets: .value.patch_targets,
                   action_item: .value.action_item
                 }
              ]' "$AUDIT_JSON")
            ```

         b. **Derive concrete patch values from per-check fix hints.**

            For each failing check:
            1. Read that check's `patch_targets[]` (per-check, not top-level)
            2. For each target field, read the current value from env.json:
               ```bash
               CURRENT=$(jq -r ".$FIELD_PATH" "$SKILL_DIR/env.json")
               ```
            3. Interpret the fix_hint to derive the new concrete value.
               Common patterns:
               - "add X to Y" → if current is empty, value = "X"; if current exists, value = "current && X"
               - "append X to Y" → action = "append", value = ["X"]
               - "change X to Y" → value = "Y"
               - "remove X" → value = "" or null
            4. Write each as a `changes[]` entry with the concrete value.

            The manager MUST verify each derived value is concrete (not prose,
            not a placeholder like "MANAGER_MUST_DERIVE"). If a fix_hint cannot
            be mechanically translated → mark that check as not auto-fixable
            and continue with the rest. If ALL checks are not auto-fixable →
            set `auto_fixable = false` and fall through to user escalation.

         c. Write patch file to $CONFIG_DIR/patch-round-<N>.json
            matching the generator's required schema:
            ```json
            {
              "mode": "patch",
              "project": "<project>",
              "patch_id": "<generated uuid>",
              "changes": [
                { "field": "<from check's patch_targets>", "value": "<concrete derived value>", "action": "set" }
              ],
              "reason": "<aggregated action_items from failing checks>"
            }
            ```

         d. Dispatch /experiment-env-configuration (patch mode):
            mcp__paseo__create_agent
              title:          "env-config-patch: <project> round <N>"
              provider:       "claude/claude-sonnet-4-6"
              initialPrompt:  |
                /experiment-env-configuration — project: <project> — patch: <CONFIG_DIR>/patch-round-<N>.json

                Apply the patch described in the patch file. Do not re-run
                interactive Q&A. Fix only the items listed in changes[].
              notifyOnFinish: true

            Wait → archive.

         e. Dispatch /experiment-env-audit again (fresh agent, with patch-id):
            CURRENT_PATCH_ID=<the patch_id from the patch file>
            AUDIT_DISPATCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

            mcp__paseo__create_agent
              title:          "env-audit: <project> round <N>"
              provider:       "claude/claude-sonnet-4-6"
              initialPrompt:  |
                /experiment-env-audit — project: <project> — target: promoted — report-format: structured — patch-id: <CURRENT_PATCH_ID>
              notifyOnFinish: true

            Wait → archive.

         f. **Progress guard:** before looping, compare the new verdict's
            failing checks against the previous round's. If the same checks
            fail with the same `fix_hint` values, the auto-fix is not making
            progress → set `auto_fixable = false` and fall through to user
            escalation below.

         g. current_round += 1
            Update state: config_dispatches, audit_dispatches, current_round
            → Loop back to step 1.

       ELSE (auto_fixable == false):
         Escalate to user:
         AskUserQuestion:
           header: "审计失败 — 需要人工介入"
           question: |
             环境审计失败且无法自动修复。

             失败项：
             <list failing checks from AUDIT_JSON>

             详细报告：$CONFIG_DIR/ENV_CONFIG_AUDIT.md

             请选择操作：
           options:
             - "我来指导修复" → user provides direction
             - "强制部署（标记 user_override）" → mark and proceed
             - "终止" → abort

         Route on user choice:
           "我来指导修复":
             Read user's direction (free text follow-up).
             Construct patch with user guidance:
             - Generate a patch_id (uuid)
             - Write `changes[]` based on user direction
             - Write to $CONFIG_DIR/patch-user-<N>.json

             Dispatch env-configuration (patch mode) → wait → archive.

             Then dispatch env-audit with the patch-id:
             CURRENT_PATCH_ID=<patch_id from the user-guided patch>
             AUDIT_DISPATCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

             mcp__paseo__create_agent
               title:          "env-audit: <project> re-audit after user fix"
               provider:       "claude/claude-sonnet-4-6"
               initialPrompt:  |
                 /experiment-env-audit — project: <project> — target: promoted — report-format: structured — patch-id: <CURRENT_PATCH_ID>
               notifyOnFinish: true

             Wait → archive → loop back to step 1.

           "强制部署（标记 user_override）":
             Mark override in state: result = "user_override"
             → Break loop. Proceed to Phase 6 (finalize with override).

           "终止":
             Update state: status = "failed", result = "aborted"
             Write receipt with result = "aborted". STOP.

     CASE missing / unparseable:
       "ERROR: audit did not produce a structured verdict."
       Update state: status = "failed"
       STOP.
```

### Phase 6: Finalize

This is the **only place in the entire system** that transitions env.json
status from `pending_audit` to `complete`. Neither env-configuration nor
env-audit writes `complete`.

1. **Flip status atomically:**
   ```bash
   SKILL_DIR=".claude/skills/run-${PROJECT}-experiment"
   # Create temp file adjacent to env.json (same filesystem = atomic mv)
   tmp="$SKILL_DIR/env.json.tmp.$$"
   jq --arg v "$VERDICT" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.status = "complete" | .audit = { "verdict": $v, "audited_at": $t }' \
     "$SKILL_DIR/env.json" > "$tmp" && mv "$tmp" "$SKILL_DIR/env.json"
   ```

   When the verdict was "user_override" (forced deploy), write a distinct
   status so downstream consumers can distinguish:
   ```bash
   jq --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.status = "complete" | .audit = { "verdict": "user_override", "audited_at": $t }' \
     "$SKILL_DIR/env.json" > "$tmp" && mv "$tmp" "$SKILL_DIR/env.json"
   ```

2. Write receipt to `.aris/runs/<run_id>.experiment-env-manager.<project>.done.json`:

   ```json
   {
     "skill": "experiment-env-manager",
     "project": "<project>",
     "mode": "setup",
     "result": "complete|user_override",
     "skill_dir": ".claude/skills/run-<project>-experiment",
     "audit_verdict": "pass|warn|fail",
     "repair_rounds": 0,
     "config_dispatches": 1,
     "audit_dispatches": 1,
     "completed_at": "<ISO-8601>"
   }
   ```

3. Update `CLAUDE.md` `## Experiment Skill` section (if present) with the
   skill directory path and audit status.

4. Update state: `status = "completed"`, `last_action: "phase-6-finalized"`.

---

## Mode B: Error Report

Triggered by: `/run-experiment`, `/experiment-bridge`, `/experiment-queue`
when they encounter environment errors.

### Phase 0B: Read Error Report

```bash
ERROR_REPORT="<path from — error-report argument>"
test -f "$ERROR_REPORT" || {
    echo "ERROR: error report not found at $ERROR_REPORT"
    exit 1
}
```

Expected error report schema (flat format written by downstream skills):

```json
{
  "skill": "<skill-name>",
  "project": "<project>",
  "error_type": "prepare_failed|run_failed|collect_failed|info_failed",
  "script": "prepare.sh|run.sh|collect.sh|info.sh",
  "exit_code": 1,
  "stderr_tail": ["line 1", "line 2", "...last 20 lines"],
  "failure_patterns_matched": [],
  "attempts": 1,
  "context": { "last_code_change": "...", "last_successful_run": "..." },
  "timestamp": "<ISO-8601>"
}
```

**Adapter for worker-manifest receipts:** if the error report has a nested
`error` object (worker-manifest format with `error.category`, `error.message`,
`error.recoverable`), normalize it to the flat canonical shape:
```bash
# Detect nested format
if jq -e '.error.category' "$ERROR_REPORT" >/dev/null 2>&1; then
  # Map nested category to flat error_type
  NESTED_CAT=$(jq -r '.error.category' "$ERROR_REPORT")
  case "$NESTED_CAT" in
    env_error)   ERROR_TYPE="prepare_failed" ;;
    code_error)  ERROR_TYPE="code_error" ;;
    infra_error) ERROR_TYPE="infra_error" ;;
    *)           ERROR_TYPE="unknown" ;;
  esac
  STDERR_TAIL=$(jq -c '.error.stderr_tail // []' "$ERROR_REPORT")
  EXIT_CODE=$(jq -r '.error.exit_code // 1' "$ERROR_REPORT")
  SCRIPT=$(jq -r '.error.script // "unknown"' "$ERROR_REPORT")
  ATTEMPTS=$(jq -r '.error.attempts // 1' "$ERROR_REPORT")
  FAILURE_PATTERNS=$(jq -c '.error.failure_patterns_matched // []' "$ERROR_REPORT")
  RECOVERABLE=$(jq -r 'if .error | has("recoverable") then .error.recoverable else true end' "$ERROR_REPORT")
  MESSAGE=$(jq -r '.error.message // ""' "$ERROR_REPORT")
else
  # Flat format — read directly
  ERROR_TYPE=$(jq -r '.error_type // "unknown"' "$ERROR_REPORT")
  STDERR_TAIL=$(jq -c '.stderr_tail // []' "$ERROR_REPORT")
  EXIT_CODE=$(jq -r '.exit_code // 1' "$ERROR_REPORT")
  SCRIPT=$(jq -r '.script // "unknown"' "$ERROR_REPORT")
  ATTEMPTS=$(jq -r '.attempts // 1' "$ERROR_REPORT")
  FAILURE_PATTERNS=$(jq -c '.failure_patterns_matched // []' "$ERROR_REPORT")
  RECOVERABLE="true"
  MESSAGE=""
fi
```

After normalization, all subsequent classification uses `ERROR_TYPE`,
`STDERR_TAIL`, `EXIT_CODE`, `SCRIPT`, `ATTEMPTS`, `FAILURE_PATTERNS`,
and `RECOVERABLE` — never re-reads the raw error report.

The category mapping:
- `env_error` → `prepare_failed` (routes to env-recoverable classification)
- `code_error` → `code_error` (routes immediately to `not_env_issue`)
- `infra_error` → `infra_error` (routes to unknown/escalation)
- `unknown` → `unknown` (routes to audit diagnosis)

### Phase 1B: Classify Error

Read the `stderr_tail`, `error_type`, and `script` fields. Classify into one
of five categories. Classification is deterministic pattern matching -- not
judgment.

**Pre-classification shortcut from adapter:** if the adapter already produced
a definitive `ERROR_TYPE` from a nested `error.category`:
- `code_error` → immediately classify as **code-bug** (no stderr scan needed)
- `infra_error` → immediately classify as **unknown** (dispatch audit)
- `prepare_failed` / `unknown` / flat format → proceed with pattern matching

**Classification order matters.** Check from most specific to least specific.
An error can match multiple patterns — the first match wins.

| Priority | Category | Patterns (matched against `stderr_tail` lines) | Action |
|---|----------|----------|--------|
| 1 | **signal-kill** | `exit_code` is 137 (OOM kill) or 139 (segfault) | Escalate immediately — do not retry |
| 2 | **transient** | `Connection refused`, `Connection timed out`, `ssh_exchange_identification`, `rate limit`, `Too many requests`, `temporary failure` | Retry `prepare.sh` up to 3 times, 30s delay between |
| 3 | **env-recoverable** | `conda: command not found`, `ModuleNotFoundError`, `No module named`, `CondaError`, `activate: No such file`, `pip: command not found` | Construct patch PRD --> dispatch env-configuration |
| 4 | **build-related** | `ImportError: .*.so`, `undefined symbol`, `version .* mismatch`, `pip install -e .` failure, `make: ***` | Re-run `prepare.sh` (includes build step) |
| 5 | **code-bug** | `Traceback` AND `AssertionError\|TypeError\|ValueError\|KeyError\|AttributeError\|SyntaxError` WITHOUT any env patterns from priorities 2-4 | Return receipt: `{ "result": "not_env_issue" }` |
| 6 | **unknown** | None of the above match | Dispatch env-audit for diagnosis |

Note on priority: `ModuleNotFoundError` includes "Traceback" in its output
but is an environment issue (priority 3), not a code bug (priority 5). The
ordered evaluation ensures env patterns win over generic traceback matching.

Additionally use `error_type` for routing context:
- `prepare_failed` → likely env-recoverable or build-related
- `run_failed` → check `stderr_tail` and `failure_patterns_matched`
- `collect_failed` → likely code-bug or transient
- `info_failed` → likely env-recoverable

Check `failure_patterns_matched` first — if the worker already matched known
patterns, use those directly instead of re-scanning `stderr_tail`.

### Phase 2B: Execute Action

**Signal-kill:**

Write receipt with `result: "escalated"` and the signal info. Do not retry.

**Transient:**

```bash
for ATTEMPT in 1 2 3; do
    sh "$SKILL_DIR/scripts/prepare.sh" && break
    echo "Retry $ATTEMPT failed. Waiting 30s..."
    sleep 30
done
```

**Env-recoverable:**

1. Derive concrete fix values from the error classification and `stderr_tail`.
   Write patch to `$CONFIG_DIR/error-repair-<TS>.json`:
   ```json
   {
     "mode": "patch",
     "project": "<project>",
     "patch_id": "<generated uuid>",
     "changes": [
       { "field": "<target field>", "value": "<concrete fix>", "action": "set" }
     ],
     "reason": "env-manager error-report: <error_type> in <script>"
   }
   ```

2. Dispatch `/experiment-env-configuration` (patch mode):
   ```
   mcp__paseo__create_agent
     title:          "env-config-repair: <project>"
     provider:       "claude/claude-sonnet-4-6"
     initialPrompt:  |
       /experiment-env-configuration — project: <project> — patch: $CONFIG_DIR/error-repair-<TS>.json

       An experiment failed with an environment error. Apply the fix
       described in the patch file. The error report is at:
       <error report path>

       Read the error report for full context. Fix only the failing
       component.
     notifyOnFinish: true
   ```

   Wait --> archive.

3. Dispatch `/experiment-env-audit` with `— patch-id: <patch_id>`:
   ```
   CURRENT_PATCH_ID=<patch_id from the repair patch>
   AUDIT_DISPATCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

   mcp__paseo__create_agent
     title:          "env-audit: <project> post-error-repair"
     provider:       "claude/claude-sonnet-4-6"
     initialPrompt:  |
       /experiment-env-audit — project: <project> — target: promoted — report-format: structured — patch-id: <CURRENT_PATCH_ID>
     notifyOnFinish: true
   ```

   Wait --> archive.

**Build-related:**

```bash
sh "$SKILL_DIR/scripts/prepare.sh"
```

Re-running prepare.sh re-syncs code and re-runs the build step.

**Code-bug:**

No action. Write receipt immediately with `result: "not_env_issue"`.

**Unknown:**

Dispatch `/experiment-env-audit` for diagnosis:

```
AUDIT_DISPATCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mcp__paseo__create_agent
  title:          "env-audit-diagnosis: <project>"
  provider:       "claude/claude-sonnet-4-6"
  initialPrompt:  |
    /experiment-env-audit — project: <project> — target: promoted — report-format: structured

    An experiment failed with an unclassified error. The error report is at:
    <error report path>

    Run a full audit to diagnose whether this is an environment issue.
    Write structured verdict to:
    .aris/env-config/<project>/ENV_CONFIG_AUDIT_STRUCTURED.json
  notifyOnFinish: true
```

Wait --> read structured verdict --> re-classify from the failing checks
--> re-enter Phase 2B with the new classification.

### Phase 3B: Verify Fix

**Trivial fix (transient retry / build rebuild):**

```bash
sh "$SKILL_DIR/scripts/prepare.sh" && sh "$SKILL_DIR/scripts/info.sh" > /dev/null
```

PASS if both exit 0.

**Non-trivial fix (patch):**

Read the structured verdict from the audit dispatched in Phase 2B:

```bash
AUDIT_JSON="$CONFIG_DIR/ENV_CONFIG_AUDIT_STRUCTURED.json"

# Verify verdict is not stale — require non-empty, strictly after dispatch
AUDITED_AT=$(jq -r '.audited_at // empty' "$AUDIT_JSON")
if [ -z "$AUDITED_AT" ]; then
  echo "ERROR: audit verdict has no audited_at. Re-dispatching..."
  # Re-dispatch audit and re-read
fi
if [ -n "$AUDIT_DISPATCH_TS" ]; then
  if [ "$AUDITED_AT" \< "$AUDIT_DISPATCH_TS" ] || [ "$AUDITED_AT" = "$AUDIT_DISPATCH_TS" ]; then
    echo "ERROR: stale audit verdict. Re-dispatching..."
    # Re-dispatch audit and re-read
  fi
fi

# Verify patch-id matches
ECHOED_PATCH_ID=$(jq -r '.patch_id // empty' "$AUDIT_JSON")
if [ "$ECHOED_PATCH_ID" != "$CURRENT_PATCH_ID" ]; then
  echo "ERROR: audit patch_id mismatch."
  # Re-dispatch audit with correct patch-id
fi

VERDICT=$(jq -r '.overall_verdict' "$AUDIT_JSON" | tr 'A-Z' 'a-z')
```

**On audit PASS/WARN after Mode B patch — finalize:**
```bash
# Same finalization as Mode A Phase 6
SKILL_DIR=".claude/skills/run-${PROJECT}-experiment"
tmp="$SKILL_DIR/env.json.tmp.$$"
jq --arg v "$VERDICT" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.status = "complete" | .audit = { "verdict": $v, "audited_at": $t }' \
  "$SKILL_DIR/env.json" > "$tmp" && mv "$tmp" "$SKILL_DIR/env.json"
```

### Phase 4B: Fix Failed?

If verification fails (audit verdict is FAIL after patch):

```
AskUserQuestion:
  header: "修复失败"
  question: |
    环境修复后验证仍然失败。

    原始错误：<error classification>
    修复操作：<action taken>
    验证结果：<failure details>

    请选择：
  options:
    - "我来指导修复" → user provides direction → construct patch → retry
    - "强制标记已修复" → mark as fixed with override → finalize
    - "标记为非环境问题" → result = "not_env_issue"
    - "终止" → abort
```

When user chooses "我来指导修复":
- Read user direction
- Construct patch with `patch_id`, `changes[]`, `reason`
- Dispatch env-configuration (patch mode) → wait → archive
- Dispatch env-audit with `— patch-id: <patch_id>` → wait → archive
- Re-read verdict → loop back to Phase 3B

When user chooses "强制标记已修复":
- Finalize with `user_override` status (same as Mode A)

### Phase 5B: Write Receipt

```json
{
  "skill": "experiment-env-manager",
  "project": "<project>",
  "mode": "error-report",
  "result": "fixed|not_env_issue|escalated|aborted|user_override",
  "error_category": "signal-kill|transient|env-recoverable|build-related|code-bug|unknown",
  "repair_action": "<description of what was done>",
  "repair_rounds": 0,
  "error_report_path": "<original error report path>",
  "completed_at": "<ISO-8601>"
}
```

---

## Mode C: Audit

Triggered by: user wanting a diagnostic check of the current environment.

### Phase 0C: Resolve Project

Same as Phase 0 shared logic. Verify existing config:

```bash
test -f "$SKILL_DIR/env.json" || {
    echo "ERROR: No experiment environment configured for project <project>."
    echo "Run /experiment-env-manager — mode: setup first."
    exit 1
}
```

### Phase 1C: Dispatch /experiment-env-audit

```
AUDIT_DISPATCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mcp__paseo__create_agent
  title:          "env-audit: <project> (on-demand)"
  provider:       "claude/claude-sonnet-4-6"
  initialPrompt:  |
    /experiment-env-audit — project: <project> — target: promoted — report-format: structured

    On-demand environment audit requested by user.
    Bundle: .claude/skills/run-<project>-experiment/
    Config: .claude/skills/run-<project>-experiment/env.json

    Write structured verdict to:
    .aris/env-config/<project>/ENV_CONFIG_AUDIT_STRUCTURED.json
    Write human-readable report to:
    .aris/env-config/<project>/ENV_CONFIG_AUDIT.md

    Reply with the file paths only.
  notifyOnFinish: true
```

Wait --> archive.

### Phase 2C: Relay Verdict

```bash
AUDIT_JSON="$CONFIG_DIR/ENV_CONFIG_AUDIT_STRUCTURED.json"

# Verify freshness — require non-empty, strictly after dispatch
AUDITED_AT=$(jq -r '.audited_at // empty' "$AUDIT_JSON")
if [ -z "$AUDITED_AT" ]; then
  echo "ERROR: audit verdict has no audited_at. Re-dispatching..."
  # Re-dispatch and re-read
fi
if [ -n "$AUDIT_DISPATCH_TS" ]; then
  if [ "$AUDITED_AT" \< "$AUDIT_DISPATCH_TS" ] || [ "$AUDITED_AT" = "$AUDIT_DISPATCH_TS" ]; then
    echo "ERROR: stale verdict. Re-dispatching..."
    # Re-dispatch and re-read
  fi
fi

VERDICT=$(jq -r '.overall_verdict' "$AUDIT_JSON" | tr 'A-Z' 'a-z')
```

Print summary to user:

```
环境审计完成。

判定：<VERDICT>
详细报告：$CONFIG_DIR/ENV_CONFIG_AUDIT.md
结构化报告：$CONFIG_DIR/ENV_CONFIG_AUDIT_STRUCTURED.json

<if WARN: list warn checks>
<if FAIL: list failing checks>
```

### Phase 3C: Repair Loop (if FAIL)

If `VERDICT == "fail"`, enter the same repair loop as Mode A Phase 5.
The loop logic is identical — extract `auto_fixable`, per-check `fix_hint`
and `patch_targets`, dispatch patch + re-audit, or escalate to user.

**After a successful repair (PASS/WARN), explicitly finalize:**

Run the same Phase 6 finalization as Mode A:
```bash
SKILL_DIR=".claude/skills/run-${PROJECT}-experiment"
tmp="$SKILL_DIR/env.json.tmp.$$"
jq --arg v "$VERDICT" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.status = "complete" | .audit = { "verdict": $v, "audited_at": $t }' \
  "$SKILL_DIR/env.json" > "$tmp" && mv "$tmp" "$SKILL_DIR/env.json"
```

This ensures a Mode C patch does not leave the bundle at `pending_audit`.

### Phase 4C: Write Receipt

```json
{
  "skill": "experiment-env-manager",
  "project": "<project>",
  "mode": "audit",
  "result": "complete|fixed|escalated|aborted|user_override",
  "audit_verdict": "pass|warn|fail",
  "repair_rounds": 0,
  "completed_at": "<ISO-8601>"
}
```

---

## State Management

`$CONFIG_DIR/env-manager-state.json` (~200 tokens):

```json
{
  "project": "<project>",
  "mode": "setup|error-report|audit",
  "status": "running|waiting_for_config|waiting_for_audit|completed|failed|escalated",
  "prd_path": ".aris/env-config/<project>/prd.json",
  "config_dispatches": 0,
  "audit_dispatches": 0,
  "current_round": 0,
  "dispatch_timestamp": "<ISO-8601 of last audit dispatch>",
  "last_action": "<phase-N-description>",
  "updated_at": "<ISO-8601>"
}
```

Update this file after every phase transition. A crashed or resumed
env-manager reads the state file to determine where to continue.

---

## Receipt Format

All modes write to `.aris/runs/<run_id>.experiment-env-manager.<project>.done.json`.

```json
{
  "skill": "experiment-env-manager",
  "project": "<project>",
  "mode": "setup|error-report|audit",
  "result": "complete|fixed|not_env_issue|escalated|aborted|user_override",
  "skill_dir": ".claude/skills/run-<project>-experiment",
  "audit_verdict": "pass|warn|fail|null",
  "repair_rounds": 0,
  "completed_at": "<ISO-8601>"
}
```

This is the file a dispatching parent reads (`paseo-subagent-dispatch.md`
Rule 3, file-paths-only receipts).

---

## Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `SKILL_DIR_TEMPLATE` | `.claude/skills/run-<project>-experiment` | Generated skill location |
| `CONFIG_DIR_TEMPLATE` | `.aris/env-config/<project>` | State and PRD storage |
| `STATE_FILE` | `env-manager-state.json` | Inside CONFIG_DIR |
| `TRANSIENT_MAX_RETRIES` | 3 | For Mode B transient errors |
| `TRANSIENT_RETRY_DELAY` | 30 (seconds) | Between retry attempts |
| `PRD_VERSION` | 1 | PRD schema version |

---

## Critical Rules

1. **Sole entry point.** All environment initialization, repair, and audit
   requests go through this skill. No downstream skill dispatches
   `/experiment-env-configuration` or `/experiment-env-audit` directly.
2. **Never generate scripts.** This skill dispatches
   `/experiment-env-configuration` for all script generation. It writes
   only PRD, patch, and state files.
3. **Never judge audit results.** Read `overall_verdict` and `auto_fixable`
   from the structured verdict file. Do not reinterpret FAIL as WARN, do
   not average checks, do not override a verdict.
4. **Repair until resolved.** No fixed upper limit on repair rounds. Stop
   only when: (a) audit passes or warns, (b) user chooses force-deploy or
   abort, (c) auto-fix is impossible AND user escalation is needed.
5. **Fresh reviewer per audit.** Each `/experiment-env-audit` dispatch
   creates a new sub-agent. Never continue a prior audit thread -- the
   reviewer must not be anchored on a previously seen draft.
6. **File-paths-only receipts.** Receipt carries paths, not summaries. The
   dispatching parent reads the files themselves.
7. **Classification before action.** Mode B classifies the error before
   attempting any fix. Code bugs are returned immediately as
   `not_env_issue` -- never repaired as environment problems.
8. **Dispatch, do not inline.** Every call to env-configuration or env-audit
   is a `mcp__paseo__create_agent` dispatch. Never inline their logic,
   never call them via the host `Skill` tool, never approximate their
   behavior.
9. **Verify verdict provenance.** Before reading a verdict, check that
   `audited_at` is after `dispatch_timestamp` and `patch_id` matches (if
   applicable). Stale or mismatched verdicts trigger a re-dispatch, not
   a finalization.
10. **Per-check patch targets.** When constructing patches from audit results,
    read `patch_targets` from each failing check (not from a top-level array).
    Each check owns its targets — the manager constructs one patch with
    `changes[]` entries drawn from all failing checks' targets.

## External Dependencies

- `skills/experiment-env-configuration/SKILL.md` -- script generator.
  Dispatched as a paseo sub-agent for all script creation and patching.
- `skills/experiment-env-audit/SKILL.md` -- validator. Dispatched as a
  paseo sub-agent for all environment verification.
- `shared-references/paseo-subagent-dispatch.md` -- dispatch rules
  (Rule 1: one agent = one skill, Rule 3: file-paths-only receipts,
  Rule 4: Paseo MCP only, Rule 5: bounded context).
- `shared-references/worker-manifest.md` -- receipt schema (including
  error field conventions).
