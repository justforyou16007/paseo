#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
The local dual-user tester deployment is retired.
Configure a root-owned remote_job JSON instead and pass it to:
  workflow-cli.js start --remote-tester-config <config>
The research host must not create a second Paseo, Claude, Codex, or tester account.
EOF
exit 1
