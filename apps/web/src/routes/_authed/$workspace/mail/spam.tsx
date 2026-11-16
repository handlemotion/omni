import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../../lib/mail-queries.ts";
import { listSearch } from "../../../../lib/search-params.ts";
import { ThreadList } from "../../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/$workspace/mail/spam")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(threadsQuery({ view: "spam", ...deps })),
  component: SpamMail,
});

function SpamMail() {
  const search = Route.useSearch();
  const router = useRouter();
  const { workspace } = Route.useParams();
  return (
    <ThreadList
      title="Spam"
      filter={{ view: "spam", ...search }}
      href={(threadId) =>
        router.buildLocation({
          to: "/$workspace/mail/spam/$threadId",
          params: { workspace, threadId },
          search,
        }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
