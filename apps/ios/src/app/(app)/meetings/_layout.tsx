import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** Meetings' stack: an empty placeholder screen until meeting recording lands on iOS. */
export default function MeetingsLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Meetings" }} />
    </Stack>
  );
}
