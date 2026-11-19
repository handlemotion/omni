import { useLocalSearchParams } from "expo-router";
import { SearchResults } from "@/components/inbox/search-results.tsx";
import { SearchStart } from "@/components/inbox/search-start.tsx";
import { ThreadList } from "@/components/inbox/thread-list.tsx";
import { FLOATING_BAR_SPACE } from "@/components/shell/floating-bar.tsx";
import { useMenu } from "@/components/shell/menu-context.tsx";
import { ModuleRoot } from "@/components/shell/module-root.tsx";
import { isMailPage, useMailboxes } from "@/lib/mail.ts";
import { useSession } from "@/lib/session.ts";
import { useDebounced } from "@/lib/use-debounced.ts";

/** A mail page (Inbox, Later, Sent, …): every mailbox here, or the one picked in the menu. */
export default function MailList() {
  const params = useLocalSearchParams<{ page?: string; mailbox?: string }>();
  const page = isMailPage(params.page) ? params.page : "inbox";
  const session = useSession();
  const mailboxes = useMailboxes();
  const you = session.data?.user.name || session.data?.user.email || "";
  const mailbox = mailboxes.data?.find((m) => m.id === params.mailbox);
  const shell = useMenu();
  const typed = shell.query.trim();
  const q = useDebounced(typed);
  const searching = shell.searchIn === "mail";
  return (
    <ModuleRoot>
      {typed ? (
        <SearchResults q={q} footerSpace={FLOATING_BAR_SPACE} />
      ) : searching ? (
        <SearchStart onSearch={shell.setQuery} />
      ) : (
        <ThreadList
          page={page}
          mailboxId={mailbox?.id}
          mailboxes={mailboxes.data ?? []}
          you={you}
          footerSpace={FLOATING_BAR_SPACE}
        />
      )}
    </ModuleRoot>
  );
}
