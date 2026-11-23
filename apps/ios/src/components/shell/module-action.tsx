import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { useAddActions } from "@/components/drive/add-menu.tsx";
import { IconCompose, IconFile, IconFolderPlus, IconImage, IconPlus } from "@/components/icons.ts";
import { BottomSheet, useSheet } from "@/components/ui/bottom-sheet.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { CrmPage } from "@/lib/crm.ts";
import { DRIVE_PAGES } from "@/lib/drive.ts";
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

/**
 * The current module's main CTA pill (Compose in Mail, Add in Drive, New in CRM), shared between
 * the bottom floating bar above the module dock and the bottom-right of the left sidebar drawer.
 * Uses tinted Liquid Glass on iOS 26+ and falls back to the solid primary fill elsewhere.
 */
export function ModuleActionPill() {
  const { close } = useMenu();
  const place = useMenuPlace();
  const adding = useSheet();
  const shared = place.drivePage === "shared";
  const add = useAddActions({ space: shared ? "shared" : "personal" });
  const record = NEW_RECORD[place.crmPage ?? "companies"];

  const actions: Partial<Record<Module, FloatingBarAction & { title: string; glyphSize: number }>> =
    {
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

  const action = actions[place.module];
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
      <BottomSheet
        isOpen={adding.isOpen}
        onClose={adding.close}
        onClosed={adding.onClosed}
        title={`Add to ${DRIVE_PAGES[shared ? "shared" : "my"].label}`}
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
