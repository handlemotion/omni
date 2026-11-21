#!/usr/bin/env bash
# Builds, signs and publishes a Windows release of Omni (docs/spec/desktop.md, "Build, signing,
# release"). Runs in Git Bash on Windows, from a clean checkout of a commit on main: the
# `Desktop release` workflow's Windows runner, or a person's PC. Installed apps find it at
# <OMNI_DESKTOP_ORIGIN>/desktop/windows/latest.json within six hours and install it on their own.
#
#   apps/desktop/scripts/release-windows.sh             build, check and publish
#   apps/desktop/scripts/release-windows.sh --no-publish build and check only
#
# The version is `version` in src-tauri/tauri.conf.json, as for macOS. This script never tags:
# release-please made the tag the workflow runs on, and release-macos.sh tags a release made by
# hand. Config comes from the environment, or apps/desktop/.env (see .env.example, "Releases").
#
# Signing: with OMNI_WINDOWS_SIGNING_ACCOUNT set, the installer and the app inside it are signed
# with Azure Trusted Signing (trusted-signing-cli, which reads AZURE_CLIENT_ID,
# AZURE_CLIENT_SECRET and AZURE_TENANT_ID). Without it the build is unsigned: it installs and
# updates the same, but SmartScreen warns on the first download. The update itself is always
# signed with the updater key, and installed apps refuse one that is not.
set -euo pipefail

desktop="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$desktop/../.." && pwd)"
publish=1
[[ "${1:-}" == "--no-publish" ]] && publish=0

# Git Bash paths (/d/a/omni) mean nothing to node, wrangler or Tauri: hand them Windows paths.
native() {
  if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}

if [[ -f "$desktop/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$desktop/.env"
  set +a
fi

need() {
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      echo "release: $name is not set (apps/desktop/.env.example, \"Releases\")" >&2
      exit 1
    fi
  done
}
need OMNI_DESKTOP_ORIGIN TAURI_SIGNING_PRIVATE_KEY_PATH
[[ $publish == 1 ]] && need CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
signed=0
if [[ -n "${OMNI_WINDOWS_SIGNING_ACCOUNT:-}" ]]; then
  need OMNI_WINDOWS_SIGNING_ENDPOINT OMNI_WINDOWS_SIGNING_PROFILE AZURE_CLIENT_ID \
    AZURE_CLIENT_SECRET AZURE_TENANT_ID
  command -v trusted-signing-cli >/dev/null || {
    echo "release: trusted-signing-cli is not installed (cargo install trusted-signing-cli)" >&2
    exit 1
  }
  signed=1
fi
bucket="${OMNI_DESKTOP_RELEASE_BUCKET:-omni-desktop}"
origin="${OMNI_DESKTOP_ORIGIN%/}"
for file in "$TAURI_SIGNING_PRIVATE_KEY_PATH" "$TAURI_SIGNING_PRIVATE_KEY_PATH.pub"; do
  [[ -f "$file" ]] || { echo "release: no file at $file" >&2; exit 1; }
done

version="$(node -p "require(process.argv[1]).version" "$(native "$desktop/src-tauri/tauri.conf.json")")"
tag="desktop-v$version"

# A release is a commit main holds, and a tag that exists names this commit.
if [[ $publish == 1 ]]; then
  git -C "$repo" fetch -q origin main --tags
  if [[ -n "$(git -C "$repo" status --porcelain)" ]]; then
    echo "release: the checkout has uncommitted changes" >&2
    exit 1
  fi
  if ! git -C "$repo" merge-base --is-ancestor HEAD origin/main; then
    echo "release: check out a commit on origin/main first" >&2
    exit 1
  fi
  if git -C "$repo" rev-parse -q --verify "refs/tags/$tag" >/dev/null &&
    [[ "$(git -C "$repo" rev-parse "$tag^{commit}")" != "$(git -C "$repo" rev-parse HEAD)" ]]; then
    echo "release: $tag already names another commit; raise the version" >&2
    exit 1
  fi
fi

if [[ $signed == 0 ]]; then
  echo "::warning::release: OMNI_WINDOWS_SIGNING_ACCOUNT is not set; this Windows build is unsigned"
fi
echo "release: building Omni $version for Windows"

# Read at build time: the updater's public key (compiled in; a build without it never updates).
export OMNI_DESKTOP_UPDATER_PUBKEY
OMNI_DESKTOP_UPDATER_PUBKEY="$(tr -d '\r\n' <"$TAURI_SIGNING_PRIVATE_KEY_PATH.pub")"
export TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY="$(native "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
sign_command=""
if [[ $signed == 1 ]]; then
  sign_command="trusted-signing-cli -e $OMNI_WINDOWS_SIGNING_ENDPOINT -a $OMNI_WINDOWS_SIGNING_ACCOUNT -c $OMNI_WINDOWS_SIGNING_PROFILE -d Omni %1"
fi
config="$(node -e '
  const [pubkey, signCommand] = process.argv.slice(1);
  console.log(JSON.stringify({
    bundle: {
      createUpdaterArtifacts: true,
      ...(signCommand ? { windows: { signCommand } } : {}),
    },
    plugins: { updater: { pubkey } },
  }));
' "$OMNI_DESKTOP_UPDATER_PUBKEY" "$sign_command")"

(cd "$desktop" && pnpm tauri build --bundles nsis --config "$config")

out="$desktop/target/release/bundle/nsis"
setup="$out/Omni_${version}_x64-setup.exe"
[[ -f "$setup" && -f "$setup.sig" ]] || {
  echo "release: no installer and updater signature at $setup" >&2
  exit 1
}

if [[ $signed == 1 ]]; then
  for file in "$setup" "$desktop/target/release/Omni.exe"; do
    status="$(powershell -NoProfile -Command "(Get-AuthenticodeSignature -LiteralPath '$(native "$file")').Status")"
    if [[ "${status//$'\r'/}" != "Valid" ]]; then
      echo "release: $file is not signed ($status)" >&2
      exit 1
    fi
  done
  echo "release: Omni $version for Windows is signed"
fi

if [[ $publish == 0 ]]; then
  echo "$setup"
  exit 0
fi

put() {
  (cd "$repo/apps/worker" && pnpm exec wrangler r2 object put "$bucket/$1" --remote \
    --file "$(native "$2")" --content-type "$3")
}
exe=application/vnd.microsoft.portable-executable
put "releases/$version/Omni_${version}_x64-setup.exe" "$setup" "$exe"
put "download/windows.exe" "$setup" "$exe"

# Last: the manifest, so installed apps never see a release whose files are not there yet. Its own
# key (windows/latest.json), so it never replaces the Mac's. Windows on Arm runs the x64 build.
manifest="$(mktemp)"
node -e '
  const [version, url, signature] = process.argv.slice(1);
  console.log(JSON.stringify({
    version,
    pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { url, signature } },
  }, null, 2));
' "$version" "$origin/desktop/releases/$version/Omni_${version}_x64-setup.exe" \
  "$(cat "$setup.sig")" >"$manifest"
put windows/latest.json "$manifest" application/json
rm -f "$manifest"

live="$(curl -fsS "$origin/desktop/windows/latest.json" | node -p 'JSON.parse(require("fs").readFileSync(0)).version')"
if [[ "$live" != "$version" ]]; then
  echo "release: the feed still says $live; check the bucket and the Worker route" >&2
  exit 1
fi
echo "release: Omni $version is live at $origin/desktop/windows/latest.json"
