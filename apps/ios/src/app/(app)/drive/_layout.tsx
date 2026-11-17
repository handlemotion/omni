import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** Drive's stack: a page, then folders inside it, then a file. */
export default function DriveLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerLargeTitle: true }} />
    </Stack>
  );
}
