import { StyleSheet, View } from "react-native";
import { IconCircleAlert, IconClock3, IconMail } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { listTime } from "@/lib/mail.ts";
import {
  actorName,
  notificationParts,
  notificationSubject,
  notificationTitle,
  type Notification,
} from "@/lib/notification-text.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";

const LEAD = 28;

/** One notification as the web's panel draws it: who and what, a dot while unread, when, about. */
export function NotificationRow({ n, onPress }: { n: Notification; onPress: () => void }) {
  const unread = !n.readAt;
  const { actor, action } = notificationParts(n);
  const subject = notificationSubject(n);
  return (
    <PressableRow
      onPress={onPress}
      style={styles.row}
      accessibilityLabel={[notificationTitle(n), subject].filter(Boolean).join(", ")}
      accessibilityHint={unread ? "Unread" : undefined}
    >
      <Lead n={n} />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text numberOfLines={1} style={styles.grow}>
            {actor ? (
              <Text tone={unread ? "foreground" : "mutedForeground"}>{`${actor} `}</Text>
            ) : null}
            <Text tone={!actor && unread ? "foreground" : "mutedForeground"}>{action}</Text>
          </Text>
          {unread ? <View style={styles.dot} /> : null}
          <Text size="xs" tone="subtleForeground" tabular>
            {listTime(n.createdAt)}
          </Text>
        </View>
        {subject ? (
          <Text size="sm" tone="subtleForeground" numberOfLines={1}>
            {subject}
          </Text>
        ) : null}
      </View>
    </PressableRow>
  );
}

function Lead({ n }: { n: Notification }) {
  const name = actorName(n);
  if (name) return <Avatar name={name} size={LEAD} />;
  const Glyph =
    n.kind === "sla_breached" ? IconCircleAlert : n.kind === "sla_at_risk" ? IconClock3 : IconMail;
  return (
    <View style={styles.glyph}>
      <Glyph size={iconSize.sm} color={colors.mutedForeground} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: "center" },
  body: { flex: 1, gap: space(1) },
  line: { flexDirection: "row", alignItems: "center", gap: space(2) },
  grow: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.primary },
  glyph: {
    width: LEAD,
    height: LEAD,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
});
