import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** Mail's stack: a page's list, then a conversation; writing as a sheet. */
export default function MailLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerLargeTitle: true }} />
      <Stack.Screen name="compose" options={{ presentation: "modal" }} />
    </Stack>
  );
}
