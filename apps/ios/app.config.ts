import type { ExpoConfig } from "expo/config";
import { type ConfigPlugin, withXcodeProject } from "expo/config-plugins";
import pkg from "./package.json";

const scheme = process.env.OMNI_IOS_SCHEME || "omni";

const config: ExpoConfig = {
  name: process.env.OMNI_IOS_NAME || "Omni",
  slug: process.env.OMNI_IOS_SLUG || "omni",
  version: process.env.OMNI_IOS_VERSION || pkg.version,
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
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-splash-screen",
      { backgroundColor: "#ffffff", image: "./assets/splash-icon.png", imageWidth: 88 },
    ],
    ["expo-image-picker", { cameraPermission: false, microphonePermission: false }],
    [
      "@sentry/react-native/expo",
      {
        url: process.env.SENTRY_URL || "https://sentry.io/",
        organization: process.env.SENTRY_ORG,
        project: process.env.SENTRY_IOS_PROJECT,
        disableAutoUpload: !process.env.SENTRY_AUTH_TOKEN,
      },
    ],
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
};

const withManualAppTargetSigning: ConfigPlugin<{ team: string; profile: string }> = (base, opts) =>
  withXcodeProject(base, (mod) => {
    const project = mod.modResults;
    const { firstTarget } = project.getFirstTarget();
    const lists = project.pbxXCConfigurationList();
    const configs = project.pbxXCBuildConfigurationSection();
    for (const { value } of lists[firstTarget.buildConfigurationList].buildConfigurations) {
      Object.assign(configs[value].buildSettings, {
        CODE_SIGN_STYLE: "Manual",
        CODE_SIGN_IDENTITY: '"Apple Distribution"',
        DEVELOPMENT_TEAM: opts.team,
        PROVISIONING_PROFILE_SPECIFIER: `"${opts.profile}"`,
      });
    }
    return mod;
  });

const profile = process.env.OMNI_IOS_PROFILE;
const team = process.env.OMNI_IOS_TEAM_ID;
export default profile && team ? withManualAppTargetSigning(config, { team, profile }) : config;
