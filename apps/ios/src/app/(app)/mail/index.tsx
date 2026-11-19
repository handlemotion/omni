import { Stack, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { SearchResults } from "@/components/inbox/search-results.tsx";
import { ThreadList } from "@/components/inbox/thread-list.tsx";
import { ModuleToolbar } from "@/components/shell/module-toolbar.tsx";
import { useCountedPages } from "@/lib/mail-counts.ts";
import { MAIL_PAGES, isMailPage, mailboxName, useMailboxes, type MailPage } from "@/lib/mail.ts";
import { useSession } from "@/lib/session.ts";
import { useDebounced } from "@/lib/use-debounced.ts";

const PAGES = Object.entries(MAIL_PAGES).map(([id, page]) => ({ ...page, id: id as MailPage }));

/** A mail page (Inbox, Later, Sent, …): every mailbox here, or the one picked in the menu. */
export default function MailList() {
  const params = useLocalSearchParams<{ page?: string; mailbox?: string }>();
  const page = isMailPage(params.page) ? params.page : "inbox";
  const session = useSession();
  const mailboxes = useMailboxes();
  const you = session.data?.user.name || session.data?.user.email || "";
  const mailbox = mailboxes.data?.find((m) => m.id === params.mailbox);
  const label = MAIL_PAGES[page].label;
  const pages = useCountedPages(PAGES, mailbox?.id);
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed.trim());
  return (
    <>
      <Stack.SearchBar
        placeholder="Search mail"
        autoCapitalize="none"
        onChangeText={(event) => setTyped(event.nativeEvent.text)}
        onCancelButtonPress={() => setTyped("")}
      />
      <Stack.Screen
        options={{ title: mailbox ? `${label} · ${mailboxName(mailbox, you)}` : label }}
      />
      <ModuleToolbar
        pages={pages}
        current={page}
        onPage={(id) => router.setParams({ page: id })}
        actions={
          <Stack.Toolbar.Button
            icon="square.and.pencil"
            accessibilityLabel="New message"
            onPress={() =>
              router.push({
                pathname: "/mail/compose",
                params: mailbox ? { mailbox: mailbox.id } : {},
              })
            }
          />
        }
      >
        <Stack.Toolbar.Menu inline title="Mailboxes">
          <Stack.Toolbar.MenuAction
            icon="tray.2"
            isOn={!mailbox}
            onPress={() => router.setParams({ mailbox: undefined })}
          >
            All mailboxes
          </Stack.Toolbar.MenuAction>
          {(mailboxes.data ?? []).map((m) => (
            <Stack.Toolbar.MenuAction
              key={m.id}
              icon={m.kind === "shared" ? "person.2" : "person"}
              isOn={m.id === mailbox?.id}
              onPress={() => router.setParams({ mailbox: m.id })}
            >
              {mailboxName(m, you)}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </ModuleToolbar>
      {typed.trim() ? (
        <SearchResults q={q} />
      ) : (
        <ThreadList
          page={page}
          mailboxId={mailbox?.id}
          mailboxes={mailboxes.data ?? []}
          you={you}
        />
      )}
    </>
  );
}
