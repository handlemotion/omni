import { Redirect, Stack } from "expo-router";
import { useSession } from "@/lib/session.ts";
import { colors } from "@/theme/tokens.ts";

/** Everything past sign-in. Signed out, or signed out elsewhere, goes back to sign-in. */
export default function SignedInLayout() {
  const session = useSession();
  if (session.isPending && !session.data) return null;
  if (!session.data) return <Redirect href="/sign-in" />;
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    >
      <Stack.Screen
        name="mailboxes"
        options={{
          presentation: "formSheet",
          sheetAllowedDetents: [0.6, 1],
          sheetGrabberVisible: true,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </Stack>
  );
}
