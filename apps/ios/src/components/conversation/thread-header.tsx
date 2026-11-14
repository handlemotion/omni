import { StyleSheet, View } from "react-native";
import { IconChevronLeft, IconShared } from "@/components/icons.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";

/** The top of a thread: back, then the subject and, for a shared inbox, which one. */
export function ThreadToolbar({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.toolbar}>
      <IconButton icon={IconChevronLeft} label="Back" onPress={onBack} />
    </View>
  );
}

export function ThreadTitle({ subject, sharedInbox }: { subject: string; sharedInbox?: string }) {
  return (
    <View style={styles.title}>
      <Text size="title" weight="semibold" accessibilityRole="header" selectable>
        {subject}
      </Text>
      {sharedInbox ? (
        <View style={styles.inbox}>
          <IconShared size={iconSize.sm} color={colors.mutedForeground} />
          <Text size="sm" tone="mutedForeground">
            {sharedInbox}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: "row", paddingHorizontal: space(2), paddingVertical: space(1) },
  title: { gap: space(2), alignItems: "flex-start" },
  inbox: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1),
    paddingHorizontal: space(2),
    paddingVertical: space(1),
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
  },
});
