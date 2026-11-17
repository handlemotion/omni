import type { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { colors, fonts } from "@/theme/tokens.ts";

type Options = NonNullable<ComponentProps<typeof Stack>["screenOptions"]>;

/** Every module's stack: the native header in the app's type, on the canvas, no rule under it. */
export const stackOptions: Extract<Options, object> = {
  headerTintColor: colors.foreground,
  headerTitleStyle: { fontFamily: fonts.semibold, color: colors.foreground },
  headerLargeTitleStyle: { fontFamily: fonts.semibold, color: colors.foreground },
  headerShadowVisible: false,
  headerLargeTitleShadowVisible: false,
  headerBackButtonDisplayMode: "minimal",
  headerStyle: { backgroundColor: colors.background },
  contentStyle: { backgroundColor: colors.background },
};
