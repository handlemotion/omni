import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { MailboxList } from "@/components/inbox/mailbox-list.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { useCounts, useMailboxes } from "@/lib/mail.ts";
import { signOut, useSession } from "@/lib/session.ts";
import { space } from "@/theme/tokens.ts";

/** The mailbox sheet: pick an inbox, or all of them; sign out at the bottom. */
export default function Mailboxes() {
  const { current } = useLocalSearchParams<{ current?: string }>();
  const session = useSession();
  const mailboxes = useMailboxes();
  const counts = useCounts();
  const you = session.data?.user.name || session.data?.user.email || "";
  const unread = new Map((counts.data ?? []).map((c) => [c.mailboxId, c.unread]));
  return (
    <Screen edges={["bottom"]}>
      <MailboxList
        mailboxes={mailboxes.data ?? []}
        unread={unread}
        current={current}
        you={you}
        onSelect={(mailbox) =>
          router.dismissTo({ pathname: "/", params: mailbox ? { mailbox } : {} })
        }
      />
      <View style={styles.footer}>
        <Button intent="plain" label="Sign out" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({ footer: { padding: space(4) } });
