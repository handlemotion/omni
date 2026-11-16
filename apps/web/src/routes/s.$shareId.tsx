// A shared link (ADR 0034 decision 4): `/s/<shareId>`, signed in or not. The API answers 404 for
// a link that opens nothing to this reader (a Restricted link without a session, a reset one), and
// the page is then the not-found, inside the link page's frame.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { LinkFrame } from "../components/storage/link-frame.tsx";
import { LinkPage } from "../components/storage/link-page.tsx";
import { ApiError } from "../lib/api.ts";
import { linkSearch } from "../lib/search-params.ts";
import { sessionQuery } from "../lib/session.ts";
import { storageLinkQuery } from "../lib/storage-sharing.ts";

export const Route = createFileRoute("/s/$shareId")({
  validateSearch: linkSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    // The frame's Sign in waits on the session; known before render, it never pops in or out.
    // `prefetchQuery` never throws.
    const session = context.queryClient.prefetchQuery(sessionQuery());
    try {
      await context.queryClient.ensureInfiniteQueryData(
        storageLinkQuery(params.shareId, deps.node),
      );
    } catch (error) {
      await session;
      if (error instanceof ApiError && error.status === 404) throw notFound();
      throw error;
    }
    await session;
  },
  component: Link,
  notFoundComponent: () => (
    <LinkFrame>
      <p className="p-5 text-sm text-foreground">Not found.</p>
    </LinkFrame>
  ),
});

function Link() {
  const { shareId } = Route.useParams();
  const { node } = Route.useSearch();
  return <LinkPage key={`${shareId}:${node ?? ""}`} shareId={shareId} nodeId={node} />;
}
