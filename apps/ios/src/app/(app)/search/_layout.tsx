import { Stack } from "expo-router";
import { stackOptions } from "@/components/shell/stack-options.ts";

/** Global Search stack: Liquid Glass top search bar, module scope tabs, and the bottom dock. */
export default function SearchLayout() {
  return (
    <Stack screenOptions={stackOptions}>
      <Stack.Screen name="index" options={{ headerShown: false, title: "Search" }} />
    </Stack>
  );
}
