import { Stack } from "expo-router";
import { withTopFade } from "@/components/shell/screen-fade.tsx";
import { stackOptions } from "@/components/shell/stack-options.ts";

/**
 * A Drive link (`/s/<shareId>`), opened in the app from the link itself: signed in or not, since
 * a link may be open to anyone. Folders inside it push onto this stack.
 */
export default function LinkLayout() {
  return <Stack screenOptions={stackOptions} screenLayout={withTopFade} />;
}
