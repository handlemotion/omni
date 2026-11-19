import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import type { DriveNode } from "./drive.ts";
import { keys } from "./query-keys.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

type ListPage = InferResponseType<Api["storage"]["nodes"]["$get"], 200>;
type ListData = InfiniteData<ListPage, string | null>;

const DRIVE = keys.driveAll()[0];

const lists = (client: QueryClient) =>
  client
    .getQueriesData<ListData>({ queryKey: [DRIVE] })
    .filter(([key]) => key[1] === "personal" || key[1] === "shared" || key[1] === "folder");

const holds = (key: QueryKey, node: DriveNode) =>
  key[1] === "folder" ? key[2] === node.parentId : node.parentId === null && key[1] === node.space;

function compareNodes(a: DriveNode, b: DriveNode) {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const shows = (data: ListData | undefined, id: string) =>
  !!data?.pages.some((page) => page.nodes.some((n) => n.id === id));

const within = (data: ListData | undefined, id: string) =>
  !!data?.pages[0]?.folder?.path.some((step) => step.id === id);

const without = (data: ListData, id: string) =>
  (shows(data, id)
    ? {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          nodes: page.nodes.filter((n) => n.id !== id),
        })),
      }
    : data) satisfies ListData;

function withNode(data: ListData, node: DriveNode) {
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

function outOfTrash(client: QueryClient, id: string) {
  client.setQueryData<InfiniteData<{ nodes: DriveNode[]; nextCursor: string | null }>>(
    keys.drive("trash"),
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          nodes: page.nodes.filter((n) => n.id !== id),
        })),
      },
  );
}

const refresh = (client: QueryClient) => client.invalidateQueries({ queryKey: [DRIVE] });

/**
 * `node` as the Worker now has it (made, renamed, moved, restored, uploaded): in the listing of
 * its place, out of every other, then all of Drive asked again. The web's `storageNodeChanged`.
 */
export async function driveNodeChanged(client: QueryClient, node: DriveNode) {
  const workspace = currentWorkspaceId();
  if (workspace && node.orgId !== workspace) return refresh(client);
  await client.cancelQueries({ queryKey: [DRIVE] });
  for (const [key, data] of lists(client)) {
    if (!data) continue;
    const next = holds(key, node) ? withNode(data, node) : without(data, node.id);
    if (next !== data) client.setQueryData<ListData>(key, next);
  }
  outOfTrash(client, node.id);
  client.setQueryData(keys.driveNode(node.id), { node });
  void refresh(client);
}

/**
 * `id` went to Trash or was deleted for good: out of every listing, and its own listing and
 * those inside it forgotten. The web's `storageNodeRemoved`.
 */
export async function driveNodeRemoved(client: QueryClient, id: string) {
  await client.cancelQueries({ queryKey: [DRIVE] });
  for (const [key, data] of lists(client)) {
    if (within(data, id)) client.removeQueries({ queryKey: key, exact: true });
    else if (data && shows(data, id)) client.setQueryData<ListData>(key, without(data, id));
  }
  outOfTrash(client, id);
  client.removeQueries({ queryKey: keys.driveNode(id), exact: true });
  void refresh(client);
}
