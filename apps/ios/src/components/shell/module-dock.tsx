import * as Haptics from "expo-haptics";
import { Pressable, StyleSheet, View } from "react-native";
import { colors, radius, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { useModules } from "./modules.ts";

/** Height of the bottom module switcher dock row. */
export const DOCK_HEIGHT = space(9.5);

/**
 * The bottom dock of module marks: each module shows its desktop icon in full colour, the current
 * one sitting on a soft accent pill. A tap switches directly to that module.
 */
export function ModuleDock() {
  const modules = useModules();
  const place = useMenuPlace();
  const { close } = useMenu();
  return (
    <View accessibilityRole="tablist" style={styles.dock}>
      {modules.map((entry) => {
        const current = entry.id === place.module;
        const Mark = entry.mark;
        return (
          <Pressable
            key={entry.id}
            accessibilityRole="tab"
            accessibilityLabel={entry.label}
            accessibilityState={{ selected: current }}
            onPress={() => {
              if (current) {
                close();
                return;
              }
              void Haptics.selectionAsync();
              close();
              place.openModule(entry.id);
            }}
            style={({ pressed }) => [
              styles.slot,
              current && styles.current,
              pressed && styles.pressed,
            ]}
          >
            <Mark size={22} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
    paddingHorizontal: space(4),
  },
  slot: {
    width: space(14),
    height: DOCK_HEIGHT,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  current: {
    backgroundColor: colors.accent,
  },
  pressed: {
    transform: [{ scale: 0.94 }],
  },
});
