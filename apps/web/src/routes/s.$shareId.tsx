// A shared link (ADR 0034 decision 4): `/s/<shareId>`, signed in or not. The API answers 404 for
// a link that opens nothing to this reader (a Restricted link without a session, a reset one), and
// the page is then the app's not-found.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { LinkPage } from "../components/storage/link-page.tsx";
import { ApiError } from "../lib/api.ts";
import { linkSearch } from "../lib/search-params.ts";
import { storageLinkQuery } from "../lib/storage-sharing.ts";

export const Route = createFileRoute("/s/$shareId")({
  validateSearch: linkSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    try {
      await context.queryClient.ensureInfiniteQueryData(
        storageLinkQuery(params.shareId, deps.node),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw notFound();
      throw error;
    }
  },
  component: Link,
});

function Link() {
  const { shareId } = Route.useParams();
  const { node } = Route.useSearch();
  return <LinkPage key={`${shareId}:${node ?? ""}`} shareId={shareId} nodeId={node} />;
}
