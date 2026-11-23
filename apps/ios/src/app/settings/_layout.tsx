import { Stack } from "expo-router";
import { withTopFade } from "@/components/shell/screen-fade.tsx";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** Settings, a sheet over the app with a stack of its own (opened from the workspace menu). */
export default function SettingsLayout() {
  return (
    <Stack screenOptions={stackOptions} screenLayout={withTopFade}>
      <Stack.Screen name="index" options={{ title: "Settings" }} />
    </Stack>
  );
}
