#!/bin/sh
# render_w_agent_prompt.sh — emit a paseo W-agent (or sub-agent) initialPrompt,
#                             and/or the paseo substrate config for a run.
#
# Pure string templating. Does NOT touch tools/. Reads the user project's
# CLAUDE.md `## ARIS Paseo` block (optional — defaults if absent) and either:
#   - emits the initialPrompt contract (default) defined in
#     skills/shared-references/paseo-subagent-dispatch.md ("The initialPrompt
#     contract") to stdout — the orchestrator passes it as `initialPrompt` to
#     mcp__paseo__create_agent; OR
#   - with --emit-config, writes a JSON config of ALL 12 paseo variables to
#     .aris/runs/<run_id>.paseo-config.json — the orchestrator reads this to
#     fill create_agent's provider/settings/workspace/heartbeat params
#     deterministically (script-guaranteed, not prose-driven — closes the
#     integration-contract.md §2 gap where 9 of 12 vars were prose-only).
#
# Why a script (not inline prose): the initialPrompt binds a workflow
# definition (a SKILL.md path) to a run's context deterministically, AND the
# 12 paseo variables must reach create_agent without depending on the
# orchestrator Agent re-reading CLAUDE.md prose (which drifts under context
# pressure). Prose can describe the integration; a script guarantees it.
#
# Usage:
#   # Config for the run (call ONCE at orchestrator start, before any dispatch):
#   render_w_agent_prompt.sh --emit-config --run-id <run_id> --root <root>
#
#   # Prompt per W-agent (call once per stage):
#   render_w_agent_prompt.sh \
#     --phase idea-discovery --run-id 2026-07-01_my-direction \
#     --root /path/to/project --skill skills/idea-discovery/SKILL.md \
#     [--extra "..."] [--role executor|reviewer]   # default executor
#
# Resolve this script itself via skills/<skill>/scripts/ (Layer 0,
# integration-contract.md). Callers typically know the path directly.
#
# Exit codes: 0 = success (prompt to stdout, or config file written);
#             1 = usage error.

set -eu

emit_config=0
phase=""
run_id=""
root=""
skill_path=""
extra=""
role="executor"

usage() {
    cat >&2 <<'EOF'
Usage: render_w_agent_prompt.sh --run-id <run_id> --root <root>
              [--phase <phase>] [--skill <skill-path>] [--extra "..."]
              [--role executor|reviewer] [--emit-config]
  --emit-config : write .aris/runs/<run_id>.paseo-config.json (12 vars) and exit.
                  Requires only --run-id + --root. --phase/--skill ignored.
  Default mode : emit the W-agent initialPrompt to stdout.
                  Requires --phase --run-id --root --skill.
EOF
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --emit-config) emit_config=1; shift;;
        --phase)      phase="$2"; shift 2;;
        --run-id)     run_id="$2"; shift 2;;
        --root)       root="$2"; shift 2;;
        --skill)      skill_path="$2"; shift 2;;
        --extra)      extra="$2"; shift 2;;
        --role)       role="$2"; shift 2;;
        -h|--help)    usage;;
        *) echo "unknown arg: $1" >&2; usage;;
    esac
done

[ -n "$run_id" ] || { echo "ERR: --run-id is required" >&2; usage; }
[ -n "$root" ]   || { echo "ERR: --root is required" >&2; usage; }

if [ "$emit_config" -eq 0 ]; then
    [ -n "$phase" ]      || { echo "ERR: --phase is required (or pass --emit-config)" >&2; usage; }
    [ -n "$skill_path" ] || { echo "ERR: --skill is required (or pass --emit-config)" >&2; usage; }
    case "$role" in
        executor|reviewer) ;;
        *) echo "ERR: --role must be executor or reviewer" >&2; usage;;
    esac
fi

# ---------------------------------------------------------------------------
# Read CLAUDE.md `## ARIS Paseo` block (optional; defaults if absent).
# Parses ALL 13 variables per templates/CLAUDE_MD_PASEO_SECTION.md.
# Paseo vars are orthogonal to effort/assurance.
# ---------------------------------------------------------------------------
claude_md="$root/CLAUDE.md"

# Defaults (match templates/CLAUDE_MD_PASEO_SECTION.md).
orchestrator_provider="claude/sonnet-4-6"
executor_provider="claude/sonnet-4-6"
executor_mode="bypassPermissions"
executor_thinking=""
reviewer_provider="codex/gpt-5.5"
reviewer_mode="full-access"
reviewer_thinking="xhigh"
notify_on_finish="true"
fanout_subagents="true"
heartbeat_cron="off"
heartbeat_max_runs=""
subagent_workspace="current"
max_phase_idle="1800"

if [ -f "$claude_md" ]; then
    # Extract the ## ARIS Paseo section (up to the next ## heading or EOF).
    paseo_block=$(awk '
        /^##[[:space:]]+ARIS[[:space:]]+Paseo/ {in_block=1; next}
        in_block && /^##[[:space:]]+/ {in_block=0}
        in_block {print}
    ' "$claude_md" 2>/dev/null || true)

    read_var() {
        # $1 = var name. Print the value from a "key: value" or "key: value # comment" line.
        # Handles YAML-ish "key: value" inside a fenced ```yaml block too (the block
        # lines themselves are plain "key: value", so the same regex matches).
        # Strips a single pair of surrounding quotes ("..." or '...') so a YAML
        # value like  heartbeat_cron: "*/13 * * * *"  is read as  */13 * * * *
        # (without this, the literal quotes would be double-encoded when the
        # value is interpolated into the emitted JSON, breaking json.load).
        printf '%s\n' "$paseo_block" \
            | grep -E "^[[:space:]]*$1[[:space:]]*:" \
            | head -n1 \
            | sed -E 's/^[^:]+:[[:space:]]*//; s/[[:space:]]*#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' \
            | grep -v '^$' || true
    }

    v=$(read_var orchestrator_provider); [ -n "$v" ] && orchestrator_provider="$v"
    v=$(read_var executor_provider);     [ -n "$v" ] && executor_provider="$v"
    v=$(read_var executor_mode);         [ -n "$v" ] && executor_mode="$v"
    v=$(read_var executor_thinking);     [ -n "$v" ] && executor_thinking="$v"
    v=$(read_var reviewer_provider);     [ -n "$v" ] && reviewer_provider="$v"
    v=$(read_var reviewer_mode);         [ -n "$v" ] && reviewer_mode="$v"
    v=$(read_var reviewer_thinking);     [ -n "$v" ] && reviewer_thinking="$v"
    v=$(read_var notify_on_finish);      [ -n "$v" ] && notify_on_finish="$v"
    v=$(read_var fanout_subagents);      [ -n "$v" ] && fanout_subagents="$v"
    v=$(read_var heartbeat_cron);        [ -n "$v" ] && heartbeat_cron="$v"
    v=$(read_var heartbeat_max_runs);   [ -n "$v" ] && heartbeat_max_runs="$v"
    v=$(read_var subagent_workspace);    [ -n "$v" ] && subagent_workspace="$v"
    v=$(read_var max_phase_idle);       [ -n "$v" ] && max_phase_idle="$v"
fi

# ---------------------------------------------------------------------------
# --emit-config: write the JSON config and exit.
# The orchestrator reads this once at startup and fills every create_agent /
# create_heartbeat call from it — no prose re-reading of CLAUDE.md per stage.
# ---------------------------------------------------------------------------
if [ "$emit_config" -eq 1 ]; then
    out_dir="$root/.aris/runs"
    mkdir -p "$out_dir"
    out="$out_dir/${run_id}.paseo-config.json"

    # heartbeat_max_runs may be empty -> emit null.
    hmr_json="null"
    [ -n "$heartbeat_max_runs" ] && hmr_json="$heartbeat_max_runs"
    # executor_thinking may be empty -> emit null (model default).
    et_json="null"
    [ -n "$executor_thinking" ] && et_json="\"$executor_thinking\""

    cat > "$out" <<EOF
{
  "run_id": "$run_id",
  "source": "CLAUDE.md ## ARIS Paseo (resolved by render_w_agent_prompt.sh)",
  "orchestrator_provider": "$orchestrator_provider",
  "executor_provider": "$executor_provider",
  "executor_mode": "$executor_mode",
  "executor_thinking": $et_json,
  "reviewer_provider": "$reviewer_provider",
  "reviewer_mode": "$reviewer_mode",
  "reviewer_thinking": "$reviewer_thinking",
  "notify_on_finish": $notify_on_finish,
  "fanout_subagents": $fanout_subagents,
  "subagent_workspace": "$subagent_workspace",
  "max_phase_idle": $max_phase_idle,
  "heartbeat_cron": "$heartbeat_cron",
  "heartbeat_max_runs": $hmr_json
}
EOF
    printf '%s\n' "$out"
    exit 0
fi

# ---------------------------------------------------------------------------
# Default mode: emit the initialPrompt.
# Executor contract: paseo-subagent-dispatch.md "The initialPrompt contract".
# Reviewer contract: paseo-reviewer-dispatch.md "The initialPrompt contract"
#   (file-paths-only, no executor summary — the caller supplies paths via --extra).
# ---------------------------------------------------------------------------

if [ "$role" = "reviewer" ]; then
    # Reviewer prompt: the caller passes file paths + objective in --extra.
    # Independence is absolute (reviewer-independence.md): no executor summary.
    cat <<EOF
You are a senior cross-model reviewer. Review the work for run ${run_id}, phase ${phase}.

$extra

Read the listed files yourself; do not trust any summary. Emit a 6-state verdict
(PASS|WARN|FAIL|BLOCKED|ERROR|NOT_APPLICABLE) to a verdict file on the shared
workspace, then return a one-line status. Do not call run_state.py.

Review backend: ${reviewer_provider} (paseo codex sub-agent; mode ${reviewer_mode}, thinking ${reviewer_thinking}; see paseo-reviewer-dispatch.md). Paseo MCP is required.
EOF
    exit 0
fi

# Executor prompt.
extra_block=""
if [ -n "$extra" ]; then
    extra_block=$(printf '\nAdditional run context:\n%s\n' "$extra")
fi

cat <<EOF
You are an ARIS workflow sub-agent. Execute the workflow defined in:

    ${skill_path}

Run context (this run, do not re-derive):
  - run_id:        ${run_id}
  - phase:         ${phase}
  - project root:  ${root}   (workspace:{kind:"${subagent_workspace}"} shares this dir)
  - CLAUDE.md:     read ./CLAUDE.md — both the ## ARIS Paseo block (execution substrate)
                   and the ## ARIS / pipeline-status sections (research context)
${extra_block}
Operating rules (non-negotiable):
  1. Resolve every helper via integration-contract.md §2 (.aris/tools -> tools -> \$ARIS_REPO/tools). Never hardcode a path.
  2. Write artifacts to the standard stage dir for this phase (per the SKILL's output protocol). Do NOT write elsewhere.
  3. When you need the cross-model reviewer, spawn/continue a paseo codex sub-agent per skills/shared-references/paseo-reviewer-dispatch.md. Fresh review = create_agent; continuation = send_agent_prompt to the same agent. Reviewer provider/mode/thinking are fixed by the run's paseo-config.json — do not override.
  4. Fan out sub-skills as paseo claude sub-agents per skills/shared-references/paseo-subagent-dispatch.md (fanout_subagents=${fanout_subagents}; if false, use in-process Skill-tool fallback).
  5. Do NOT call run_state.py accept. You may 'set done --artifact <path>'; acceptance is the orchestrator's job (acceptance-gate.md).
  6. On completion, write the receipt below and stop. Do not call accept, do not start the next phase.

Receipt (write this last, to ${root}/.aris/runs/${run_id}.${phase}.done.json):
  { "phase": "${phase}", "artifact_path": "<abs path>", "summary": "<1-3 lines>",
    "next_step": "<suggested next phase or null>", "reviewer_used": "<codex-agent-id or null>" }

Executor backend: ${executor_provider} (paseo claude sub-agent; mode ${executor_mode}; see paseo-subagent-dispatch.md).
EOF
