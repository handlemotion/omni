#!/usr/bin/env bash
# Puts one signing certificate into a throwaway keychain on a macOS runner, for the release
# workflows (desktop-release.yml, ios-release.yml), and makes codesign and xcodebuild find it.
#
#   P12_BASE64    the certificate and its private key, exported from Keychain Access as .p12,
#                 then base64 (`base64 -i cert.p12 | pbcopy`)
#   P12_PASSWORD  the password the .p12 was exported with
#
# `signing-keychain.sh delete` removes the keychain when the job ends.
set -euo pipefail

keychain="$RUNNER_TEMP/signing.keychain-db"

if [[ "${1:-}" == "delete" ]]; then
  security delete-keychain "$keychain" 2>/dev/null || true
  exit 0
fi

: "${P12_BASE64:?the .p12 certificate, base64}"
: "${P12_PASSWORD:?the .p12 password}"
password="$(openssl rand -hex 24)"
p12="$RUNNER_TEMP/signing.p12"
trap 'rm -f "$p12"' EXIT

printf '%s' "$P12_BASE64" | base64 --decode >"$p12"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$p12" -k "$keychain" -P "$P12_PASSWORD" -f pkcs12 \
  -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" \
  >/dev/null
# First in the search list, so `security find-identity` and codesign see it.
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
security find-identity -v -p codesigning "$keychain" | sed -E 's/[0-9A-F]{40}/<hash>/'
