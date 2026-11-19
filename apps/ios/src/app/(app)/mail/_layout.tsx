import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";
import { radius } from "@/theme/tokens.ts";

/** Mail's stack: a page's list and a conversation (each its own bar); writing as a sheet. */
export default function MailLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Mail" }} />
      <Stack.Screen name="thread/[id]" options={{ headerShown: false }} />
      <Stack.Screen
        name="compose"
        options={{
          presentation: "formSheet",
          headerShown: false,
          sheetAllowedDetents: [1],
          sheetCornerRadius: radius.sheet,
          sheetGrabberVisible: false,
        }}
      />
    </Stack>
  );
}
