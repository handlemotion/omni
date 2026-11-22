import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { currentWorkspaceId } from "./current-workspace.ts";
import { keys } from "./query-keys.ts";
import {
  driveKey,
  driveOf,
  type StorageListPage,
  type StorageNode,
  type StoragePlace,
} from "./storage.ts";

type ListData = InfiniteData<StorageListPage, string | null>;

/** Where a node is listed: inside its folder, or at its drive's root. */
export const placeOf = (node: Pick<StorageNode, "parentId" | "space" | "teamspaceId">) =>
  (node.parentId ? { parentId: node.parentId } : driveOf(node)) satisfies StoragePlace;

const placeIn = (key: QueryKey) => key.at(-1) as StoragePlace;

const lists = (client: QueryClient) =>
  client.getQueriesData<ListData>({ queryKey: keys.storageLists() });

const holds = (place: StoragePlace, node: StorageNode) =>
  "parentId" in place
    ? place.parentId === node.parentId
    : node.parentId === null &&
      ("teamspaceId" in place
        ? place.teamspaceId === node.teamspaceId
        : !node.teamspaceId && place.space === node.space);

/** The Worker's order: folders first, then by lowercased name, then by id. */
export function compareNodes(a: StorageNode, b: StorageNode) {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const without: (data: ListData, id: string) => ListData = (data, id) => {
  if (!data.pages.some((page) => page.nodes.some((n) => n.id === id))) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, nodes: page.nodes.filter((n) => n.id !== id) })),
  };
};

const withNode: (data: ListData, node: StorageNode) => ListData = (data, node) => {
  const rest = without(data, node.id);
  const at = rest.pages.findIndex(
    (page, i) =>
      (i === rest.pages.length - 1 && page.nextCursor === null) ||
      page.nodes.some((n) => compareNodes(node, n) < 0),
  );
  if (at < 0) return rest;
  return {
    ...rest,
    pages: rest.pages.map((page, i) => {
      if (i !== at) return page;
      const nodes = [...page.nodes];
      const before = nodes.findIndex((n) => compareNodes(node, n) < 0);
      nodes.splice(before < 0 ? nodes.length : before, 0, node);
      return { ...page, nodes };
    }),
  };
};

const withFolder: (data: ListData, node: StorageNode) => ListData = (data, node) => {
  const [first, ...rest] = data.pages;
  const folder = first?.folder;
  if (!first || !folder || !folder.path.some((step) => step.id === node.id)) return data;
  const path = folder.path.map((step) =>
    step.id === node.id ? { ...step, name: node.name } : step,
  );
  const own = folder.node.id === node.id ? { node } : {};
  return { ...data, pages: [{ ...first, folder: { ...folder, ...own, path } }, ...rest] };
};

const shows = (data: ListData | undefined, id: string) =>
  !!data?.pages.some((page) => page.nodes.some((n) => n.id === id));
const within = (data: ListData | undefined, id: string) =>
  !!data?.pages[0]?.folder?.path.some((step) => step.id === id);

const touching = (client: QueryClient, id: string) =>
  lists(client).flatMap(([key, data]) => (shows(data, id) || within(data, id) ? [key] : []));

const BRANCH = keys.storageLists().length - 1;

const refresh = (client: QueryClient, touched: QueryKey[]) =>
  Promise.all([
    ...touched.map((queryKey) => client.invalidateQueries({ queryKey, exact: true })),
    client.invalidateQueries({
      queryKey: keys.storage(),
      predicate: (query) => query.queryKey[BRANCH] !== "list",
    }),
  ]);

const settle = (client: QueryClient, queryKeys: QueryKey[]) =>
  Promise.all(queryKeys.map((queryKey) => client.cancelQueries({ queryKey, exact: true })));

/**
 * `node` as the Worker now has it (made, renamed, moved, restored, uploaded): in the listing of
 * its place, out of every other, and its own listing's title and path renamed. Then the listings
 * it touched are asked again.
 */
export async function storageNodeChanged(client: QueryClient, node: StorageNode) {
  await storageNodesChanged(client, [node]);
}

/**
 * `storageNodeChanged` for many nodes at once, each listing written once for all of them. With
 * `refresh: false` nothing is asked again: a batch (uploads) patches as files land and asks once
 * at the end, through `storageListsRefresh` with the keys this answers.
 */
export async function storageNodesChanged(
  client: QueryClient,
  nodes: StorageNode[],
  options: { refresh?: boolean } = {},
) {
  const workspace = currentWorkspaceId();
  const elsewhere = new Set(
    nodes.flatMap((node) => (node.orgId === workspace ? [] : [node.orgId])),
  );
  await Promise.all(
    [...elsewhere].map((orgId) =>
      client.invalidateQueries({ queryKey: [...keys.root, orgId, "storage"] }),
    ),
  );
  const mine = nodes.filter((node) => node.orgId === workspace);
  const found = new Map<string, QueryKey>();
  for (const node of mine) {
    for (const key of [keys.storageList(placeOf(node)), ...touching(client, node.id)])
      found.set(JSON.stringify(key), key);
  }
  const touched = [...found.values()];
  if (!mine.length) return touched;
  await settle(client, touched);
  for (const [key, data] of lists(client)) {
    if (!data) continue;
    const place = placeIn(key);
    const next = mine.reduce(
      (list, node) =>
        holds(place, node) ? withNode(list, node) : withFolder(without(list, node.id), node),
      data,
    );
    if (next !== data) client.setQueryData<ListData>(key, next);
  }
  if (options.refresh !== false) void refresh(client, touched);
  return touched;
}

/** Asks the listings `touched` again, once each, and every other Drive query but listings. */
export function storageListsRefresh(client: QueryClient, touched: QueryKey[]) {
  const unique = new Map(touched.map((key) => [JSON.stringify(key), key]));
  return refresh(client, [...unique.values()]);
}

/**
 * A folder just made is empty: cached as such, its title and path from its parent's, so opening
 * it or drawing its card asks nothing. A folder the Worker gave another reader's view of is left
 * to its own request.
 */
export function storageFolderMade(client: QueryClient, node: StorageNode) {
  if (node.kind !== "folder" || node.orgId !== currentWorkspaceId()) return;
  const parent = node.parentId
    ? client.getQueryData<ListData>(keys.storageList({ parentId: node.parentId }))?.pages[0]?.folder
    : null;
  if (node.parentId && !parent) return;
  const first: StorageListPage = {
    folder: {
      node,
      role: parent?.role ?? "member",
      path: [...(parent?.path ?? []), { id: node.id, name: node.name }],
    },
    nodes: [],
    nextCursor: null,
  };
  client.setQueryData<ListData>(keys.storageList({ parentId: node.id }), {
    pages: [first],
    pageParams: [null],
  });
}

/**
 * `id` went to Trash or was deleted: out of every listing, and its own listing and those inside
 * it forgotten (Restore lists them afresh); Trash and Search asked again.
 */
export async function storageNodeRemoved(client: QueryClient, id: string) {
  const all = lists(client);
  const gone = all.filter(([, data]) => within(data, id)).map(([key]) => key);
  const showing = all.filter(([key, data]) => shows(data, id) && !gone.includes(key));
  await settle(client, [...gone, ...showing.map(([key]) => key)]);
  for (const queryKey of gone) client.removeQueries({ queryKey, exact: true });
  for (const [key, data] of showing) {
    if (data) client.setQueryData<ListData>(key, without(data, id));
  }
  void refresh(
    client,
    showing.map(([key]) => key),
  );
}

/** What `storage.changed` said: a drive, and the folders whose listing changed (all, absent). */
export interface StorageDriveChange {
  space: string;
  /** The teamspace that changed, when `space` is `teamspace`. */
  teamspaceId?: string | undefined;
  parentIds?: (string | null)[] | undefined;
}

const LIVE_BRANCHES = new Set(["trash", "search", "usage", "icons", "shared-with-me", "node"]);

const driveOfList = (key: QueryKey, data: ListData | undefined) => {
  const place = placeIn(key);
  if ("teamspaceId" in place) return driveKey(place);
  if ("space" in place) return driveKey(place);
  const folder = data?.pages[0]?.folder?.node;
  return folder ? driveKey(driveOf(folder)) : undefined;
};

const staleFor = (change: StorageDriveChange) => {
  const named = change.parentIds && new Set(change.parentIds);
  const changed = change.teamspaceId ? `teamspace:${change.teamspaceId}` : change.space;
  return (key: QueryKey, data: ListData | undefined) => {
    const drive = driveOfList(key, data);
    if (drive !== undefined && drive !== changed) return false;
    if (!named) return true;
    const place = placeIn(key);
    if (!("parentId" in place)) return named.has(null);
    return (
      named.has(place.parentId) || !!data?.pages[0]?.folder?.path.some((step) => named.has(step.id))
    );
  };
};

/**
 * Someone changed a drive (`storage.changed`): the listings it names, and those under a folder it
 * names, are fetched again, and Trash, Search and usage with them. Other listings are kept, so a
 * busy drive does not refetch every folder ever opened.
 */
export function storageDrivesChanged(client: QueryClient, changes: StorageDriveChange[]) {
  const checks = changes.map(staleFor);
  const stale = lists(client).flatMap(([key, data]) =>
    checks.some((check) => check(key, data)) ? [key] : [],
  );
  return Promise.all([
    ...stale.map((queryKey) => client.invalidateQueries({ queryKey, exact: true })),
    client.invalidateQueries({
      queryKey: keys.storage(),
      predicate: (query) => LIVE_BRANCHES.has(String(query.queryKey[BRANCH])),
    }),
  ]);
}

/**
 * What trashing or deleting `id` shows before the Worker answers: out of every listing that shows
 * it. Answers what each of those listings held, for `storageListsPut` when the request fails.
 */
export async function storageNodeAhead(client: QueryClient, id: string) {
  const showing = lists(client).filter(([, data]) => shows(data, id));
  await settle(
    client,
    showing.map(([key]) => key),
  );
  for (const [key, data] of showing) {
    if (data) client.setQueryData<ListData>(key, without(data, id));
  }
  return showing;
}

/**
 * Puts back the listings `storageNodeAhead` changed, then fetches them again: another trash that
 * succeeded meanwhile is in what was held, and the fetch takes it back out.
 */
export function storageListsPut(
  client: QueryClient,
  held: [QueryKey, ListData | undefined][] | undefined,
) {
  for (const [key, data] of held ?? []) {
    client.setQueryData(key, data);
    void client.invalidateQueries({ queryKey: key, exact: true });
  }
}
