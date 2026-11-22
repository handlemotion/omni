#!/usr/bin/env bash
# Builds `omni-capture`, universal and signed, into OMNI_CAPTURE_OUT (default
# apps/desktop/recorder/macos/build), for Contents/MacOS (tauri.macos.conf.json).
#
#   OMNI_DESKTOP_BUNDLE_ID   the app's bundle id; the helper signs as <id>.capture
#   OMNI_SIGN_IDENTITY       a codesign identity; unset or "-" signs ad hoc
#
# Its one entitlement is the microphone, which a hardened-runtime binary needs to open it and
# which is not restricted, so a bare tool may claim it. Permission prompts are the app's: macOS
# asks for the process that runs the helper, with the app's Info.plist strings.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
bundle_id="${OMNI_DESKTOP_BUNDLE_ID:-app.omnidirectional.desktop}"
identity="${OMNI_SIGN_IDENTITY:--}"
out="${OMNI_CAPTURE_OUT:-$here/build}"
timestamp="--timestamp"
[[ "$identity" == "-" ]] && timestamp="--timestamp=none"

swift build --package-path "$here" -c release --arch arm64 --arch x86_64 --product OmniCapture
bin_dir="$(swift build --package-path "$here" -c release --arch arm64 --arch x86_64 --show-bin-path)"

mkdir -p "$out"
entitlements="$out/omni-capture.entitlements"
cat >"$entitlements" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
PLIST
plutil -lint "$entitlements" >/dev/null

cp "$bin_dir/OmniCapture" "$out/omni-capture"
codesign --force --options runtime "$timestamp" --identifier "$bundle_id.capture" \
  --entitlements "$entitlements" --sign "$identity" "$out/omni-capture"
codesign --verify --strict "$out/omni-capture"
echo "$out/omni-capture"
