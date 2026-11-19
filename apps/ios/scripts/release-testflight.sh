#!/usr/bin/env bash
# Builds the iOS app for the App Store and uploads it to App Store Connect, where TestFlight picks
# it up. Run on a Mac with Xcode signed in to the Apple account that owns the team; nothing here
# holds a credential. Every input is an environment variable (see `.env.example`):
#
#   EXPO_PUBLIC_OMNI_API_URL  the Worker's public origin, e.g. https://omnidirectional.app
#   OMNI_IOS_BUNDLE_ID        the App ID registered for the app in App Store Connect
#   OMNI_IOS_TEAM_ID          the Apple team that signs it
#   OMNI_IOS_BUILD_NUMBER     one higher than the last upload
#   OMNI_IOS_VERSION          optional; the version people see (default 0.1.0)
#   UPLOAD=0                  build and export the .ipa without uploading it
#   ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID
#                             optional App Store Connect API key: signs in with it instead of the
#                             Xcode account, and lets Xcode sign in the cloud when this Mac has no
#                             distribution certificate. With it, the export signs manually with
#                             this Mac's Apple Distribution certificate and the app's App Store
#                             profile, made once through the API (app-store-profile.mjs)
#
# Xcode's automatic signing makes the distribution certificate and profile when the team has none
# (`-allowProvisioningUpdates`).
set -euo pipefail

: "${EXPO_PUBLIC_OMNI_API_URL:?the Worker origin the app talks to}"
: "${OMNI_IOS_BUNDLE_ID:?the app bundle identifier}"
: "${OMNI_IOS_TEAM_ID:?the Apple team id}"
: "${OMNI_IOS_BUILD_NUMBER:?a build number higher than the last upload}"
export EXPO_PUBLIC_OMNI_API_URL OMNI_IOS_BUNDLE_ID OMNI_IOS_TEAM_ID OMNI_IOS_BUILD_NUMBER
export LANG="${LANG:-en_US.UTF-8}"

auth=()
if [ -n "${ASC_KEY_PATH:-}" ]; then
  : "${ASC_KEY_ID:?the API key id}" "${ASC_ISSUER_ID:?the API key issuer id}"
  auth=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

app="$(cd "$(dirname "$0")/.." && pwd)"
out="$app/ios/build/release"
cd "$app"

# A clean native project from app.config.ts, so the bundle id, team and build number are current.
CI=1 npx expo prebuild --platform ios --clean
# Prebuild adds scripts to package.json; the committed file stays as it is.
git checkout -- package.json

rm -rf "$out"
xcodebuild -workspace ios/*.xcworkspace -scheme "$(basename ios/*.xcworkspace .xcworkspace)" \
  -configuration Release -destination "generic/platform=iOS" \
  -archivePath "$out/app.xcarchive" -allowProvisioningUpdates ${auth[@]+"${auth[@]}"} \
  DEVELOPMENT_TEAM="$OMNI_IOS_TEAM_ID" CODE_SIGN_STYLE=Automatic archive

signing="<key>signingStyle</key><string>automatic</string>"
provisioning=(-allowProvisioningUpdates)
if [ -n "${ASC_KEY_PATH:-}" ]; then
  serial="$(security find-certificate -c "Apple Distribution" -p | openssl x509 -noout -serial | cut -d= -f2)"
  profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  mkdir -p "$profiles"
  profile="$(CERT_SERIAL="$serial" PROFILES_DIR="$profiles" node "$app/scripts/app-store-profile.mjs")"
  signing="<key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>$OMNI_IOS_BUNDLE_ID</key><string>$profile</string></dict>"
  provisioning=()
fi

destination=upload
[ "${UPLOAD:-1}" = 0 ] && destination=export
cat > "$out/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$OMNI_IOS_TEAM_ID</string>
  $signing
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$out/app.xcarchive" \
  -exportOptionsPlist "$out/export.plist" -exportPath "$out" \
  ${provisioning[@]+"${provisioning[@]}"} ${auth[@]+"${auth[@]}"}

echo "release-testflight: build $OMNI_IOS_BUILD_NUMBER of $OMNI_IOS_BUNDLE_ID ($destination) done"
