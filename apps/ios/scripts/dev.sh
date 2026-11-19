#!/usr/bin/env bash
# Runs the iOS app as an Expo development build with Metro hot reload: in the booted Simulator by
# default, or on a plugged-in iPhone with `--device`. The native build is reused while its inputs
# (package.json, app.config.ts, the bundle id) stay the same, so a rerun only starts Metro and
# opens the app; when they change it prebuilds and rebuilds first.
#
#   pnpm ios:dev              Simulator (boots one if none is)
#   pnpm ios:dev --device     iPhone over USB or Wi-Fi; needs OMNI_IOS_TEAM_ID to sign
#   pnpm ios:dev --rebuild    force the native rebuild
#
# The dev build has its own bundle id (OMNI_IOS_DEV_BUNDLE_ID, default
# app.omnidirectional.ios.dev) and name, so it sits next to the TestFlight app instead of
# replacing it. The API origin is EXPO_PUBLIC_OMNI_API_URL, from the environment or apps/ios/.env.
# Metro listens on OMNI_IOS_METRO_PORT (default 8081) on every interface, so a phone on the same
# network reaches it. Ctrl-C stops Metro; the app stays installed.
set -euo pipefail

app="$(cd "$(dirname "$0")/.." && pwd)"
cd "$app"
export LANG="${LANG:-en_US.UTF-8}"

target=simulator rebuild=0
for arg in "$@"; do
  case "$arg" in
    --device) target=device ;;
    --rebuild) rebuild=1 ;;
    *) echo "ios dev: unknown option $arg" >&2 && exit 2 ;;
  esac
done

export OMNI_IOS_BUNDLE_ID="${OMNI_IOS_DEV_BUNDLE_ID:-app.omnidirectional.ios.dev}"
export OMNI_IOS_NAME="${OMNI_IOS_DEV_NAME:-Omni Dev}"
# Its own slug gives the dev launcher its own `exp+<slug>://` scheme, so iOS opens Metro's link
# in this app and not in another Omni build that is installed too.
export OMNI_IOS_SLUG=omni-dev
# The API origin: the environment, else .env, else the local stack's Worker.
if [ -z "${EXPO_PUBLIC_OMNI_API_URL:-}" ] && ! grep -qE '^EXPO_PUBLIC_OMNI_API_URL=.+' .env 2>/dev/null; then
  export EXPO_PUBLIC_OMNI_API_URL=http://localhost:8787
fi
# Expo would rewrite the committed tsconfig.json, expo-env.d.ts and .gitignore on every start.
export EXPO_NO_TYPESCRIPT_SETUP=1
port="${OMNI_IOS_METRO_PORT:-8081}"

if pid="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1)" && [ -n "$pid" ]; then
  echo "ios dev: port $port is taken by pid $pid ($(ps -o command= -p "$pid" | cut -c1-120))." >&2
  echo "ios dev: stop it, or pick another port with OMNI_IOS_METRO_PORT." >&2
  exit 1
fi

if [ "$target" = simulator ] && ! xcrun simctl list devices booted | grep -q Booted; then
  device="$(xcrun simctl list devices available | grep -m1 -E '^\s+iPhone' | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
  xcrun simctl boot "$device"
fi
[ "$target" = simulator ] && { open -a Simulator 2>/dev/null || true; }

# What the native build depends on. A change here means the installed app is stale.
fingerprint="$(cat package.json app.config.ts | shasum | cut -c1-16)-$OMNI_IOS_BUNDLE_ID-$target"
stamp=ios/.omni-dev-build
installed=0
if [ "$target" = simulator ]; then
  xcrun simctl get_app_container booted "$OMNI_IOS_BUNDLE_ID" >/dev/null 2>&1 && installed=1
fi
if [ "$rebuild" = 0 ] && [ "$installed" = 1 ] && [ "$(cat "$stamp" 2>/dev/null)" = "$fingerprint" ]; then
  exec npx expo start --dev-client --ios --port "$port"
fi

# Prebuild rewrites package.json scripts; keep the file as it was.
cp package.json "$TMPDIR/omni-ios-package.json"
CI=1 npx expo prebuild --platform ios --clean
cp "$TMPDIR/omni-ios-package.json" package.json

args=(--port "$port" --configuration Debug)
if [ "$target" = device ]; then
  : "${OMNI_IOS_TEAM_ID:?set OMNI_IOS_TEAM_ID to the Apple team that signs the dev build}"
  args+=(--device)
fi
mkdir -p ios && echo "$fingerprint" >"$stamp"
exec npx expo run:ios "${args[@]}"
