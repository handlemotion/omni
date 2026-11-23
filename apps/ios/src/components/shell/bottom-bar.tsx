import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomFade } from "@/components/ui/bottom-fade.tsx";
import { space } from "@/theme/tokens.ts";
import { ModuleActionPill } from "./module-action.tsx";
import { ModuleDock } from "./module-dock.tsx";

/**
 * The shell's bottom bar on a module's root page: the current module's main CTA pill centred
 * above the 4 modules and center Search tab, fading the scrolling page behind it.
 */
export function BottomBar() {
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom - space(1), space(3));
  return (
    <>
      <BottomFade />
      <View pointerEvents="box-none" style={[styles.dockWrap, { paddingBottom: bottom }]}>
        <View pointerEvents="box-none" style={styles.ctaRow}>
          <ModuleActionPill />
        </View>
        <ModuleDock />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  dockWrap: { position: "absolute", left: 0, right: 0, bottom: 0, gap: space(5) },
  ctaRow: { alignItems: "center" },
});
