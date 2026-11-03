// Placeholder UI: a search box bound to `?q=` and a plain result list.
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useSearch } from "../../../hooks/use-mail.ts";
import { searchQuery } from "../../../lib/mail-queries.ts";
import { searchSearch } from "../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/_member/search")({
  validateSearch: searchSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    if (deps.q.trim()) await context.queryClient.ensureQueryData(searchQuery(deps.q, deps.mailbox));
  },
  component: Search,
});

function Search() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const results = useSearch(search.q, search.mailbox);
  return (
    <section>
      <input
        type="search"
        defaultValue={search.q}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void navigate({ search: { ...search, q: event.currentTarget.value } });
          }
        }}
      />
      <ul>
        {results.data?.map((r) => (
          <li key={r.threadId}>
            <Link to="/search/$threadId" params={{ threadId: r.threadId }} search={search}>
              {r.subject} · {r.from.name ?? r.from.address} · {r.sentAt} · {r.snippet}
            </Link>
          </li>
        ))}
      </ul>
      <Outlet />
    </section>
  );
}
