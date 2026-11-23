import type { ComponentType } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import {
  IconBubble,
  IconBuildings,
  IconChecklist,
  IconChevronDown,
  IconClock,
  IconClock3,
  IconHandshake,
  IconInbox,
  IconMail,
  IconTrash,
  IconUserRound,
  IconUsers,
} from "@/components/icons.ts";
import { MAIL_PAGES, type MailPage } from "@/lib/mail.ts";
import { CRM_PAGES, type CrmPage } from "@/lib/crm.ts";
import { DRIVE_PAGES, type DrivePage } from "@/lib/drive.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { ModuleMainAction } from "./module-action.tsx";
import { useModules } from "./modules.ts";

type Glyph = ComponentType<SvgProps & { size?: number }>;
interface Shortcut {
  id: string;
  icon: Glyph;
  label: string;
}

/** The bar's height, and how far above the home indicator it floats. */
export const NAV_BAR = space(12);
export const NAV_CHEVRON = space(7);

const MAIL: { id: MailPage; icon: Glyph }[] = [
  { id: "inbox", icon: IconInbox },
  { id: "needsReply", icon: IconBubble },
  { id: "later", icon: IconClock },
  { id: "all", icon: IconMail },
];
const CRM: { id: CrmPage; icon: Glyph }[] = [
  { id: "companies", icon: IconBuildings },
  { id: "people", icon: IconUsers },
  { id: "deals", icon: IconHandshake },
  { id: "tasks", icon: IconChecklist },
];

function useShortcuts() {
  const place = useMenuPlace();
  const company = hasCrm(useWorkspace().active);
  if (place.module === "mail") {
    return {
      current: place.mailPage,
      items: MAIL.map((p) => ({ ...p, label: MAIL_PAGES[p.id].label })),
      open: (id: string) => place.openMail({ page: id as MailPage }),
    };
  }
  if (place.module === "crm") {
    return {
      current: place.crmPage,
      items: CRM.map((p) => ({ ...p, label: CRM_PAGES[p.id].label })),
      open: (id: string) => place.openPage("crm", id),
    };
  }
  if (place.module === "drive") {
    const drive: { id: DrivePage; icon: Glyph }[] = [
      { id: "recents", icon: IconClock3 },
      { id: "my", icon: IconUserRound },
      ...(company ? [{ id: "shared" as const, icon: IconUsers }] : []),
      { id: "trash", icon: IconTrash },
    ];
    return {
      current: place.drivePage,
      items: drive.map((p) => ({ ...p, label: DRIVE_PAGES[p.id].label })),
      open: (id: string) => place.openPage("drive", id),
    };
  }
  return { current: undefined, items: [] as Shortcut[], open: () => {} };
}

/**
 * The floating navigation on every page: the current module on the left (it opens the full
 * navigation), the module's main pages as glyphs in a pill in the middle, the module's main action
 * (compose, new file, new record) on the right, white pills with a hairline edge across the page's width, the current page marked in grey. A chevron under them slides the
 * page up onto the full navigation.
 */
export function NavBar({ bottom }: { bottom: number }) {
  const shell = useMenu();
  const place = useMenuPlace();
  const entry = useModules().find((m) => m.id === place.module);
  const shortcuts = useShortcuts();
  const Mark = entry?.mark;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom }]}>
      <View pointerEvents="box-none" style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${entry?.label ?? "Modules"}, switch module`}
          onPress={shell.open}
          style={({ pressed }) => [styles.round, pressed && styles.pressed]}
        >
          {Mark ? <Mark size={22} /> : null}
        </Pressable>
        {shortcuts.items.length ? (
          <View accessibilityRole="tablist" style={styles.pages}>
            {shortcuts.items.map(({ id, icon: Icon, label }) => {
              const here = id === shortcuts.current && place.onRoot;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="tab"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: here }}
                  onPress={() => shortcuts.open(id)}
                  style={[styles.page, here && styles.here]}
                >
                  <Icon
                    size={iconSize.md}
                    color={here ? colors.foreground : colors.mutedForeground}
                  />
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <ModuleMainAction />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="All pages and modules"
        hitSlop={space(2)}
        onPress={shell.open}
        style={styles.chevron}
      >
        <IconChevronDown size={iconSize.md} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 0, right: 0, paddingHorizontal: space(4) },
  row: { flexDirection: "row", alignItems: "center", gap: space(2) },
  round: {
    width: NAV_BAR,
    height: NAV_BAR,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  pages: {
    flex: 1,
    height: NAV_BAR,
    flexDirection: "row",
    alignItems: "center",
    padding: space(1),
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  page: {
    flex: 1,
    height: "100%",
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  here: { backgroundColor: colors.well },
  chevron: { height: NAV_CHEVRON, alignSelf: "center", justifyContent: "center" },
  pressed: { transform: [{ scale: 0.97 }] },
});
