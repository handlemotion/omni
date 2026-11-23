import { ScrollView, StyleSheet, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/ui/text.tsx";
import { colors, space } from "@/theme/tokens.ts";
import type { Module } from "./menu-nav.ts";
import { MENU_INSET } from "./menu-row.tsx";
import { CalendarMenu, CrmMenu, DriveMenu, MailMenu } from "./menu-rows.tsx";
import { useModules } from "./modules.ts";

const ROWS = {
  mail: MailMenu,
  drive: DriveMenu,
  crm: CrmMenu,
  calendar: CalendarMenu,
} as const;

/**
 * The module's left navigation drawer, sitting underneath the current page. As the page slides
 * right out of the way (`progress` 0 → 1), this menu fades in and scales up into place.
 */
export function MenuDrawer({
  module,
  width,
  progress,
  interactive,
}: {
  module: Module;
  width: number;
  progress: SharedValue<number>;
  interactive: boolean;
}) {
  const insets = useSafeAreaInsets();
  const entry = useModules().find((m) => m.id === module);
  const Rows = ROWS[module];
  const Mark = entry?.mark;

  const reveal = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 1], Extrapolation.CLAMP),
    transform: [
      { scale: interpolate(progress.value, [0, 1], [0.94, 1], Extrapolation.CLAMP) },
      { translateX: interpolate(progress.value, [0, 1], [-12, 0], Extrapolation.CLAMP) },
    ],
  }));

  return (
    <Animated.View
      pointerEvents={interactive ? "auto" : "none"}
      accessibilityElementsHidden={!interactive}
      style={[styles.drawer, { width, paddingTop: insets.top + space(3) }, reveal]}
    >
      {entry && Mark ? (
        <View style={styles.header}>
          <Mark size={24} />
          <Text size="lg" weight="semibold" numberOfLines={1}>
            {entry.label}
          </Text>
        </View>
      ) : null}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.rows, { paddingBottom: insets.bottom + space(8) }]}
      >
        <Rows />
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  drawer: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    paddingHorizontal: MENU_INSET + space(3.5),
    paddingBottom: space(3),
  },
  rows: { paddingHorizontal: MENU_INSET, paddingTop: space(1) },
});
