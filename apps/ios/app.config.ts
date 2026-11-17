import type { ExpoConfig } from "expo/config";

const scheme = process.env.OMNI_IOS_SCHEME || "omni";

const config: ExpoConfig = {
  name: process.env.OMNI_IOS_NAME || "Omni",
  slug: "omni",
  version: process.env.OMNI_IOS_VERSION || "0.1.0",
  icon: "./assets/icon.png",
  orientation: "portrait",
  scheme,
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: process.env.OMNI_IOS_BUNDLE_ID || "app.omni.ios",
    buildNumber: process.env.OMNI_IOS_BUILD_NUMBER || "1",
    ...(process.env.OMNI_IOS_TEAM_ID ? { appleTeamId: process.env.OMNI_IOS_TEAM_ID } : {}),
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
  },
  plugins: ["expo-router", "expo-secure-store"],
  experiments: { typedRoutes: true, reactCompiler: true },
};

export default config;
