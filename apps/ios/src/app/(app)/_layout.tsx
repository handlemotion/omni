import { Redirect, Stack } from "expo-router";
import { IconCircleAlert } from "@/components/icons.ts";
import { MenuProvider } from "@/components/shell/menu-context.tsx";
import { ClearSearchOnModuleChange } from "@/components/shell/shell.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { useRealtime } from "@/lib/realtime.ts";
import { useSession } from "@/lib/session.ts";
import { useSplashDone } from "@/lib/splash.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { colors } from "@/theme/tokens.ts";

/**
 * Everything past sign-in: the modules, each a stack of its own, one on screen at a
 * time, under one shell: a top bar (☰, the module pill, the workspace), a bottom bar (search and
 * the module's main action) and the menu that slides down between them, drawn on each module's
 * root page (`ModuleRoot`) so pushed pages cover it natively. No tab bar.
 * Signed out, or signed out elsewhere, goes back to sign-in. Calls wait for the workspace list,
 * so the first ones already name the workspace the app is in; until then the launch screen stays
 * up. Opening another workspace resets every answer on screen (`openWorkspace`), so each page
 * asks again under the new one rather than going on showing the last one's.
 */
export default function SignedInLayout() {
  const session = useSession();
  const { active, ready, workspaces } = useWorkspace();
  const signedIn = session.data && ready ? active?.id : undefined;
  useRealtime(signedIn, session.data?.user.id);
  useSplashDone(ready || workspaces.isError);
  if (session.isPending && !session.data) return null;
  if (!session.data) return <Redirect href="/sign-in" />;
  if (!active || !ready) {
    if (!workspaces.isError) return null;
    return (
      <Screen>
        <EmptyState icon={IconCircleAlert} title="Omni didn't load">
          <Button intent="plain" label="Try again" onPress={() => void workspaces.refetch()} />
        </EmptyState>
      </Screen>
    );
  }
  return (
    <MenuProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "none",
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="mail" />
        <Stack.Screen name="drive" />
        <Stack.Screen name="crm" />
        <Stack.Screen name="calendar" />
      </Stack>
      <ClearSearchOnModuleChange />
    </MenuProvider>
  );
}
