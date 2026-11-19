import { useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { ScrollEdge } from "@/components/ui/scroll-edge.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { RootPlace, useShellTop, type Module } from "./menu-nav.ts";
import { ShellChrome } from "./shell.tsx";

/**
 * A module's root page, starting under the shell's top bar (under the status bar while searching,
 * when the top bar steps away), its list telling the bar when rows pass under it. The shell's
 * chrome is drawn here, on the page's own native screen, so it never waits on the route.
 */
export function ModuleRoot({ module, children }: { module: Module; children: ReactNode }) {
  const params = useLocalSearchParams<{ page?: string; mailbox?: string }>();
  const { setScrolled, searching } = useMenu();
  const shellTop = useShellTop();
  const statusBar = useSafeAreaInsets().top;
  return (
    <RootPlace value={{ module, params }}>
      <ScrollEdge.Provider value={(event) => setScrolled(event.nativeEvent.contentOffset.y > 0)}>
        <View style={styles.page}>
          <View style={[styles.page, { paddingTop: searching ? statusBar + space(4) : shellTop }]}>
            {children}
          </View>
          <ShellChrome />
        </View>
      </ScrollEdge.Provider>
    </RootPlace>
  );
}

const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: colors.background } });
