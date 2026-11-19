import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { IconCircleAlert } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { useInboxUnread } from "@/lib/mail-counts.ts";
import { useRealtime } from "@/lib/realtime.ts";
import { useSession } from "@/lib/session.ts";
import { useSplashDone } from "@/lib/splash.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { colors } from "@/theme/tokens.ts";

/**
 * Everything past sign-in: the modules (ADR 0035) as a native tab bar, each a stack of its own,
 * shown as icons only. Signed out, or signed out elsewhere, goes back to sign-in. Calls wait for
 * the workspace list, so the first ones already name the workspace the app is in; until then the
 * launch screen stays up.
 */
export default function SignedInLayout() {
  const session = useSession();
  const { active, workspaces } = useWorkspace();
  const signedIn = session.data ? active?.id : undefined;
  useRealtime(signedIn, session.data?.user.id);
  const unread = useInboxUnread(!!signedIn);
  useSplashDone(!!active || workspaces.isError);
  if (session.isPending && !session.data) return null;
  if (!session.data) return <Redirect href="/sign-in" />;
  if (!active) {
    if (!workspaces.isError) return null;
    return (
      <Screen>
        <EmptyState icon={IconCircleAlert} title="Omni didn't load">
          <Button intent="plain" label="Try again" onPress={() => void workspaces.refetch()} />
        </EmptyState>
      </Screen>
    );
  }
  const crm = hasCrm(active);
  return (
    <NativeTabs tintColor={colors.foreground} backgroundColor={colors.background}>
      <NativeTabs.Trigger name="mail" accessibilityLabel="Mail">
        <NativeTabs.Trigger.Icon sf={{ default: "envelope", selected: "envelope.fill" }} />
        <NativeTabs.Trigger.Label hidden>Mail</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!unread}>{unread}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="drive" accessibilityLabel="Drive">
        <NativeTabs.Trigger.Icon sf={{ default: "folder", selected: "folder.fill" }} />
        <NativeTabs.Trigger.Label hidden>Drive</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="crm" accessibilityLabel="CRM" hidden={!crm}>
        <NativeTabs.Trigger.Icon sf={{ default: "briefcase", selected: "briefcase.fill" }} />
        <NativeTabs.Trigger.Label hidden>CRM</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
