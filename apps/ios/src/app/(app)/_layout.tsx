import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { useSession } from "@/lib/session.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { colors } from "@/theme/tokens.ts";

/**
 * Everything past sign-in: the modules (ADR 0035) as a native tab bar, each a stack of its own.
 * Signed out, or signed out elsewhere, goes back to sign-in. Calls wait for the workspace list,
 * so the first ones already name the workspace the app is in.
 */
export default function SignedInLayout() {
  const session = useSession();
  const { active } = useWorkspace();
  if (session.isPending && !session.data) return null;
  if (!session.data) return <Redirect href="/sign-in" />;
  if (!active) return null;
  return (
    <NativeTabs tintColor={colors.foreground} backgroundColor={colors.background}>
      <NativeTabs.Trigger name="mail">
        <NativeTabs.Trigger.Icon sf={{ default: "envelope", selected: "envelope.fill" }} />
        <NativeTabs.Trigger.Label>Mail</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
