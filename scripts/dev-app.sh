#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export PATH="$ROOT_DIR/node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export PASEO_LISTEN="${PASEO_LISTEN:-127.0.0.1:6768}"
configure_dev_paseo_home

EXPO_PORT="${EXPO_PORT:-8081}"
DAEMON_ENDPOINT="$(resolve_dev_daemon_endpoint)"

echo "══════════════════════════════════════════════════════"
echo "  Paseo App Dev"
echo "══════════════════════════════════════════════════════"
echo "  Metro:   http://localhost:${EXPO_PORT}"
echo "  Daemon:  ${DAEMON_ENDPOINT}"
echo "  Home:    ${PASEO_HOME}"
echo "══════════════════════════════════════════════════════"

# Clear Metro/Expo caches before starting so a stale JS bundle can't mask
# new app code. Pass NO_CACHE_CLEAR=1 to skip (e.g. when the user wants
# the faster startup and accepts the stale bundle).
if [ "${NO_CACHE_CLEAR:-0}" != "1" ]; then
  echo "› Clearing Expo/Metro caches (.expo, node_modules/.cache)..."
  rm -rf "$ROOT_DIR/packages/app/.expo" \
         "$ROOT_DIR/packages/app/node_modules/.cache" \
         "$ROOT_DIR/node_modules/.cache" \
         "$ROOT_DIR/packages/app/.metro-cache" 2>/dev/null || true
fi

exec cross-env \
  BROWSER="${BROWSER:-none}" \
  APP_VARIANT=development \
  EXPO_PUBLIC_LOCAL_DAEMON="$DAEMON_ENDPOINT" \
  npm run start:expo --workspace=@getpaseo/app -- --port "$EXPO_PORT"
