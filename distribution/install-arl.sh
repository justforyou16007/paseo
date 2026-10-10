#!/usr/bin/env bash
set -euo pipefail

arl_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$arl_dir/install-aris.sh" "$@"
