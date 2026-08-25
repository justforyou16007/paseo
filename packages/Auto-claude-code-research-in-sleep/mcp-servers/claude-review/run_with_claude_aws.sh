#!/usr/bin/env zsh
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER_DEBUG_LOG="${CLAUDE_REVIEW_WRAPPER_DEBUG_LOG:-/tmp/claude-review-wrapper.log}"

log_wrapper() {
  {
    print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  } >>"$WRAPPER_DEBUG_LOG" 2>/dev/null || true
}

exec 3>&1
exec 1>/dev/null

export DISABLE_AUTO_TITLE=true
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

log_wrapper "wrapper start"
log_wrapper "PATH=$PATH"

if ! command -v claude-aws >/dev/null 2>&1; then
  exec 1>&3 3>&-
  echo "claude-aws command not found in PATH" >&2
  exit 1
fi
export CLAUDE_BIN="$(command -v claude-aws)"
log_wrapper "using claude-aws command: $CLAUDE_BIN"

exec 1>&3 3>&-
log_wrapper "exec python3 $SCRIPT_DIR/server.py"
exec python3 "$SCRIPT_DIR/server.py"
