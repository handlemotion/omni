import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** The CRM's stack: a list, then a record, then the records it links to. */
export default function CrmLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerLargeTitle: true }} />
    </Stack>
  );
}
