// Placeholder UI shared by the list and thread routes (the `-` prefix keeps the router from
// treating this file as a route). It renders raw data to prove the wiring; replace it with real
// components in `src/components` and keep the hooks.
import type { ReactNode } from "react";
import { useState } from "react";
import { useThreads, useThread } from "../hooks/use-mail.ts";
import {
  useArchive,
  useMarkRead,
  useMarkReadOnOpen,
  useSendReply,
  useSnooze,
} from "../hooks/use-mail-actions.ts";
import type { ThreadFilter } from "../lib/types.ts";
import { attachmentUrl, messageHtmlUrl } from "../lib/urls.ts";

export function ThreadList(props: {
  filter: ThreadFilter;
  link: (threadId: string, children: ReactNode) => ReactNode;
  children?: ReactNode;
}) {
  const { threads, hasNextPage, fetchNextPage, isFetchingNextPage } = useThreads(props.filter);
  return (
    <section>
      <ul>
        {threads.map((t) => (
          <li key={t.id}>
            {props.link(
              t.id,
              <>
                {t.read ? "" : "● "}
                {t.subject || "(no subject)"} · {t.latestFrom?.name ?? t.latestFrom?.address} ·{" "}
                {t.messageCount} · {t.triage ?? "untriaged"} · {t.snippet}
              </>,
            )}
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <button type="button" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
          More
        </button>
      )}
      {props.children}
    </section>
  );
}

export function ThreadView({ threadId }: { threadId: string }) {
  const { thread, pending } = useThread(threadId);
  useMarkReadOnOpen(thread);
  const archive = useArchive();
  const markRead = useMarkRead();
  const snooze = useSnooze();
  const reply = useSendReply();
  const [text, setText] = useState("");

  if (!thread) return null; // The route loader fetched it.
  return (
    <article>
      <p>Summary: {thread.summary ?? "none yet"}</p>
      <button type="button" onClick={() => archive.mutate({ threadId })}>
        Archive
      </button>
      <button type="button" onClick={() => markRead.mutate({ threadId, read: !thread.read })}>
        Mark {thread.read ? "unread" : "read"}
      </button>
      <button
        type="button"
        onClick={() =>
          snooze.mutate({ threadId, until: new Date(Date.now() + 24 * 60 * 60 * 1000) })
        }
      >
        Snooze a day
      </button>
      <ol>
        {thread.messages.map((m) => (
          <li key={m.id}>
            <strong>{m.fromMe ? "me" : (m.fromName ?? m.fromAddress)}</strong> ({m.display})
            {m.addedParticipants.length > 0 &&
              ` added ${m.addedParticipants.map((p) => p.name ?? p.address).join(", ")}`}
            <pre>{m.cleanText}</pre>
            {m.hasHtml && (
              <a href={messageHtmlUrl(threadId, m.id)} target="_blank" rel="noreferrer">
                Full message
              </a>
            )}
            {m.attachments.map((a) => (
              <a key={a.id} href={attachmentUrl(threadId, a.id)}>
                {a.filename}
              </a>
            ))}
          </li>
        ))}
        {pending.map((p) => (
          <li key={p.key}>
            <strong>me</strong> ({p.status}
            {p.error ? `: ${p.error}` : ""})<pre>{p.text}</pre>
          </li>
        ))}
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          reply.mutate({ threadId, text });
          setText("");
        }}
      >
        <textarea value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" disabled={!text.trim()}>
          Reply
        </button>
      </form>
    </article>
  );
}
