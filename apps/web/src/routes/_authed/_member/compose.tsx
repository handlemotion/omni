import { createFileRoute } from "@tanstack/react-router";
import { useComposeMailboxes } from "../../../components/compose/compose-pane.tsx";
import { NewMessageComposer } from "../../../components/compose/composer.tsx";
import { composeSearch } from "../../../lib/search-params.ts";

/** New mail. `?mailbox=&to=&subject=` prefill it (deep links). */
export const Route = createFileRoute("/_authed/_member/compose")({
  validateSearch: composeSearch,
  component: Compose,
});

function Compose() {
  const search = Route.useSearch();
  const mailboxes = useComposeMailboxes();
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
