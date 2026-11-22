import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { keys } from "./query-keys.ts";

/**
 * Every CRM write carries this key, so a refetch waits until the last one in flight has answered
 * (`settleCrm`) and realtime echoes of earlier writes don't undo a later one's optimistic change.
 */
export const CRM_WRITE = ["crm-write"] as const;

/** True while any CRM write has not answered yet. */
export const crmWriting = (client: QueryClient) =>
  client.isMutating({ mutationKey: CRM_WRITE }) > 0;

/**
 * What every CRM write does once it answers: refetch the CRM, without holding the write. The
 * caller's `onSuccess` runs on the answer, not after a refetch of every list on screen, and the
 * refetch waits for the last write in flight so it can't show a later one's change undone.
 */
export function settleCrm(client: QueryClient, also?: () => unknown) {
  return {
    mutationKey: CRM_WRITE,
    onSettled: () => {
      if (client.isMutating({ mutationKey: CRM_WRITE }) > 1) return;
      void client.invalidateQueries({ queryKey: keys.crm() });
      also?.();
    },
  };
}

export type CrmSnapshot = [QueryKey, unknown][];

/**
 * Stops CRM fetches in flight (an answer from before the write would undo it) and keeps every
 * CRM query's data, for `restoreCrm` when the write fails.
 */
export async function holdCrm(client: QueryClient) {
  await client.cancelQueries({ queryKey: keys.crm() });
  return client.getQueriesData({ queryKey: keys.crm() }) satisfies CrmSnapshot;
}

/** Puts back what `holdCrm` kept. */
export function restoreCrm(client: QueryClient, snapshot: CrmSnapshot | undefined) {
  for (const [key, data] of snapshot ?? []) client.setQueryData(key, data);
}

type Entity = { id: string } & Record<string, unknown>;

/**
 * Applies `change` to the record with `id` wherever the CRM cache holds it: its own page, every
 * list and board, and the records that embed it (a company's people and deals, a person's deals).
 * Ids are unique across records, so matching on the id alone finds every copy.
 */
export function patchCrmEntity(
  client: QueryClient,
  id: string,
  change: (entity: Entity) => Entity,
) {
  const visit: (value: unknown) => unknown = (value) => {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const visited = visit(item);
        if (visited !== item) changed = true;
        return visited;
      });
      return changed ? next : value;
    }
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (object.id === id) return change(object as Entity);
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      const visited = visit(child);
      if (visited !== child) changed = true;
      next[key] = visited;
    }
    return changed ? next : value;
  };
  for (const [key, data] of client.getQueriesData({ queryKey: keys.crm() })) {
    if (data === undefined) continue;
    const next = visit(data);
    if (next !== data) client.setQueryData(key, next);
  }
}

/** The first copy of the record with `id` the CRM cache holds, wherever it is. */
export function findCrmEntity(client: QueryClient, id: string) {
  const stack = client.getQueriesData({ queryKey: keys.crm() }).map(([, data]) => data);
  while (stack.length) {
    const value = stack.shift();
    if (!value || typeof value !== "object") continue;
    if (!Array.isArray(value) && (value as { id?: unknown }).id === id) return value as Entity;
    stack.unshift(...Object.values(value));
  }
  return undefined;
}

/** Sets `fields` on the record with `id` everywhere it is cached; undefined fields are left. */
export function setCrmFields(client: QueryClient, id: string, fields: Record<string, unknown>) {
  const defined = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(defined).length === 0) return;
  patchCrmEntity(client, id, (entity) => ({ ...entity, ...defined }));
}

/** Takes the rows with `ids` out of every cached page under `queryKey` whose `field` lists them. */
export function dropFromPages(
  client: QueryClient,
  queryKey: QueryKey,
  field: string,
  ids: ReadonlySet<string>,
) {
  client.setQueriesData<InfiniteData<Record<string, unknown>>>({ queryKey }, (data) => {
    if (!data?.pages) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      const rows = page[field];
      if (!Array.isArray(rows)) return page;
      const kept = rows.filter((row: { id?: string }) => !row.id || !ids.has(row.id));
      if (kept.length === rows.length) return page;
      changed = true;
      return { ...page, [field]: kept };
    });
    return changed ? { ...data, pages } : data;
  });
}

/** Takes the record with `id` out of every array the CRM cache holds it in. */
export function dropCrmEntity(client: QueryClient, id: string) {
  const visit: (value: unknown) => unknown = (value) => {
    if (Array.isArray(value)) {
      let changed = false;
      const next: unknown[] = [];
      for (const item of value) {
        if ((item as { id?: unknown } | null)?.id === id) {
          changed = true;
          continue;
        }
        const visited = visit(item);
        if (visited !== item) changed = true;
        next.push(visited);
      }
      return changed ? next : value;
    }
    if (!value || typeof value !== "object") return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const visited = visit(child);
      if (visited !== child) changed = true;
      next[key] = visited;
    }
    return changed ? next : value;
  };
  for (const [key, data] of client.getQueriesData({ queryKey: keys.crm() })) {
    if (data === undefined) continue;
    const next = visit(data);
    if (next !== data) client.setQueryData(key, next);
  }
}

/**
 * The optimistic half of a CRM write: `change` edits the cache before the request goes, and the
 * cache is put back if the request fails.
 */
export function optimisticCrm<V>(client: QueryClient, change: (variables: V) => void) {
  return {
    onMutate: async (variables: V) => {
      const snapshot = await holdCrm(client);
      change(variables);
      return { snapshot };
    },
    onError: (_error: unknown, _variables: V, context: { snapshot: CrmSnapshot } | undefined) =>
      restoreCrm(client, context?.snapshot),
  };
}

/**
 * A teammate's (or our own) CRM change, heard on the socket: the CRM refetches, unless a write of
 * ours is still in flight. That write refetches when it answers, and a refetch now would show its
 * optimistic change undone until then.
 */
export function crmChangedElsewhere(client: QueryClient) {
  if (crmWriting(client)) return;
  void client.invalidateQueries({ queryKey: keys.crm() });
}
