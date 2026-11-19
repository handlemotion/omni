import { Stack, type NativeStackNavigationOptions } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";
import { colors } from "@/theme/tokens.ts";

const sheet: NativeStackNavigationOptions = {
  presentation: "formSheet",
  sheetAllowedDetents: [0.6, 1],
  sheetGrabberVisible: true,
  headerShown: false,
  contentStyle: { backgroundColor: colors.background },
};

/** Drive's stack: a page, then folders inside it, then a file; a node's sheets over any. */
export default function DriveLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="share/[id]" options={sheet} />
      <Stack.Screen name="move/[id]" options={sheet} />
      <Stack.Screen name="versions/[id]" options={sheet} />
    </Stack>
  );
}
