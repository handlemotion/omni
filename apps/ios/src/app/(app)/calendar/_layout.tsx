import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** Calendar's stack: an empty placeholder screen until calendar and meetings land on iOS. */
export default function CalendarLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Calendar" }} />
    </Stack>
  );
}
