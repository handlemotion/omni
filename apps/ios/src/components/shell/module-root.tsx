import { useLocalSearchParams } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EdgeBlur } from "@/components/ui/edge-blur.tsx";
import { ScrollEdge } from "@/components/ui/scroll-edge.tsx";
import { space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { RootPlace, TopInset, useShellTop, type Module } from "./menu-nav.ts";
import { ModuleMainAction } from "./module-action.tsx";
import { ShellChrome } from "./shell.tsx";

const BOTTOM_FADE = space(16);

/**
 * A module's root page in the shell's card (`ShellFrame`): its title and actions on top, a soft
 * fade at the card's bottom edge and the module's main action above it. Remembers its own page so
 * the module reopens there.
 */
export function ModuleRoot({ module, children }: { module: Module; children: ReactNode }) {
  const params = useLocalSearchParams<{ page?: string; space?: string; mailbox?: string }>();
  const shell = useMenu();
  const shellTop = useShellTop();
  const statusBar = useSafeAreaInsets().top;

  const { remember } = shell;
  useEffect(() => {
    remember(module, { page: params.page, space: params.space, mailbox: params.mailbox });
  }, [remember, module, params.page, params.space, params.mailbox]);

  return (
    <RootPlace value={{ module, params }}>
      <ScrollEdge.Provider
        value={(event) => shell.setScrolled(event.nativeEvent.contentOffset.y > 0)}
      >
        <View style={styles.page}>
          <TopInset value={shell.searching ? statusBar + space(4) : shellTop}>{children}</TopInset>
          {shell.searching ? null : (
            <EdgeBlur edge="bottom" height={BOTTOM_FADE} intensity={6} smooth />
          )}
          <ShellChrome />
          {shell.searching || shell.isOpen ? null : (
            <View style={styles.main}>
              <ModuleMainAction />
            </View>
          )}
        </View>
      </ScrollEdge.Provider>
    </RootPlace>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  main: { position: "absolute", right: space(4), bottom: space(5) },
});
