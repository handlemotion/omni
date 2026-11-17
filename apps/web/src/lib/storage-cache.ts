import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { currentWorkspaceId } from "./current-workspace.ts";
import { keys } from "./query-keys.ts";
import type { StorageListPage, StorageNode, StoragePlace } from "./storage.ts";

type ListData = InfiniteData<StorageListPage, string | null>;

/** Where a node is listed: inside its folder, or at its space's root. */
export const placeOf = (node: StorageNode) =>
  (node.parentId ? { parentId: node.parentId } : { space: node.space }) satisfies StoragePlace;

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
 * its place, out of every other, and its own listing's title and path renamed.
 */
export async function storageNodeChanged(client: QueryClient, node: StorageNode) {
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
