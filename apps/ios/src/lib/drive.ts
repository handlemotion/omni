import { infiniteQueryOptions, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { WORKSPACE_HEADER, type Api } from "@omni/client";
import { daysAgo, listTime } from "@omni/mail-core/list-dates";
import type { InferResponseType } from "hono/client";
import { api, auth, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { SymbolName } from "./symbols.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

const PAGE_SIZE = 100;

/** A file or folder, as `/api/storage` answers it. */
export type DriveNode = InferResponseType<Api["storage"]["nodes"]["$get"], 200>["nodes"][number];

/** Drive's pages, as its web sidebar lists them. `Shared` is a company's only. */
export const DRIVE_PAGES = {
  my: { label: "My files", icon: "person", empty: "This folder is empty" },
  shared: { label: "Shared", icon: "person.2", empty: "This folder is empty", company: true },
  sharedWithMe: {
    label: "Shared with me",
    icon: "folder.badge.person.crop",
    empty: "Nothing shared with you yet",
  },
  trash: { label: "Trash", icon: "trash", empty: "Trash is empty" },
} as const satisfies Record<
  string,
  { label: string; icon: SymbolName; empty: string; company?: boolean }
>;

export type DrivePage = keyof typeof DRIVE_PAGES;

export const isDrivePage = (page: string | undefined): page is DrivePage =>
  !!page && Object.hasOwn(DRIVE_PAGES, page);

/**
 * The Drive page a route's `page` param lands on in the active workspace: a page the workspace
 * doesn't have (Shared, outside a company) falls back to My files.
 */
export function drivePageIn(page: string | undefined, company: boolean) {
  if (!isDrivePage(page)) return "my" satisfies DrivePage;
  return "company" in DRIVE_PAGES[page] && !company ? "my" : page;
}

/** A space's top (`my`, `shared`) or a folder's contents: folders first, then by name. */
export const folderQuery = (place: { space: "personal" | "shared" } | { parent: string }) =>
  infiniteQueryOptions({
    queryKey: keys.drive(
      "space" in place ? place.space : "folder",
      "parent" in place ? place.parent : undefined,
    ),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.storage.nodes.$get(
          {
            query: {
              ...place,
              limit: String(PAGE_SIZE),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    select: (data) => data.pages.flatMap((one) => one.nodes),
  });

export const sharedWithMeQuery = () =>
  infiniteQueryOptions({
    queryKey: keys.drive("sharedWithMe"),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.storage["shared-with-me"].$get(
          { query: { limit: String(PAGE_SIZE), ...(pageParam ? { cursor: pageParam } : {}) } },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    select: (data) => data.pages.flatMap((one) => one.items),
  });

export const trashQuery = () =>
  infiniteQueryOptions({
    queryKey: keys.drive("trash"),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.storage.trash.$get(
          { query: { limit: String(PAGE_SIZE), ...(pageParam ? { cursor: pageParam } : {}) } },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    select: (data) => data.pages.flatMap((one) => one.nodes),
  });

export const useFolder = (place: Parameters<typeof folderQuery>[0]) =>
  useInfiniteQuery(folderQuery(place));
export const useSharedWithMe = () => useInfiniteQuery(sharedWithMeQuery());
export const useTrash = () => useInfiniteQuery(trashQuery());

/** The headers a request the app makes outside `call()` needs: the session and the workspace. */
export async function storageHeaders(workspace = currentWorkspaceId()) {
  const headers: Record<string, string> = {};
  const cookie = await auth.getCookie();
  if (cookie) headers.cookie = cookie;
  if (workspace) headers[WORKSPACE_HEADER] = workspace;
  return headers;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** A file's size as people read it: 1.2 MB. */
export function fileSize(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

/** When a file changed, as its row says it: Today, Yesterday, then the list's weekday or date. */
export function fileDay(iso: string, now = new Date()) {
  const ago = daysAgo(new Date(iso), now);
  if (ago <= 0) return "Today";
  if (ago === 1) return "Yesterday";
  return listTime(iso, now);
}

/** Drive search across My files (and Shared, in a company): folders first, then by name. */
export const useDriveSearch = (q: string) =>
  useQuery({
    queryKey: keys.driveSearch(q),
    queryFn: ({ signal }) => call(api.storage.search.$get({ query: { q } }, { init: { signal } })),
    select: (data) => data.nodes,
    enabled: q.trim().length > 0,
    placeholderData: (previous) => previous,
  });
