import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { IconCheck, IconChevronsUpDown } from "@/components/icons.ts";
import { MailboxAvatar } from "@/components/inbox/mailbox-avatar.tsx";
import { MailboxCluster, type ClusterFace } from "@/components/inbox/mailbox-cluster.tsx";
import { BottomSheet, useSheet } from "@/components/ui/bottom-sheet.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { mailboxName, useMailboxes } from "@/lib/mail.ts";
import { useSession } from "@/lib/session.ts";
import { colors, iconSize, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { MenuRow } from "./menu-row.tsx";

const BLANK: ClusterFace[] = ["a", "b"].map((key) => ({ key, name: "", mailbox: null }));
const SHEET_LEAD = space(9);

/**
 * The mail menu's first row, as the web's mailbox switcher: which mailbox mail shows (All
 * mailboxes as their faces clustered), opening a sheet to choose another.
 */
export function MailboxChooser() {
  const { close } = useMenu();
  const place = useMenuPlace();
  const sheet = useSheet();
  const user = useSession().data?.user;
  const you = user?.name || user?.email || "";
  const mailboxes = useMailboxes().data ?? [];
  const faces: ClusterFace[] = mailboxes.map((mailbox) => ({
    key: mailbox.id,
    name: mailboxName(mailbox, you),
    mailbox,
  }));
  const cluster = faces.length > 0 ? faces : BLANK;
  const shown = mailboxes.find((box) => box.id === place.mailbox);
  const single = shown
    ? faces.find((f) => f.key === shown.id)
    : faces.length === 1
      ? faces[0]
      : null;
  const label = shown ? mailboxName(shown, you) : "All mailboxes";
  const choose = (mailbox: string | null) =>
    sheet.pick(() => {
      place.openMail({ mailbox });
      close();
    });
  return (
    <>
      <MenuRow
        nav
        lead={
          single?.mailbox ? (
            <MailboxAvatar mailbox={single.mailbox} name={single.name} size={iconSize.menu} />
          ) : (
            <MailboxCluster faces={cluster} size={iconSize.menu} />
          )
        }
        label={label}
        trailing={<IconChevronsUpDown size={space(4)} color={colors.mutedForeground} />}
        onPress={sheet.open}
      />
      <BottomSheet
        isOpen={sheet.isOpen}
        onClose={sheet.close}
        onClosed={sheet.onClosed}
        title="Mailboxes"
      >
        <ChoiceRow
          lead={<MailboxCluster faces={cluster} size={SHEET_LEAD} />}
          name="All mailboxes"
          detail={`${faces.length} ${faces.length === 1 ? "mailbox" : "mailboxes"}`}
          chosen={!shown}
          onPress={() => choose(null)}
        />
        {mailboxes.map((mailbox) => {
          const name = mailboxName(mailbox, you);
          return (
            <ChoiceRow
              key={mailbox.id}
              lead={<MailboxAvatar mailbox={mailbox} name={name} size={SHEET_LEAD} />}
              name={name}
              detail={mailbox.address}
              chosen={mailbox.id === shown?.id}
              onPress={() => choose(mailbox.id)}
            />
          );
        })}
      </BottomSheet>
    </>
  );
}

/** A choice in a chooser sheet (a mailbox, a workspace): its avatar, name and any detail, a check on the current one. */
export function ChoiceRow(props: {
  lead: ReactNode;
  name: string;
  /** A second line under the name (a mailbox's address). */
  detail?: string;
  chosen: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <PressableRow
      shape="menu"
      style={[styles.choice, props.style]}
      onPress={props.onPress}
      accessibilityLabel={[props.name, props.detail].filter(Boolean).join(", ")}
    >
      {props.lead}
      <View style={styles.text}>
        <Text size="md" numberOfLines={1}>
          {props.name}
        </Text>
        {props.detail ? (
          <Text size="sm" tone="mutedForeground" numberOfLines={1}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      <View style={styles.check}>
        {props.chosen ? <IconCheck size={iconSize.md} color={colors.foreground} /> : null}
      </View>
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  choice: { paddingVertical: space(3.5) },
  text: { flex: 1, minWidth: 0, gap: space(0.5) },
  check: { width: iconSize.md, alignItems: "center" },
});
