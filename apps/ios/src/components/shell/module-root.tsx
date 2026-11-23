import { useLocalSearchParams } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollEdge } from "@/components/ui/scroll-edge.tsx";
import { space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { RootPlace, TopInset, useShellTop, type Module } from "./menu-nav.ts";
import { ShellChrome } from "./shell.tsx";

/**
 * A module's root page in the shell (`ShellFrame`): its title, search and workspace on top. Remembers its own page so
 * the module reopens there.
 */
export function ModuleRoot({ module, children }: { module: Module; children: ReactNode }) {
  const params = useLocalSearchParams<{ page?: string; space?: string; mailbox?: string }>();
  const shell = useMenu();
  const shellTop = useShellTop();
  const insets = useSafeAreaInsets();
  const statusBar = insets.top;

  const { remember } = shell;
  useEffect(() => {
    remember(module, { page: params.page, space: params.space, mailbox: params.mailbox });
  }, [remember, module, params.page, params.space, params.mailbox]);

  return (
    <RootPlace value={{ module, params }}>
      <ScrollEdge.Provider
        value={(event) => {
          const { contentOffset, contentInset } = event.nativeEvent;
          shell.setScrolled(contentOffset.y + contentInset.top > 0);
        }}
      >
        <View style={styles.page}>
          <TopInset value={shell.searching ? statusBar + space(4) : shellTop}>{children}</TopInset>
          <ShellChrome />
        </View>
      </ScrollEdge.Provider>
    </RootPlace>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
});
