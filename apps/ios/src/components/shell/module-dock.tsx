import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { colors, radius, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { useModules, type ModuleEntry } from "./modules.ts";

/** Height of the bottom module switcher dock row. */
export const DOCK_HEIGHT = space(10);

function SearchDockGlyph({ size = 23, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20.25 20.25L16.1265 16.1265M16.1265 16.1265C17.4385 14.8145 18.25 13.002 18.25 11C18.25 6.99594 15.0041 3.75 11 3.75C6.99594 3.75 3.75 6.99594 3.75 11C3.75 15.0041 6.99594 18.25 11 18.25C13.002 18.25 14.8145 17.4385 16.1265 16.1265Z"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * The bottom dock: the 4 modules split symmetrically around a visitable center Search tab
 * (`Mail`, `Drive`, `🔍`, `CRM`, `Calendar`). Only the active tab takes the darker grey pill.
 */
export function ModuleDock({ isSearch = false }: { isSearch?: boolean }) {
  const modules = useModules();
  const place = useMenuPlace();
  const { close } = useMenu();
  const split = Math.ceil(modules.length / 2);
  const left = modules.slice(0, split);
  const right = modules.slice(split);

  const renderModule = (entry: ModuleEntry) => {
    const current = !isSearch && entry.id === place.module;
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
        style={({ pressed }) => [styles.slot, current && styles.current, pressed && styles.pressed]}
      >
        <Mark size={22} />
      </Pressable>
    );
  };

  return (
    <View accessibilityRole="tablist" style={styles.dock}>
      {left.map(renderModule)}
      <Pressable
        accessibilityRole="tab"
        accessibilityLabel="Search"
        accessibilityState={{ selected: isSearch }}
        onPress={() => {
          if (isSearch) return;
          void Haptics.selectionAsync();
          close();
          router.replace({ pathname: "/search", params: { in: place.module } });
        }}
        style={({ pressed }) => [
          styles.slot,
          isSearch && styles.current,
          pressed && styles.pressed,
        ]}
      >
        <SearchDockGlyph size={23} color={colors.foreground} />
      </Pressable>
      {right.map(renderModule)}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
    paddingHorizontal: space(3),
  },
  slot: {
    width: space(13),
    height: DOCK_HEIGHT,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  current: {
    backgroundColor: colors.well,
  },
  pressed: {
    transform: [{ scale: 0.94 }],
  },
});
