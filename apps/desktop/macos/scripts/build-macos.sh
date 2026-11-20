#!/usr/bin/env bash
# Builds the app's two Swift pieces (docs/spec/desktop.md "Build, signing, release"), universal
# and signed, into OMNI_EXTENSION_OUT:
#   OmniFileProvider.appex  the File Provider extension, for Contents/PlugIns
#   omni-sync               the shell's sync helper, for Contents/MacOS (amended)
#
# Config, all from the environment (apps/desktop/.env.example):
#   OMNI_DESKTOP_BUNDLE_ID   the app's bundle id; the extension is <id>.fileprovider
#   OMNI_DESKTOP_APP_GROUP   the App Group the app and the extension share
#   APPLE_TEAM_ID            the signing team; prefixes the keychain access group
#   OMNI_SIGN_IDENTITY       a codesign identity; unset or "-" signs ad hoc (compiles, never loads)
#   OMNI_EXTENSION_PROFILE   the extension's provisioning profile, embedded when set
#                            (omni-sync uses the app's, which Tauri embeds in the app)
#   OMNI_FILEPROVIDER_TESTING=1  adds the File Provider testing-mode entitlement (never in a release)
#   OMNI_EXTENSION_OUT       output folder (default apps/desktop/macos/build)
#   OMNI_DESKTOP_SENTRY_DSN  Sentry DSN for the extension's sync failures; unset keeps it off
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
bundle_id="${OMNI_DESKTOP_BUNDLE_ID:-app.omnidirectional.desktop}"
app_group="${OMNI_DESKTOP_APP_GROUP:-group.${bundle_id}}"
team="${APPLE_TEAM_ID:-}"
identity="${OMNI_SIGN_IDENTITY:--}"
out="${OMNI_EXTENSION_OUT:-$here/build}"
ext_id="$bundle_id.fileprovider"
keychain_group="${team:+$team.}$bundle_id"
# Notarization needs a secure timestamp on every signed binary; ad hoc signing has none to get.
timestamp="--timestamp"
[[ "$identity" == "-" ]] && timestamp="--timestamp=none"

swift build --package-path "$here" -c release --arch arm64 --arch x86_64 --product OmniFileProvider
swift build --package-path "$here" -c release --arch arm64 --arch x86_64 --product OmniSyncHelper
bin_dir="$(swift build --package-path "$here" -c release --arch arm64 --arch x86_64 --show-bin-path)"
binary="$bin_dir/OmniFileProvider"

appex="$out/OmniFileProvider.appex"
rm -rf "$appex"
mkdir -p "$appex/Contents/MacOS"
cp "$binary" "$appex/Contents/MacOS/OmniFileProvider"

plist="$appex/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Clear dict" "$plist" >/dev/null 2>&1 || true
pb() { /usr/libexec/PlistBuddy -c "$1" "$plist" >/dev/null; }
pb "Add :CFBundleIdentifier string $ext_id"
pb "Add :CFBundleName string OmniFileProvider"
pb "Add :CFBundleDisplayName string Omni"
pb "Add :CFBundleExecutable string OmniFileProvider"
pb "Add :CFBundlePackageType string XPC!"
pb "Add :CFBundleInfoDictionaryVersion string 6.0"
pb "Add :CFBundleShortVersionString string ${OMNI_DESKTOP_VERSION:-0.0.0}"
pb "Add :CFBundleVersion string ${OMNI_DESKTOP_VERSION:-0.0.0}"
pb "Add :LSMinimumSystemVersion string 13.0"
pb "Add :NSExtension dict"
pb "Add :NSExtension:NSExtensionPointIdentifier string com.apple.fileprovider-nonui"
pb "Add :NSExtension:NSExtensionPrincipalClass string OmniFileProvider.FileProviderExtension"
pb "Add :NSExtension:NSExtensionFileProviderDocumentGroup string $app_group"
pb "Add :NSExtension:NSExtensionFileProviderSupportsEnumeration bool true"
# Read by SharedIdentity: what the extension shares with the app.
pb "Add :OmniAppGroup string $app_group"
pb "Add :OmniKeychainGroup string $keychain_group"
pb "Add :OmniKeychainService string $bundle_id.sync"
# Read by ErrorReporter; empty keeps error reporting off.
[[ -n "${OMNI_DESKTOP_SENTRY_DSN:-}" ]] && pb "Add :OmniSentryDSN string $OMNI_DESKTOP_SENTRY_DSN"
plutil -lint "$plist" >/dev/null

entitlements="$out/OmniFileProvider.entitlements"
cat >"$entitlements" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.application-groups</key><array><string>$app_group</string></array>
  <key>keychain-access-groups</key><array><string>$keychain_group</string></array>
PLIST
if [[ -n "$team" ]]; then
  cat >>"$entitlements" <<PLIST
  <key>com.apple.application-identifier</key><string>$team.$ext_id</string>
  <key>com.apple.developer.team-identifier</key><string>$team</string>
PLIST
fi
if [[ "${OMNI_FILEPROVIDER_TESTING:-}" == "1" ]]; then
  echo "  <key>com.apple.developer.fileprovider.testing-mode</key><true/>" >>"$entitlements"
fi
echo "</dict></plist>" >>"$entitlements"
plutil -lint "$entitlements" >/dev/null

if [[ -n "${OMNI_EXTENSION_PROFILE:-}" ]]; then
  cp "$OMNI_EXTENSION_PROFILE" "$appex/Contents/embedded.provisionprofile"
fi

codesign --force --options runtime "$timestamp" --entitlements "$entitlements" --sign "$identity" "$appex"
codesign --verify --strict "$appex"

# The app's entitlements, for Tauri's signing step (tauri.macos.conf.json): the App Group and
# the keychain group it shares with the extension. The app holds the provisioning profile.
app_entitlements="$out/Omni.entitlements"
cat >"$app_entitlements" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key><array><string>$app_group</string></array>
  <key>keychain-access-groups</key><array><string>$keychain_group</string></array>
PLIST
if [[ -n "$team" ]]; then
  cat >>"$app_entitlements" <<PLIST
  <key>com.apple.application-identifier</key><string>$team.$bundle_id</string>
  <key>com.apple.developer.team-identifier</key><string>$team</string>
PLIST
fi
echo "</dict></plist>" >>"$app_entitlements"
plutil -lint "$app_entitlements" >/dev/null

# omni-sync runs as part of the app (its main bundle is the app, so NSFileProviderManager finds
# the extension) and claims no entitlement: macOS kills a bare tool that claims a restricted one,
# since only a bundle's main executable gets the bundle's profile.
cp "$bin_dir/OmniSyncHelper" "$out/omni-sync"
codesign --force --options runtime "$timestamp" --identifier "$bundle_id.sync" \
  --sign "$identity" "$out/omni-sync"
codesign --verify --strict "$out/omni-sync"

echo "$appex"
echo "$out/omni-sync"
