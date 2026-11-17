import { createFileRoute } from "@tanstack/react-router";
import { SearchPage } from "../../../../components/storage/search-page.tsx";
import { fileSearchSearch } from "../../../../lib/search-params.ts";
import { storageSearchQuery } from "../../../../lib/storage-find.ts";

export const Route = createFileRoute("/_authed/$workspace/files/search")({
  validateSearch: fileSearchSearch,
  loaderDeps: ({ search }) => ({ q: search.q ?? "" }),
  loader: ({ context, deps }) =>
    void (deps.q && context.queryClient.prefetchQuery(storageSearchQuery(deps.q))),
  component: FileSearch,
});

function FileSearch() {
  const { q } = Route.useSearch();
  return <SearchPage q={q ?? ""} />;
}
