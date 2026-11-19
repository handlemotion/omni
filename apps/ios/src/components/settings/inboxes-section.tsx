import { Alert, StyleSheet, View } from "react-native";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  INBOX_STATUS,
  useLabelMailbox,
  useSenderName,
  useYourInboxes,
  type YourInbox,
} from "@/lib/settings.ts";
import { currentWorkspaceId } from "@/lib/workspace-id.ts";
import { space } from "@/theme/tokens.ts";
import { SettingsRow, SettingsSection } from "./settings-list.tsx";

function promptName(
  title: string,
  current: string | null,
  onSave: (name: string | null, workspace: string | null) => void,
) {
  const workspace = currentWorkspaceId();
  Alert.prompt(
    title,
    undefined,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Save", onPress: (value?: string) => onSave(value?.trim() || null, workspace) },
    ],
    "plain-text",
    current ?? "",
  );
}

/**
 * Your inboxes here, one card each: its address and sync state, then the label you know it by
 * and the name its mail goes out under, both yours to change when you own it.
 */
export function InboxesSection() {
  const inboxes = useYourInboxes();
  const label = useLabelMailbox();
  const sender = useSenderName();

  const editLabel = (inbox: YourInbox) =>
    promptName("Label this inbox", inbox.label, (next, workspace) =>
      label.mutate(
        { mailboxId: inbox.id, label: next, workspace },
        { onError: (error) => Alert.alert("Couldn't save the label", error.message) },
      ),
    );
  const editSender = (inbox: YourInbox) =>
    promptName("Sender name", inbox.senderName, (next, workspace) =>
      sender.mutate(
        { mailboxId: inbox.id, senderName: next, workspace },
        { onError: (error) => Alert.alert("Couldn't save the sender name", error.message) },
      ),
    );

  if (!inboxes) {
    return (
      <SettingsSection title="Inboxes">
        <View style={styles.loading} accessibilityLabel="Loading inboxes" accessible>
          <Skeleton width="60%" height={14} />
          <Skeleton width="30%" height={12} />
        </View>
      </SettingsSection>
    );
  }
  if (inboxes.length === 0) return null;
  return (
    <View style={styles.list}>
      {inboxes.map((inbox, index) => (
        <SettingsSection key={inbox.id} title={index === 0 ? "Inboxes" : undefined}>
          <SettingsRow label={inbox.address} detail={INBOX_STATUS[inbox.status]} />
          {inbox.owned ? (
            <SettingsRow
              label="Label"
              value={inbox.label}
              accessibilityLabel={`Label, ${inbox.label ?? "none"}`}
              onPress={() => editLabel(inbox)}
            />
          ) : null}
          {inbox.owned ? (
            <SettingsRow
              label="Sender name"
              value={inbox.senderName}
              accessibilityLabel={`Sender name, ${inbox.senderName ?? "none"}`}
              onPress={() => editSender(inbox)}
            />
          ) : null}
        </SettingsSection>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space(4) },
  loading: { padding: space(4), gap: space(2) },
});
