import { createFileRoute } from "@tanstack/react-router";
import { TrashList } from "../../../../components/storage/trash-list.tsx";
import { listSearch } from "../../../../lib/search-params.ts";
import { storageTrashQuery } from "../../../../lib/storage.ts";

export const Route = createFileRoute("/_authed/$workspace/files/trash")({
  validateSearch: listSearch,
  loader: ({ context }) => void context.queryClient.prefetchInfiniteQuery(storageTrashQuery()),
  component: TrashList,
});
