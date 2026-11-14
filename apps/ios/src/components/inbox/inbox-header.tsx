import { StyleSheet, View } from "react-native";
import { IconMenu } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { space } from "@/theme/tokens.ts";

/** The inbox's top bar: the mailbox menu, which mailbox this is, and who is signed in. */
export function InboxHeader(props: { title: string; you: string; onOpenMailboxes: () => void }) {
  return (
    <View style={styles.header}>
      <IconButton icon={IconMenu} label="Mailboxes" onPress={props.onOpenMailboxes} />
      <Text
        size="lg"
        weight="semibold"
        numberOfLines={1}
        style={styles.title}
        accessibilityRole="header"
      >
        {props.title}
      </Text>
      <Avatar name={props.you} size={32} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    paddingLeft: space(2),
    paddingRight: space(4),
    paddingVertical: space(1),
  },
  title: { flex: 1 },
});
