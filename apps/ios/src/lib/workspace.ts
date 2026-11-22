import type { Workspace, Workspaces } from "@omni/client";
import { queryOptions, useQuery, type Query } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import { queryClient } from "./query-client.ts";
import { currentWorkspaceId, storeWorkspaceId, subscribeWorkspaceId } from "./workspace-id.ts";

const isWorkspaceList = (query: Query) => query.queryKey[0] === keys.workspaces()[0];

/**
 * Empties the cache for another workspace or account: calls still running are cancelled, calls
 * from now on name `id`, and every answer `keep` does not hold is dropped. A query a screen still
 * shows is reset rather than removed, so the screen hears that its answer is gone and asks again
 * under `id`; removing it left that screen drawing the last workspace's mail until something
 * else made it render.
 */
export function resetCache(id: string | null, keep: (query: Query) => boolean = () => false) {
  void queryClient.cancelQueries();
  storeWorkspaceId(id);
  const drop = (query: Query) => !keep(query);
  queryClient.removeQueries({ type: "inactive", predicate: drop });
  void queryClient.resetQueries({ predicate: drop });
}

/** Opens a workspace: later calls name it, and nothing read for the last one is shown again. */
export function openWorkspace(id: string | null) {
  if (id === currentWorkspaceId()) return;
  resetCache(id, isWorkspaceList);
}

/** Every workspace the user belongs to, their Personal space included. */
export const workspacesQuery = () =>
  queryOptions({
    queryKey: keys.workspaces(),
    queryFn: ({ signal }) =>
      call(api.workspaces.$get({ query: { include: "personal" } }, { init: { signal } })),
    staleTime: 5 * 60_000,
  });

function resolve(data: Workspaces | undefined, id: string | null) {
  const list = data?.workspaces ?? [];
  return (
    list.find((w) => w.id === id) ??
    list.find((w) => w.id === data?.activeOrganizationId) ??
    list[0]
  );
}

/**
 * The workspace list and the one the app is in (undefined until the list loads). `ready` once
 * calls name `active`: a stored workspace you have left is swapped for another, and with none
 * stored the one the Worker chose is stored, so no call relies on the session's choice.
 */
export function useWorkspace() {
  const workspaces = useQuery(workspacesQuery());
  const id = useSyncExternalStore(subscribeWorkspaceId, currentWorkspaceId);
  const data = workspaces.data;
  const active = resolve(data, id);
  const next = active?.id ?? null;
  const settled = !data || next === id;
  const chosenByWorker = id === null && next !== null && next === data?.activeOrganizationId;
  useEffect(() => {
    if (settled) return;
    if (chosenByWorker) storeWorkspaceId(next);
    else openWorkspace(next);
  }, [settled, chosenByWorker, next]);
  return { workspaces, active, ready: !!active && settled, all: data?.workspaces ?? [] };
}

/** The name a Personal space is made with (`personal-space.ts`), until its owner renames it. */
export const PERSONAL_DEFAULT_NAME = "Personal";

/** A company by its name; the Personal space as the person's own, as the web app says it. */
export function workspaceLabel(workspace: Pick<Workspace, "kind" | "name">, userName?: string) {
  if (workspace.kind !== "personal" || workspace.name !== PERSONAL_DEFAULT_NAME)
    return workspace.name;
  const first = userName?.trim().split(/\s+/)[0];
  return first ? `${first}'s Workspace` : "Personal Workspace";
}

/** Every workspace has a CRM and a Shared drive, once it is known. */
export const hasCrm = (workspace: Pick<Workspace, "kind"> | undefined) => !!workspace;
