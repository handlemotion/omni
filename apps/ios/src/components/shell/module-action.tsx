import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { useAddActions } from "@/components/drive/add-menu.tsx";
import {
  IconBell,
  IconCompose,
  IconFile,
  IconFolderPlus,
  IconImage,
  IconPlus,
} from "@/components/icons.ts";
import { BottomSheet, useSheet } from "@/components/ui/bottom-sheet.tsx";
import { FloatingGroup, type FloatingGroupAction } from "@/components/ui/floating.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { CrmPage } from "@/lib/crm.ts";
import type { DrivePlace } from "@/lib/drive-actions.ts";
import { DRIVE_PAGES, useTeamspaces } from "@/lib/drive.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";
import type { FloatingBarAction } from "./floating-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace, type Module } from "./menu-nav.ts";
import { MenuRow } from "./menu-row.tsx";

const HAS_GLASS = isLiquidGlassAvailable();

const NEW_RECORD: Record<CrmPage, { kind: string; label: string }> = {
  companies: { kind: "company", label: "New company" },
  people: { kind: "person", label: "New person" },
  deals: { kind: "deal", label: "New deal" },
  projects: { kind: "deal", label: "New deal" },
  tasks: { kind: "task", label: "New task" },
};

type ModuleAction = FloatingBarAction & { title: string; glyphSize: number };

function useModuleAction() {
  const { close } = useMenu();
  const place = useMenuPlace();
  const adding = useSheet();
  const teamspaces = (useTeamspaces().data ?? []).filter((one) => one.role !== null);
  const activeSpace = place.driveSpace
    ? teamspaces.find((one) => one.id === place.driveSpace)
    : undefined;
  const fallbackSpace = !activeSpace && place.drivePage === "recents" ? teamspaces[0] : undefined;
  const shared = place.drivePage === "shared";
  const targetSpace = activeSpace ?? fallbackSpace;
  const addPlace: DrivePlace = targetSpace
    ? { teamspaceId: targetSpace.id }
    : { space: shared ? "shared" : "personal" };
  const addLabel = targetSpace ? targetSpace.name : DRIVE_PAGES[shared ? "shared" : "my"].label;
  const add = useAddActions(addPlace);
  const record = NEW_RECORD[place.crmPage ?? "companies"];

  const actions: Partial<Record<Module, ModuleAction>> = {
    mail: {
      icon: IconCompose,
      glyphSize: 16,
      title: "Compose",
      label: "New message",
      onPress: () => {
        close();
        router.push({
          pathname: "/mail/compose",
          params: place.mailbox ? { mailbox: place.mailbox } : {},
        });
      },
    },
    drive: {
      icon: IconPlus,
      glyphSize: iconSize.md,
      title: "Add",
      label: "Add",
      onPress: () => {
        close();
        adding.open();
      },
    },
    crm: {
      icon: IconPlus,
      glyphSize: iconSize.md,
      title: "New",
      label: record.label,
      onPress: () => {
        close();
        if (record.kind === "task") router.push("/crm/task-new");
        else router.push({ pathname: "/crm/form", params: { kind: record.kind } });
      },
    },
  };

  const sheet = (
    <>
      <BottomSheet
        isOpen={adding.isOpen}
        onClose={adding.close}
        onClosed={adding.onClosed}
        title={`Add to ${addLabel}`}
      >
        <MenuRow
          icon={IconFolderPlus}
          muted
          label="New folder"
          onPress={() => adding.pick(add.newFolder)}
        />
        <MenuRow
          icon={IconImage}
          muted
          label="Photos and videos"
          onPress={() => adding.pick(add.uploadMedia)}
        />
        <MenuRow
          icon={IconFile}
          muted
          label="Choose file"
          onPress={() => adding.pick(add.uploadFiles)}
        />
      </BottomSheet>
    </>
  );
  const action: ModuleAction | undefined = actions[place.module];
  return { action, sheet };
}

/**
 * The module's main action as a pill at the bottom-right of the left sidebar drawer: tinted
 * Liquid Glass on iOS 26+, the solid primary fill elsewhere.
 */
export function ModuleActionPill() {
  const { action, sheet } = useModuleAction();
  if (!action) return null;

  const Icon = action.icon;
  const content = (
    <View style={styles.row}>
      <Icon size={action.glyphSize} color={colors.primaryForeground} />
      <Text size="sm" weight="medium" tone="primaryForeground" numberOfLines={1}>
        {action.title}
      </Text>
    </View>
  );

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={action.label}
        onPress={action.onPress}
        style={({ pressed }) => [pressed && styles.pressed]}
      >
        {HAS_GLASS ? (
          <GlassView
            glassEffectStyle="regular"
            tintColor={colors.primaryButton}
            isInteractive
            style={styles.pill}
          >
            {content}
          </GlassView>
        ) : (
          <View style={[styles.pill, styles.fallback]}>{content}</View>
        )}
      </Pressable>
      {sheet}
    </>
  );
}

/**
 * The top bar's right-hand group, opposite ☰: Mail's Notifications beside the module's main
 * action, in one Liquid Glass pill.
 */
export function ModuleActions() {
  const { action, sheet } = useModuleAction();
  const place = useMenuPlace();
  const { close } = useMenu();
  const group: FloatingGroupAction[] = [];
  if (place.module === "mail") {
    group.push({
      icon: IconBell,
      label: "Notifications",
      onPress: () => {
        close();
        router.push("/mail/notifications");
      },
    });
  }
  if (action) group.push({ icon: action.icon, label: action.label, onPress: action.onPress });
  if (group.length === 0) return null;
  return (
    <>
      <FloatingGroup compact actions={group} />
      {sheet}
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: space(10),
    paddingHorizontal: space(4),
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  fallback: {
    backgroundColor: colors.primaryButton,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
  },
  pressed: {
    transform: [{ scale: 0.97 }],
  },
});
