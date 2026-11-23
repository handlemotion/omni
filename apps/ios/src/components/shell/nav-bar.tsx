import type { ComponentType, ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import {
  IconBubble,
  IconBuildings,
  IconChecklist,
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
interface Pill {
  id: string;
  label: string;
  here: boolean;
  glyph: ReactNode;
  open: () => void;
}
interface Shortcut {
  id: string;
  icon: Glyph;
  label: string;
}

/** The bar's height, and how far above the home indicator it floats. */
export const NAV_BAR = space(12);
const NAV_HANDLE = space(4);
/** The rail's whole height: its handle and its row. */
export const RAIL_BLOCK = NAV_HANDLE + NAV_BAR;

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
 * The rail, on every page: a handle on top; the current module on the left; in the middle the
 * module's main pages as glyphs, or the modules while the rail is up; the module's main action
 * (compose, new file, new record) on the right. White pills with a hairline edge across the
 * page's width, the current one marked in grey. Pulling the rail (it sits in the frame's pull)
 * or tapping the handle or the module raises it, the page above, the module's pages beneath.
 */
export function NavBar() {
  const shell = useMenu();
  const place = useMenuPlace();
  const modules = useModules();
  const entry = modules.find((m) => m.id === place.module);
  const shortcuts = useShortcuts();
  const Mark = entry?.mark;
  const items: Pill[] = shell.isOpen
    ? modules.map((m) => ({
        id: m.id,
        label: m.label,
        here: m.id === place.module,
        glyph: <m.mark size={22} />,
        open: () => place.openModule(m.id),
      }))
    : shortcuts.items.map(({ id, icon: Icon, label }) => {
        const here = id === shortcuts.current && place.onRoot;
        return {
          id,
          label,
          here,
          glyph: (
            <Icon size={iconSize.md} color={here ? colors.foreground : colors.mutedForeground} />
          ),
          open: () => shortcuts.open(id),
        };
      });
  return (
    <View pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={shell.isOpen ? "Hide pages" : "All pages and modules"}
        accessibilityState={{ expanded: shell.isOpen }}
        hitSlop={space(2)}
        onPress={shell.toggle}
        style={styles.handle}
      >
        <View style={styles.grabber} />
      </Pressable>
      <View pointerEvents="box-none" style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${entry?.label ?? "Modules"}, all pages and modules`}
          onPress={shell.toggle}
          style={({ pressed }) => [styles.round, pressed && styles.pressed]}
        >
          {Mark ? <Mark size={22} /> : null}
        </Pressable>
        {items.length ? (
          <View accessibilityRole="tablist" style={styles.pages}>
            {items.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="tab"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: item.here }}
                onPress={item.open}
                style={[styles.page, item.here && styles.here]}
              >
                {item.glyph}
              </Pressable>
            ))}
          </View>
        ) : (
          <View style={styles.spacer} />
        )}
        <ModuleMainAction />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  handle: { height: NAV_HANDLE, alignItems: "center", justifyContent: "center" },
  grabber: {
    width: space(7),
    height: space(0.75),
    borderRadius: radius.full,
    backgroundColor: colors.hairlineLine,
  },
  spacer: { flex: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingHorizontal: space(4),
  },
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
  pressed: { transform: [{ scale: 0.97 }] },
});
