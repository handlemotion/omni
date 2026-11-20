import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { EmptyState } from "../components/empty/empty-state.tsx";
import { DriveDragProvider } from "../components/storage/drive-drag.tsx";
import { LinkFrame } from "../components/storage/link-frame.tsx";
import { LinkPage, UnlockLink } from "../components/storage/link-page.tsx";
import { ApiError } from "../lib/api.ts";
import { linkSearch } from "../lib/search-params.ts";
import { sessionQuery } from "../lib/session.ts";
import { storageLinkQuery } from "../lib/storage-sharing.ts";

export const Route = createFileRoute("/s/$shareId")({
  validateSearch: linkSearch,
  loaderDeps: ({ search: { node } }) => ({ node }),
  loader: async ({ context, params, deps }) => {
    const session = context.queryClient.prefetchQuery(sessionQuery());
    try {
      await context.queryClient.ensureInfiniteQueryData(
        storageLinkQuery(params.shareId, deps.node),
      );
    } catch (error) {
      await session;
      if (error instanceof ApiError && error.status === 404) throw notFound();
      if (error instanceof ApiError && error.code === "link_locked") return { locked: true };
      throw error;
    }
    await session;
    return { locked: false };
  },
  component: Link,
  notFoundComponent: () => (
    <LinkFrame>
      <EmptyState figure="loupe" title="Not found" />
    </LinkFrame>
  ),
});

function Link() {
  const { shareId } = Route.useParams();
  const { node } = Route.useSearch();
  const { locked } = Route.useLoaderData();
  const router = useRouter();
  if (locked) return <UnlockLink shareId={shareId} onUnlocked={() => void router.invalidate()} />;
  return (
    <DriveDragProvider>
      <LinkPage key={`${shareId}:${node ?? ""}`} shareId={shareId} nodeId={node} />
    </DriveDragProvider>
  );
}
