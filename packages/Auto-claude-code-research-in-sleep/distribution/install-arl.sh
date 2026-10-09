#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo 'ARL requires Node.js 22.12 or newer on PATH.' >&2
  exit 1
fi
arl_version=0.1.0
arl_base="${ARL_DOWNLOAD_BASE:-https://raw.githubusercontent.com/justforyou16007/paseo/arl/packages/Auto-claude-code-research-in-sleep/distribution/releases}"
arl_temp="$(mktemp -d)"
trap 'rm -rf -- "$arl_temp"' EXIT
arl_archive="$arl_temp/arl-$arl_version.tar.gz"
if [[ -n "${ARL_ARCHIVE:-}" ]]; then
  cp -- "$ARL_ARCHIVE" "$arl_archive"
  cp -- "$ARL_ARCHIVE.sha256" "$arl_archive.sha256"
else
  curl --fail --location --silent --show-error "$arl_base/arl-$arl_version.tar.gz" --output "$arl_archive"
  curl --fail --location --silent --show-error "$arl_base/arl-$arl_version.tar.gz.sha256" --output "$arl_archive.sha256"
fi
node --input-type=module - "$arl_archive" <<'NODE'
import fs from "node:fs";
import crypto from "node:crypto";
const file = process.argv[2];
const expected = fs.readFileSync(`${file}.sha256`, "utf8").trim().split(/\s+/)[0];
const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
  throw new Error("ARL archive checksum mismatch");
}
NODE
tar -xzf "$arl_archive" -C "$arl_temp"
bash "$arl_temp/arl/install.sh" "$@"
