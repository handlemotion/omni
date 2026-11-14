import { router, useLocalSearchParams } from "expo-router";
import { InboxHeader } from "@/components/inbox/inbox-header.tsx";
import { ThreadList } from "@/components/inbox/thread-list.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { mailboxName, useMailboxes } from "@/lib/mail.ts";
import { useSession } from "@/lib/session.ts";

/** The inbox: every inbox you can open, or the one picked in the mailbox sheet. */
export default function Inbox() {
  const { mailbox } = useLocalSearchParams<{ mailbox?: string }>();
  const session = useSession();
  const mailboxes = useMailboxes();
  const you = session.data?.user.name || session.data?.user.email || "";
  const current = mailboxes.data?.find((m) => m.id === mailbox);
  return (
    <Screen edges={["top"]}>
      <InboxHeader
        title={current ? mailboxName(current, you) : "All mailboxes"}
        you={you}
        onOpenMailboxes={() =>
          router.push({ pathname: "/mailboxes", params: mailbox ? { current: mailbox } : {} })
        }
      />
      <ThreadList mailboxId={current?.id} mailboxes={mailboxes.data ?? []} you={you} />
    </Screen>
  );
}
