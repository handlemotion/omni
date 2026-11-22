import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

/** What a search keeps besides the name: the team's drives only, files of one type. */
export interface StorageSearchFilter {
  drive?: "team";
  type?: string;
}

/** Files and folders whose name holds `q`, folders first, narrowed by `filter` before the limit. */
export const storageSearchQuery = (q: string, filter?: StorageSearchFilter) =>
  queryOptions({
    queryKey: keys.storageSearch(q, filter),
    queryFn: ({ signal }) =>
      call(api.storage.search.$get({ query: { q, ...filter } }, { init: { signal } })),
    enabled: q.trim().length > 0,
  });

/** A drive's cluster glyphs, by top-level folder id. */
export const storageFolderIconsQuery = (space: "personal" | "shared") =>
  queryOptions({
    queryKey: keys.storageIcons(space),
    queryFn: ({ signal }) =>
      call(api.storage.icons.$get({ query: { space } }, { init: { signal } })),
  });
