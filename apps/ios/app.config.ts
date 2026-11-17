import type { ExpoConfig } from "expo/config";

const scheme = process.env.OMNI_IOS_SCHEME || "omni";

const config: ExpoConfig = {
  name: process.env.OMNI_IOS_NAME || "Omni",
  slug: "omni",
  version: "0.1.0",
  orientation: "portrait",
  scheme,
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: process.env.OMNI_IOS_BUNDLE_ID || "app.omni.ios",
    supportsTablet: false,
  },
  plugins: ["expo-router", "expo-secure-store"],
  experiments: { typedRoutes: true, reactCompiler: true },
};

export default config;
