import type { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { colors, fonts } from "@/theme/tokens.ts";

type Options = NonNullable<ComponentProps<typeof Stack>["screenOptions"]>;

/** Every module's stack: transparent native header in the app's type so content scrolls under it. */
export const stackOptions: Extract<Options, object> = {
  headerTintColor: colors.foreground,
  headerTitleStyle: { fontFamily: fonts.semibold, color: colors.foreground },
  headerLargeTitleStyle: { fontFamily: fonts.medium, color: colors.foreground },
  headerShadowVisible: false,
  headerLargeTitleShadowVisible: false,
  headerBackButtonDisplayMode: "minimal",
  headerTransparent: true,
  scrollEdgeEffects: { top: "hidden" },
  contentStyle: { backgroundColor: colors.background },
};
