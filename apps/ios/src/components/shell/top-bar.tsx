import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconMenu } from "@/components/icons.ts";
import { FloatingButton } from "@/components/ui/floating.tsx";
import { iconSize, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { SHELL_CONTROL } from "./menu-nav.ts";
import { ModuleActions } from "./module-action.tsx";

const SIDE = space(4);

/**
 * The shell's top bar on a module's root page: ☰ on the left (opens the left sidebar drawer) and
 * the module's actions grouped on the right, floating in Liquid Glass over the page. Only the
 * status bar blurs (`StatusBarBlur`, drawn once for the whole app); rows pass freely under the
 * buttons.
 */
export function TopBar() {
  const shell = useMenu();
  const insets = useSafeAreaInsets();
  if (shell.searching) return null;
  return (
    <View style={[styles.bar, { paddingTop: insets.top + space(2) }]} pointerEvents="box-none">
      <FloatingButton
        icon={IconMenu}
        glyph={iconSize.md}
        label={shell.isOpen ? "Close menu" : "Open menu"}
        compact
        onPress={shell.toggle}
      />
      <ModuleActions />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SIDE,
    minHeight: SHELL_CONTROL,
  },
});
