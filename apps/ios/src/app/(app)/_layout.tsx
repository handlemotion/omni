import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { useInboxUnread } from "@/lib/mail-counts.ts";
import { useRealtime } from "@/lib/realtime.ts";
import { useSession } from "@/lib/session.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { colors } from "@/theme/tokens.ts";

/**
 * Everything past sign-in: the modules (ADR 0035) as a native tab bar, each a stack of its own.
 * Signed out, or signed out elsewhere, goes back to sign-in. Calls wait for the workspace list,
 * so the first ones already name the workspace the app is in.
 */
export default function SignedInLayout() {
  const session = useSession();
  const { active } = useWorkspace();
  const signedIn = session.data ? active?.id : undefined;
  useRealtime(signedIn, session.data?.user.id);
  const unread = useInboxUnread(!!signedIn);
  if (session.isPending && !session.data) return null;
  if (!session.data) return <Redirect href="/sign-in" />;
  if (!active) return null;
  const crm = hasCrm(active);
  return (
    <NativeTabs tintColor={colors.foreground} backgroundColor={colors.background}>
      <NativeTabs.Trigger name="mail">
        <NativeTabs.Trigger.Icon sf={{ default: "envelope", selected: "envelope.fill" }} />
        <NativeTabs.Trigger.Label>Mail</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!unread}>{unread}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="drive">
        <NativeTabs.Trigger.Icon sf={{ default: "folder", selected: "folder.fill" }} />
        <NativeTabs.Trigger.Label>Drive</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="crm" hidden={!crm}>
        <NativeTabs.Trigger.Icon sf={{ default: "briefcase", selected: "briefcase.fill" }} />
        <NativeTabs.Trigger.Label>CRM</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
