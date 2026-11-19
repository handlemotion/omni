import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** Mail's stack: a page's list and a conversation (each its own bar); writing as a sheet. */
export default function MailLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Mail" }} />
      <Stack.Screen name="thread/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="compose" options={{ presentation: "modal" }} />
    </Stack>
  );
}
