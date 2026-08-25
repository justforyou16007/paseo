#!/usr/bin/env bash
# ARIS-Monitor launcher.
#
# READ-ONLY MONITOR. This launcher starts a Python program that only READS
# files under ~/.claude. It never writes to / kills / signals / spawns against
# any of your sessions or processes, and makes no network calls.
#
# ARIS-Monitor has ZERO third-party dependencies -- it uses only the Python 3
# standard library (tkinter ships with the interpreter). So there is nothing to
# pip-install. We deliberately do NOT create a venv: a fresh venv frequently
# lacks the compiled `_tkinter` module that the base interpreter has, which
# would break the GUI. We just verify Tk against your existing python3 and run.
#
# Usage:
#   ./run.sh            # start the floating widget (Tkinter is required)
#   ./run.sh --ticker   # force the headless terminal ticker
#   ./run.sh --check    # read-only smoke test (scanner.py), then exit
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYTHON:-python3}"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "ARIS-Monitor: '$PY' not found. Install Python 3 or set PYTHON=..." >&2
  exit 1
fi

mode="${1:-widget}"

if [ "$mode" = "--check" ]; then
  echo "ARIS-Monitor: read-only scanner smoke test"
  exec "$PY" "$DIR/scanner.py"
fi

if [ "$mode" = "--ticker" ]; then
  exec "$PY" "$DIR/ticker.py"
fi

if ! "$PY" -c "import tkinter" >/dev/null 2>&1; then
  echo "ARIS-Monitor: Tkinter not available for $PY." >&2
  echo "ARIS-Monitor: install Tk for this python, or choose './run.sh --ticker' explicitly." >&2
  exit 1
fi

exec "$PY" "$DIR/widget.py"
