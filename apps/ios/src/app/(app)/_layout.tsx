import { Redirect, Stack } from "expo-router";
import { IconCircleAlert } from "@/components/icons.ts";
import { MenuProvider } from "@/components/shell/menu-context.tsx";
import { ShellChrome } from "@/components/shell/shell.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { useRealtime } from "@/lib/realtime.ts";
import { useSession } from "@/lib/session.ts";
import { useSplashDone } from "@/lib/splash.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { colors } from "@/theme/tokens.ts";

/**
 * Everything past sign-in: the modules (ADR 0035), each a stack of its own, one on screen at a
 * time, under one shell: a top bar (☰, the module pill, the workspace), a bottom bar (search and
 * the module's main action) and the menu that slides down between them. No tab bar.
 * Signed out, or signed out elsewhere, goes back to sign-in. Calls wait for the workspace list,
 * so the first ones already name the workspace the app is in; until then the launch screen stays
 * up.
 */
export default function SignedInLayout() {
  const session = useSession();
  const { active, workspaces } = useWorkspace();
  const signedIn = session.data ? active?.id : undefined;
  useRealtime(signedIn, session.data?.user.id);
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
      </Stack>
      <ShellChrome />
    </MenuProvider>
  );
}
