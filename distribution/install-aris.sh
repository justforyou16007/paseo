#!/usr/bin/env bash
set -euo pipefail
arl_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo 'ARL requires Node.js 22.12 or newer on PATH.' >&2
  exit 1
fi
exec node "$arl_dir/install-from-repo.mjs" "$@"
