import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { ScrollEdge } from "@/components/ui/scroll-edge.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useShellTop } from "./menu-nav.ts";

/**
 * A module's root page, starting under the shell's top bar (under the status bar while searching,
 * when the top bar steps away), its list telling the bar when rows pass under it.
 */
export function ModuleRoot({ children }: { children: ReactNode }) {
  const { setScrolled, searching } = useMenu();
  const shellTop = useShellTop();
  const statusBar = useSafeAreaInsets().top;
  return (
    <ScrollEdge.Provider value={(event) => setScrolled(event.nativeEvent.contentOffset.y > 0)}>
      <View style={[styles.page, { paddingTop: searching ? statusBar + space(4) : shellTop }]}>
        {children}
      </View>
    </ScrollEdge.Provider>
  );
}

const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: colors.background } });
