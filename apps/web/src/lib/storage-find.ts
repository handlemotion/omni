import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

/** Files and folders whose name holds `q`, folders first. */
export const storageSearchQuery = (q: string) =>
  queryOptions({
    queryKey: keys.storageSearch(q),
    queryFn: ({ signal }) => call(api.storage.search.$get({ query: { q } }, { init: { signal } })),
    enabled: q.trim().length > 0,
  });

/** A drive's cluster glyphs, by top-level folder id. */
export const storageFolderIconsQuery = (space: "personal" | "shared") =>
  queryOptions({
    queryKey: keys.storageIcons(space),
    queryFn: ({ signal }) =>
      call(api.storage.icons.$get({ query: { space } }, { init: { signal } })),
  });
