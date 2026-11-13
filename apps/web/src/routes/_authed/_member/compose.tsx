import { createFileRoute } from "@tanstack/react-router";
import { NewMessageComposer } from "../../../components/compose/composer.tsx";
import { useAllMailboxes } from "../../../hooks/use-mail.ts";
import { useMember } from "../../../hooks/use-session.ts";
import { composeSearch } from "../../../lib/search-params.ts";

/** New mail. `?mailbox=&to=&subject=` prefill it (deep links). */
export const Route = createFileRoute("/_authed/_member/compose")({
  validateSearch: composeSearch,
  component: Compose,
});

function Compose() {
  const search = Route.useSearch();
  const { member } = useMember();
  // Every address is offered, but the active workspace's come first: without `?mailbox=` the
  // composer sends from the first one, and that must not be another workspace's address.
  const all = useAllMailboxes().data ?? [];
  const mailboxes = [
    ...all.filter((m) => m.orgId === member.orgId),
    ...all.filter((m) => m.orgId !== member.orgId),
  ];
  return (
    <section aria-label="New message" className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-6">
        <NewMessageComposer
          mailboxes={mailboxes}
          initial={{ mailboxId: search.mailbox, to: search.to, subject: search.subject }}
        />
      </div>
    </section>
  );
}
