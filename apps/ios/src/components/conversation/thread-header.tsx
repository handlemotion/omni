import { StyleSheet, View } from "react-native";
import { IconShared } from "@/components/icons.ts";
import { Text } from "@/components/ui/text.tsx";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";

/** The top of a thread: the subject and, for a shared inbox, which one. */
export function ThreadTitle({ subject, sharedInbox }: { subject: string; sharedInbox?: string }) {
  return (
    <View style={styles.title}>
      <Text size="title" weight="medium" accessibilityRole="header" selectable>
        {subject}
      </Text>
      {sharedInbox ? (
        <View style={styles.inbox}>
          <IconShared size={iconSize.sm} color={colors.mutedForeground} />
          <Text size="sm" tone="mutedForeground" numberOfLines={1} style={styles.shrink}>
            {sharedInbox}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { gap: space(3) },
  inbox: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: space(1),
    paddingHorizontal: space(2.5),
    paddingVertical: space(1),
    borderRadius: radius.full,
    maxWidth: "100%",
    backgroundColor: colors.accent,
  },
  shrink: { flexShrink: 1, minWidth: 0 },
});
