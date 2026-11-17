// Storage's cached folder contents kept exact as changes land (ADR 0034). A change answers with
// the node as it now is, so it is written straight into every cached listing it touches: added
// where it lives now, dropped wherever it was, and a new folder is cached as the empty folder it
// is. A folder card's stack reads the same cache, so it shows the change the moment the Worker
// answers. Only the listings the change touched are then asked again, so the server's order and
// anything another tab did converge without refetching every folder on screen.
import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { currentWorkspaceId } from "./current-workspace.ts";
import { keys } from "./query-keys.ts";
import type { StorageListPage, StorageNode, StoragePlace } from "./storage.ts";

type ListData = InfiniteData<StorageListPage, string | null>;

/** Where a node is listed: inside its folder, or at its space's root. */
export const placeOf = (node: StorageNode): StoragePlace =>
  node.parentId ? { parentId: node.parentId } : { space: node.space };

const placeIn = (key: QueryKey) => key.at(-1) as StoragePlace;

const lists = (client: QueryClient) =>
  client.getQueriesData<ListData>({ queryKey: keys.storageLists() });

const holds = (place: StoragePlace, node: StorageNode) =>
  "parentId" in place
    ? place.parentId === node.parentId
    : node.parentId === null && place.space === node.space;

/** The Worker's order: folders first, then by lowercased name, then by id. */
export function compareNodes(a: StorageNode, b: StorageNode) {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function without(data: ListData, id: string): ListData {
  if (!data.pages.some((page) => page.nodes.some((n) => n.id === id))) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, nodes: page.nodes.filter((n) => n.id !== id) })),
  };
}

/**
 * `data` with `node` in its place by the Worker's order. Past the loaded pages (more to load) it
 * is left out: its own page brings it.
 */
function withNode(data: ListData, node: StorageNode): ListData {
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
}

/** The folder's own listing and those inside it, renamed: its new name in their paths. */
function withFolder(data: ListData, node: StorageNode): ListData {
  const [first, ...rest] = data.pages;
  const folder = first?.folder;
  if (!first || !folder || !folder.path.some((step) => step.id === node.id)) return data;
  const path = folder.path.map((step) =>
    step.id === node.id ? { ...step, name: node.name } : step,
  );
  const own = folder.node.id === node.id ? { node } : {};
  return { ...data, pages: [{ ...first, folder: { ...folder, ...own, path } }, ...rest] };
}

const shows = (data: ListData | undefined, id: string) =>
  !!data?.pages.some((page) => page.nodes.some((n) => n.id === id));
/** Lists of folder `id` itself or a folder inside it: their path names it. */
const within = (data: ListData | undefined, id: string) =>
  !!data?.pages[0]?.folder?.path.some((step) => step.id === id);

/** Lists that show `id`, or are `id` or a folder inside it. */
const touching = (client: QueryClient, id: string) =>
  lists(client).flatMap(([key, data]) => (shows(data, id) || within(data, id) ? [key] : []));

/** Where a listing sits in a Storage key: `["omni", <workspace>, "storage", "list", place]`. */
const BRANCH = keys.storageLists().length - 1;

/**
 * Asked again, in the background: the change already shows. The folder lists the change touched,
 * and everything in Storage that is not a folder list (Search, Trash, usage, a shared link's
 * view, sharing, Shared with me, the cluster glyphs): each of those may name the node, and only
 * the ones on screen refetch. Folder lists it did not touch are left alone; refetching all of
 * those is what made every change reload every folder card on screen.
 */
const refresh = (client: QueryClient, touched: QueryKey[]) =>
  Promise.all([
    ...touched.map((queryKey) => client.invalidateQueries({ queryKey, exact: true })),
    client.invalidateQueries({
      queryKey: keys.storage(),
      predicate: (query) => query.queryKey[BRANCH] !== "list",
    }),
  ]);

/**
 * A request still on its way for a listing about to change would land after the change with
 * what was there before it: stopped first, it is asked again after.
 */
const settle = (client: QueryClient, queryKeys: QueryKey[]) =>
  Promise.all(queryKeys.map((queryKey) => client.cancelQueries({ queryKey, exact: true })));

/**
 * `node` as the Worker now has it (made, renamed, moved, restored, uploaded): in the listing of
 * its place, out of every other, and its own listing's title and path renamed.
 */
export async function storageNodeChanged(client: QueryClient, node: StorageNode) {
  // Answered after the tab moved to another workspace: the keys below are that one's, so the
  // workspace it came from refetches its Storage instead.
  if (node.orgId !== currentWorkspaceId()) {
    return client.invalidateQueries({ queryKey: [...keys.root, node.orgId, "storage"] });
  }
  const here = keys.storageList(placeOf(node));
  const touched = [here, ...touching(client, node.id)];
  await settle(client, touched);
  for (const [key, data] of lists(client)) {
    if (!data) continue;
    const next = holds(placeIn(key), node)
      ? withNode(data, node)
      : withFolder(without(data, node.id), node);
    if (next !== data) client.setQueryData<ListData>(key, next);
  }
  void refresh(client, touched);
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
