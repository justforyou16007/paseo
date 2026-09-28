#!/bin/sh
# ensure_browser_act.sh — guarantee the browser-act CLI is usable in this project.
#
# ARIS routes every browser interaction through the browser-act CLI
# (https://github.com/browser-act/skills). This helper is the single place that
# decides "is browser-act usable here", so no skill re-derives the check and no
# generated script invents a second browser stack.
#
# Policy A (gate) per skills/shared-references/integration-contract.md:
# when an experiment environment declares `browser.required`, a non-zero exit
# from this helper stops the phase. It is NOT called when no browser is needed.
#
# Contract: exactly one JSON object on stdout; diagnostics on stderr.
#   exit 0 — browser-act is usable (`status` is "ok" or "installed")
#   exit 1 — browser-act is not usable (`status` is "missing"); `hint` says why
#
# Usage:
#   ensure_browser_act.sh              # install when missing, then verify
#   ensure_browser_act.sh --check      # verify only; never install or fetch
#   ensure_browser_act.sh --skill-only # only ensure the agent-facing skill stub
#
# What it deliberately does NOT do: create a browser, open a session, log in, or
# set an API key. browser-act's Confirmation Gate requires explicit user approval
# for browser creation and every sensitive operation, so those stay interactive.
# See skills/shared-references/browser-act.md.

set -eu

MODE="ensure"
case "${1:-}" in
  --check) MODE="check" ;;
  --skill-only) MODE="skill-only" ;;
  "") ;;
  *) echo "usage: ensure_browser_act.sh [--check|--skill-only]" >&2; exit 1 ;;
esac

PKG="browser-act-cli"
PYTHON_VERSION="3.12"
SKILL_URL="https://raw.githubusercontent.com/browser-act/skills/main/browser-act/SKILL.md"

INSTALLED_NOW=false
HINT=""

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n'
}

# ---------------------------------------------------------------- locate the CLI
# `uv tool install` writes its shim to the uv bin directory, which a
# non-interactive shell may not have on PATH. Probing the known locations is a
# PATH problem, not a fallback implementation — every hit is the same binary.
locate_cli() {
  if command -v browser-act >/dev/null 2>&1; then
    command -v browser-act
    return 0
  fi
  for candidate in \
    "${HOME}/.local/bin/browser-act" \
    "$(uv tool dir --bin 2>/dev/null || true)/browser-act"
  do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

BINARY="$(locate_cli || true)"

if [ -z "$BINARY" ] && [ "$MODE" = "ensure" ]; then
  if ! command -v uv >/dev/null 2>&1; then
    HINT="uv is not installed. Install it (https://docs.astral.sh/uv/) then re-run, or install browser-act manually: uv tool install ${PKG} --python ${PYTHON_VERSION}"
  else
    echo "browser-act not found — installing ${PKG} (python ${PYTHON_VERSION})" >&2
    if uv tool install "$PKG" --python "$PYTHON_VERSION" >&2; then
      INSTALLED_NOW=true
      BINARY="$(locate_cli || true)"
      [ -n "$BINARY" ] || HINT="uv tool install succeeded but the browser-act shim is not on PATH. Add \$(uv tool dir --bin) to PATH."
    else
      HINT="uv tool install ${PKG} failed. Re-run it manually to see the resolver error."
    fi
  fi
fi

VERSION=""
IN_PATH=false
if [ -n "$BINARY" ]; then
  command -v browser-act >/dev/null 2>&1 && IN_PATH=true
  VERSION="$("$BINARY" --version 2>/dev/null | tr -d '\r\n' || true)"
  [ -n "$VERSION" ] || HINT="browser-act resolved at ${BINARY} but \`--version\` failed. Reinstall: uv tool upgrade ${PKG}"
fi

# ------------------------------------------------------- the agent-facing skill
# The stub is how a host discovers browser-act for interactive work; the real
# workflow content comes from `browser-act get-skills core`, so a missing stub is
# a warning, never a gate. Generated ops call the CLI directly and do not need it.
SKILL_DIR=".claude/skills/browser-act"
SKILL_STUB=""
if [ -f "$SKILL_DIR/SKILL.md" ]; then
  SKILL_STUB="$SKILL_DIR/SKILL.md"
elif [ "$MODE" != "check" ] && [ -d ".claude/skills" ]; then
  if command -v curl >/dev/null 2>&1 &&
     mkdir -p "$SKILL_DIR" &&
     curl -fsSL "$SKILL_URL" -o "$SKILL_DIR/SKILL.md.tmp" 2>/dev/null &&
     head -1 "$SKILL_DIR/SKILL.md.tmp" | grep -q '^---$'
  then
    mv "$SKILL_DIR/SKILL.md.tmp" "$SKILL_DIR/SKILL.md"
    SKILL_STUB="$SKILL_DIR/SKILL.md"
  else
    rm -f "$SKILL_DIR/SKILL.md.tmp"
    rmdir "$SKILL_DIR" 2>/dev/null || true
    echo "WARN: could not fetch the browser-act skill stub from ${SKILL_URL}." >&2
    echo "      Agent-driven browser work needs it; generated ops do not." >&2
  fi
fi

if [ "$MODE" = "skill-only" ]; then
  printf '{"tool":"browser-act","status":"%s","skill_stub":%s}\n' \
    "$([ -n "$SKILL_STUB" ] && echo ok || echo missing)" \
    "$([ -n "$SKILL_STUB" ] && printf '"%s"' "$(json_escape "$SKILL_STUB")" || echo null)"
  [ -n "$SKILL_STUB" ] || exit 1
  exit 0
fi

if [ -n "$BINARY" ] && [ -n "$VERSION" ]; then
  STATUS=$([ "$INSTALLED_NOW" = true ] && echo installed || echo ok)
  EXIT=0
else
  STATUS="missing"
  EXIT=1
  [ -n "$HINT" ] || HINT="browser-act is not installed. Run: uv tool install ${PKG} --python ${PYTHON_VERSION}"
fi

printf '{"tool":"browser-act","status":"%s","binary":%s,"version":%s,"in_path":%s,"installed_now":%s,"skill_stub":%s,"hint":%s}\n' \
  "$STATUS" \
  "$([ -n "$BINARY" ] && printf '"%s"' "$(json_escape "$BINARY")" || echo null)" \
  "$([ -n "$VERSION" ] && printf '"%s"' "$(json_escape "$VERSION")" || echo null)" \
  "$IN_PATH" \
  "$INSTALLED_NOW" \
  "$([ -n "$SKILL_STUB" ] && printf '"%s"' "$(json_escape "$SKILL_STUB")" || echo null)" \
  "$([ -n "$HINT" ] && printf '"%s"' "$(json_escape "$HINT")" || echo null)"

exit "$EXIT"
