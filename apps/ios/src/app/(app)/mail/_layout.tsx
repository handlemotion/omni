import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** Mail's stack: a page's list (its own header), then a conversation; writing as a sheet. */
export default function MailLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Mail" }} />
      <Stack.Screen name="compose" options={{ presentation: "modal" }} />
    </Stack>
  );
}
