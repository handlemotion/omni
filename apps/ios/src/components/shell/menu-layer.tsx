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
import { MENU_INSET, NAV_LEAD, NAV_PAD_LEFT } from "./menu-row.tsx";
import { CalendarMenu, CrmMenu, DriveMenu, MailMenu } from "./menu-rows.tsx";
import { WorkspaceButton } from "./menu-workspace.tsx";
import { ModuleActionPill } from "./module-action.tsx";
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
          <View style={styles.headerLead}>
            <Mark size={20} />
          </View>
          <Text size="md" weight="semibold" numberOfLines={1}>
            {entry.label}
          </Text>
        </View>
      ) : null}
      <ScrollView
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.rows}
      >
        <Rows />
      </ScrollView>
      <View
        style={[
          styles.footer,
          {
            paddingHorizontal: Math.max(insets.bottom - space(1), space(5)),
            paddingBottom: Math.max(insets.bottom - space(1), space(5)),
          },
        ]}
      >
        <WorkspaceButton />
        <ModuleActionPill />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  drawer: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: colors.sidebar,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingLeft: MENU_INSET + NAV_PAD_LEFT,
    paddingRight: MENU_INSET + space(3),
    paddingBottom: space(2.5),
  },
  headerLead: {
    width: NAV_LEAD,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: { flex: 1 },
  rows: { paddingHorizontal: MENU_INSET, paddingTop: space(1), paddingBottom: space(4) },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: space(2),
  },
});
