import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import { driveKey, type DriveRoot } from "./storage.ts";

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
export const storageFolderIconsQuery = (drive: DriveRoot) =>
  queryOptions({
    queryKey: keys.storageIcons(driveKey(drive)),
    queryFn: ({ signal }) =>
      call(
        api.storage.icons.$get(
          {
            query:
              "teamspaceId" in drive ? { teamspace: drive.teamspaceId } : { space: drive.space },
          },
          { init: { signal } },
        ),
      ),
  });
