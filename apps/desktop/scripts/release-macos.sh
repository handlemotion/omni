#!/usr/bin/env bash
# Builds, signs, notarizes and publishes a macOS release of Omni (docs/spec/desktop.md, "Build,
# signing, release"). Runs on a Mac, from a clean checkout of a commit on main: the `Desktop release`
# workflow's macOS runner (ADR 0051), or a person's Mac. Installed apps find it at
# <OMNI_DESKTOP_ORIGIN>/desktop/latest.json within six hours and install it on their own.
#
#   apps/desktop/scripts/release-macos.sh             build, check and publish
#   apps/desktop/scripts/release-macos.sh --no-publish build and check only
#
# The version is `version` in src-tauri/tauri.conf.json, which release-please raises in its release
# PR. Merging that PR tags the commit desktop-v<version>, and the workflow runs this on that tag.
# Config comes from the environment, or apps/desktop/.env (see .env.example, "Releases"). Every
# secret is a file on this Mac, named by path; nothing secret is passed on the command line.
set -euo pipefail

desktop="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$desktop/../.." && pwd)"
publish=1
[[ "${1:-}" == "--no-publish" ]] && publish=0

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
need OMNI_DESKTOP_ORIGIN APPLE_TEAM_ID APPLE_SIGNING_IDENTITY OMNI_APP_PROFILE \
  OMNI_EXTENSION_PROFILE APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH \
  TAURI_SIGNING_PRIVATE_KEY_PATH
[[ $publish == 1 ]] && need CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
bucket="${OMNI_DESKTOP_RELEASE_BUCKET:-omni-desktop}"
origin="${OMNI_DESKTOP_ORIGIN%/}"
for file in "$OMNI_APP_PROFILE" "$OMNI_EXTENSION_PROFILE" "$APPLE_API_KEY_PATH" \
  "$TAURI_SIGNING_PRIVATE_KEY_PATH" "$TAURI_SIGNING_PRIVATE_KEY_PATH.pub"; do
  [[ -f "$file" ]] || { echo "release: no file at $file" >&2; exit 1; }
done

version="$(node -p "require('$desktop/src-tauri/tauri.conf.json').version")"
tag="desktop-v$version"

# A release is a commit main holds, and each version ships once: the tag may already exist only on
# this commit (release-please made it), and is made here otherwise.
tagged=0
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
  if git -C "$repo" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    if [[ "$(git -C "$repo" rev-parse "$tag^{commit}")" != "$(git -C "$repo" rev-parse HEAD)" ]]; then
      echo "release: $tag already names another commit; raise the version" >&2
      exit 1
    fi
    tagged=1
  fi
fi

echo "release: building Omni $version"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

# Read at build time: the updater's public key (compiled in; a build without it never updates),
# the signing identity for build-macos.sh, and the version for the extension's Info.plist.
export OMNI_DESKTOP_UPDATER_PUBKEY
OMNI_DESKTOP_UPDATER_PUBKEY="$(tr -d '\n' <"$TAURI_SIGNING_PRIVATE_KEY_PATH.pub")"
export OMNI_SIGN_IDENTITY="$APPLE_SIGNING_IDENTITY"
export OMNI_DESKTOP_VERSION="$version"
export TAURI_SIGNING_PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY_PATH"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
config="$(node -e '
  const [pubkey, profile] = process.argv.slice(1);
  console.log(JSON.stringify({
    bundle: {
      createUpdaterArtifacts: true,
      macOS: { files: { "embedded.provisionprofile": profile } },
    },
    plugins: { updater: { pubkey } },
  }));
' "$OMNI_DESKTOP_UPDATER_PUBKEY" "$OMNI_APP_PROFILE")"

(cd "$desktop" && pnpm tauri build --target universal-apple-darwin --bundles app,dmg --config "$config")

out="$desktop/target/universal-apple-darwin/release/bundle"
app="$out/macos/Omni.app"
archive="$out/macos/Omni.app.tar.gz"
dmg="$out/dmg/Omni_${version}_universal.dmg"

# Tauri notarized and stapled the app; the disk image people download is signed and notarized too.
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"
xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$dmg"

codesign --verify --deep --strict "$app"
spctl --assess --type execute "$app"
spctl --assess --type open --context context:primary-signature "$dmg"
xcrun stapler validate "$app"
xcrun stapler validate "$dmg"
echo "release: Omni $version is signed and notarized"

if [[ $publish == 0 ]]; then
  echo "$app"
  echo "$dmg"
  exit 0
fi

put() {
  (cd "$repo/apps/worker" && pnpm exec wrangler r2 object put "$bucket/$1" --remote \
    --file "$2" --content-type "$3")
}
put "releases/$version/Omni.app.tar.gz" "$archive" application/gzip
put "releases/$version/Omni_${version}_universal.dmg" "$dmg" application/x-apple-diskimage
put "download/macos.dmg" "$dmg" application/x-apple-diskimage

# Last: the manifest, so installed apps never see a release whose files are not there yet. One
# universal build serves both Mac architectures.
manifest="$(mktemp)"
node -e '
  const [version, url, signature] = process.argv.slice(1);
  const platform = { url, signature };
  console.log(JSON.stringify({
    version,
    pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform },
  }, null, 2));
' "$version" "$origin/desktop/releases/$version/Omni.app.tar.gz" "$(cat "$archive.sig")" >"$manifest"
put latest.json "$manifest" application/json
rm -f "$manifest"

live="$(curl -fsS "$origin/desktop/latest.json" | node -p 'JSON.parse(require("fs").readFileSync(0)).version')"
if [[ "$live" != "$version" ]]; then
  echo "release: the feed still says $live; check the bucket and the Worker route" >&2
  exit 1
fi

if [[ $tagged == 0 ]]; then
  git -C "$repo" tag "$tag"
  git -C "$repo" push -q origin "$tag"
fi
echo "release: Omni $version is live at $origin/desktop/latest.json ($tag)"
