#!/usr/bin/env bash
# Builds OmniFileProvider.appex (docs/spec/desktop.md "Build, signing, release"): a universal
# release build of the `OmniFileProvider` executable, wrapped in an extension bundle with its
# Info.plist and entitlements, and signed. Tauri copies the result into Contents/PlugIns.
#
# Config, all from the environment (apps/desktop/.env.example):
#   OMNI_DESKTOP_BUNDLE_ID   the app's bundle id; the extension is <id>.fileprovider
#   OMNI_DESKTOP_APP_GROUP   the App Group the app and the extension share
#   APPLE_TEAM_ID            the signing team; prefixes the keychain access group
#   OMNI_SIGN_IDENTITY       a codesign identity; unset or "-" signs ad hoc (compiles, never loads)
#   OMNI_EXTENSION_PROFILE   the extension's provisioning profile, embedded when set
#   OMNI_FILEPROVIDER_TESTING=1  adds the File Provider testing-mode entitlement (never in a release)
#   OMNI_EXTENSION_OUT       output folder (default apps/desktop/macos/build)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
bundle_id="${OMNI_DESKTOP_BUNDLE_ID:-app.omnidirectional.desktop}"
app_group="${OMNI_DESKTOP_APP_GROUP:-group.${bundle_id}}"
team="${APPLE_TEAM_ID:-}"
identity="${OMNI_SIGN_IDENTITY:--}"
out="${OMNI_EXTENSION_OUT:-$here/build}"
ext_id="$bundle_id.fileprovider"
keychain_group="${team:+$team.}$bundle_id"

swift build --package-path "$here" -c release --arch arm64 --arch x86_64 --product OmniFileProvider
binary="$(swift build --package-path "$here" -c release --arch arm64 --arch x86_64 --show-bin-path)/OmniFileProvider"

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

codesign --force --options runtime --timestamp=none --entitlements "$entitlements" --sign "$identity" "$appex"
codesign --verify --strict "$appex"
echo "$appex"
