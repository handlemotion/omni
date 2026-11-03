// Placeholder UI shared by the list and thread routes (the `-` prefix keeps the router from
// treating this file as a route). It renders raw data to prove the wiring; replace it with real
// components in `src/components` and keep the hooks.
import { useState } from "react";
import { useThread } from "../hooks/use-mail.ts";
import {
  useArchive,
  useDefer,
  useMarkDone,
  useMarkRead,
  useMarkReadOnOpen,
  useMarkUndone,
  useSendReply,
} from "../hooks/use-mail-actions.ts";
import { attachmentUrl, messageHtmlUrl } from "../lib/urls.ts";

/** A deferral whose time has passed is over: the thread is back in the inbox. */
function isDeferred(until: string | null) {
  return until !== null && new Date(until).getTime() > Date.now();
}

export function ThreadView({ threadId }: { threadId: string }) {
  const { thread, pending } = useThread(threadId);
  useMarkReadOnOpen(thread);
  const archive = useArchive();
  const markRead = useMarkRead();
  const defer = useDefer();
  const markDone = useMarkDone();
  const markUndone = useMarkUndone();
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
          thread.done
            ? markUndone.mutate({ threadId })
            : markDone.mutate({ threadId, through: thread.lastMessageAt })
        }
      >
        {thread.done ? "Not done" : "Done"}
      </button>
      <button
        type="button"
        onClick={() =>
          defer.mutate({
            threadId,
            until: isDeferred(thread.deferredUntil)
              ? null
              : new Date(Date.now() + 24 * 60 * 60 * 1000),
          })
        }
      >
        {isDeferred(thread.deferredUntil) ? "Back to inbox" : "Defer a day"}
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
