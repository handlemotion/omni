// Placeholder UI: a bare compose form. `?mailbox=&to=&subject=` prefill it (deep links).
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMailboxes } from "../../../hooks/use-mail.ts";
import { useSend } from "../../../hooks/use-mail-actions.ts";
import { composeSearch } from "../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/_member/compose")({
  validateSearch: composeSearch,
  component: Compose,
});

const splitAddresses = (value: string) =>
  value
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);

function Compose() {
  const search = Route.useSearch();
  const mailboxes = useMailboxes();
  const send = useSend();
  const [mailboxId, setMailboxId] = useState(search.mailbox ?? "");
  const [to, setTo] = useState(search.to ?? "");
  const [subject, setSubject] = useState(search.subject ?? "");
  const [text, setText] = useState("");
  const from = mailboxId || mailboxes.data?.[0]?.id || "";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send.mutate({ mailboxId: from, to: splitAddresses(to), subject, text });
      }}
    >
      <select value={from} onChange={(event) => setMailboxId(event.target.value)}>
        {mailboxes.data?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.address}
          </option>
        ))}
      </select>
      <input placeholder="to" value={to} onChange={(event) => setTo(event.target.value)} />
      <input
        placeholder="subject"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
      />
      <textarea value={text} onChange={(event) => setText(event.target.value)} />
      <button type="submit" disabled={send.isPending}>
        Send
      </button>
      {send.isSuccess && <p>Queued: {send.data.actionId}</p>}
      {send.error && <p>{send.error.message}</p>}
    </form>
  );
}
