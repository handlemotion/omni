import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** Mail's stack: a page's list, a conversation and writing, each a page with its own bar. */
export default function MailLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Mail" }} />
      <Stack.Screen name="thread/[id]" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="compose" options={{ headerShown: false }} />
    </Stack>
  );
}
