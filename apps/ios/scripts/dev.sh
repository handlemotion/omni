#!/usr/bin/env bash
# Runs the iOS app as an Expo development build with Metro hot reload: in the booted Simulator by
# default, or on a plugged-in iPhone with `--device`. The native build is reused across worktrees
# while its native Expo fingerprint stays the same, so a rerun only starts Metro and opens the app;
# when native config or native dependencies change it prebuilds and rebuilds first.
#
#   pnpm ios:dev              Simulator (boots one if none is)
#   pnpm ios:dev --device     iPhone over USB or Wi-Fi; needs OMNI_IOS_TEAM_ID to sign when building
#   pnpm ios:dev --metro      skip the native check/build and start Metro for an already-installed build
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

target=simulator rebuild=0 metro_only=0
for arg in "$@"; do
  case "$arg" in
    --device) target=device ;;
    --rebuild) rebuild=1 ;;
    --metro) metro_only=1 ;;
    *) echo "ios dev: unknown option $arg" >&2 && exit 2 ;;
  esac
done

export OMNI_IOS_BUNDLE_ID="${OMNI_IOS_DEV_BUNDLE_ID:-app.omnidirectional.ios.dev}"
export OMNI_IOS_NAME="${OMNI_IOS_DEV_NAME:-Omni Dev}"
# Pin the dev build version so release-please version bumps do not invalidate the native build.
export OMNI_IOS_VERSION="${OMNI_IOS_DEV_VERSION:-0.0.0}"
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

start_metro() {
  if [ "$target" = device ]; then
    exec npx expo start --dev-client --port "$port"
  fi
  exec npx expo start --dev-client --ios --port "$port"
}

find_booted_simulator() {
  xcrun simctl list devices booted | sed -nE 's/.*\(([0-9A-F-]{36})\).*/\1/p' | head -1
}

find_physical_device() {
  local tmp
  tmp="$(mktemp)"
  if ! xcrun devicectl list devices --json-output "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    return 0
  fi
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const devices = data?.result?.devices ?? [];
    const match = devices.find((d) => {
      const reality = d?.properties?.hardware?.reality ?? d?.hardwareProperties?.reality;
      const platform = d?.properties?.hardware?.platform ?? d?.hardwareProperties?.platform;
      const pairing = d?.properties?.connection?.pairingState ?? d?.connectionProperties?.pairingState;
      const state = d?.properties?.connection?.state ?? d?.connectionProperties?.tunnelState;
      return reality === "physical" && platform === "iOS" && pairing === "paired" && state !== "disconnected" && state !== "unavailable";
    });
    if (match?.identifier) process.stdout.write(match.identifier);
  ' "$tmp" 2>/dev/null || true
  rm -f "$tmp"
}

device_has_app() {
  local device_id="$1" bundle_id="$2" tmp ok=1
  tmp="$(mktemp)"
  if xcrun devicectl device info apps --device "$device_id" --bundle-id "$bundle_id" --json-output "$tmp" >/dev/null 2>&1; then
    if node -e '
      const fs = require("node:fs");
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const apps = data?.result?.apps ?? [];
      process.exit(apps.some((a) => a?.bundleIdentifier === process.argv[2]) ? 0 : 1);
    ' "$tmp" "$bundle_id" 2>/dev/null; then
      ok=0
    fi
  fi
  rm -f "$tmp"
  return "$ok"
}

if [ "$target" = simulator ]; then
  sim_udid="$(find_booted_simulator)"
  if [ -z "$sim_udid" ]; then
    sim_udid="$(xcrun simctl list devices available | grep -m1 -E '^\s+iPhone' | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
    xcrun simctl boot "$sim_udid"
  fi
  open -a Simulator 2>/dev/null || true
fi

if [ "$metro_only" = 1 ]; then
  start_metro
fi

# Native build fingerprint via @expo/fingerprint (falls back to hashing config files if unavailable).
native_hash="$(node scripts/fingerprint.mjs 2>/dev/null || cat package.json app.config.ts | shasum | cut -c1-16)"
fingerprint="$native_hash-$OMNI_IOS_BUNDLE_ID-$target"

# Keep build stamps outside the gitignored worktree `ios/` folder so switching worktrees reuses
# the already-installed Omni Dev build instead of triggering a full native rebuild.
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/omni-ios"
stamp=""
installed=0

if [ "$target" = simulator ]; then
  stamp="$cache_dir/sim-$sim_udid-$OMNI_IOS_BUNDLE_ID.stamp"
  xcrun simctl get_app_container "$sim_udid" "$OMNI_IOS_BUNDLE_ID" >/dev/null 2>&1 && installed=1
else
  device_id="$(find_physical_device)"
  if [ -n "$device_id" ]; then
    stamp="$cache_dir/device-$device_id-$OMNI_IOS_BUNDLE_ID.stamp"
    device_has_app "$device_id" "$OMNI_IOS_BUNDLE_ID" && installed=1
  fi
fi

if [ "$rebuild" = 0 ] && [ "$installed" = 1 ] && [ -n "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$fingerprint" ]; then
  echo "ios dev: reusing installed $OMNI_IOS_NAME ($target, fingerprint ${native_hash:0:12})"
  start_metro
fi

# A build that fails or is stopped leaves no stamp, so the next run builds again.
[ -n "$stamp" ] && rm -f "$stamp"
# Prebuild rewrites package.json scripts; keep the file as it was, even if prebuild fails.
saved="$(mktemp)"
cp package.json "$saved"
trap 'cp "$saved" package.json; rm -f "$saved"' EXIT
trap 'exit 130' INT TERM
CI=1 npx expo prebuild --platform ios --clean
cp "$saved" package.json
rm -f "$saved"
trap - EXIT INT TERM

args=(--configuration Debug)
if [ "$target" = device ]; then
  : "${OMNI_IOS_TEAM_ID:?set OMNI_IOS_TEAM_ID to the Apple team that signs the dev build}"
  args+=(--device)
fi
# Build and install first; only an installed build gets the stamp. Then Metro serves it.
npx expo run:ios "${args[@]}" --no-bundler
if [ "$target" = device ] && [ -z "$stamp" ]; then
  device_id="$(find_physical_device)"
  [ -n "$device_id" ] && stamp="$cache_dir/device-$device_id-$OMNI_IOS_BUNDLE_ID.stamp"
fi
if [ -n "$stamp" ]; then
  mkdir -p "$cache_dir"
  echo "$fingerprint" >"$stamp"
fi
start_metro
