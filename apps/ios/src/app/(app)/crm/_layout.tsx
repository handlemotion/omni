import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

const sheet = {
  presentation: "formSheet" as const,
  headerShown: false,
  sheetGrabberVisible: true,
  sheetAllowedDetents: [1],
};

/** The CRM's stack: a list, then a record, then the records it links to; forms as sheets. */
export default function CrmLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="form" options={sheet} />
      <Stack.Screen name="note" options={sheet} />
    </Stack>
  );
}
