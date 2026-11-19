import { useSyncExternalStore } from "react";
import { auth } from "./api.ts";
import * as SecureStore from "./secure-store";
import { currentWorkspaceId, subscribeWorkspaceId } from "./workspace-id.ts";

const KEEP = 5;
const listeners = new Set<() => void>();
const cache = new Map<string, string[]>();

function currentKey() {
  const user = auth.useSession.get().data?.user.id ?? "none";
  const workspace = currentWorkspaceId() ?? "default";
  return `omni_recent_searches_${user}_${workspace}`.replace(/[^\w.-]/g, "_");
}

function read(key: string) {
  const cached = cache.get(key);
  if (cached) return cached;
  let list: string[] = [];
  try {
    const parsed: unknown = JSON.parse(SecureStore.getItem(key) ?? "[]");
    if (Array.isArray(parsed)) list = parsed.filter((q): q is string => typeof q === "string");
  } catch {
    list = [];
  }
  cache.set(key, list);
  return list;
}

/** Keeps `q` as this workspace's latest mail search, newest first, without repeats. */
export function rememberSearch(q: string) {
  const query = q.trim();
  if (!query) return;
  const key = currentKey();
  const next = [query, ...read(key).filter((one) => one.toLowerCase() !== query.toLowerCase())];
  const kept = next.slice(0, KEEP);
  cache.set(key, kept);
  SecureStore.setItem(key, JSON.stringify(kept));
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const stopWorkspace = subscribeWorkspaceId(listener);
  const stopSession = auth.useSession.subscribe(listener);
  return () => {
    listeners.delete(listener);
    stopWorkspace();
    stopSession();
  };
};

/** The signed-in person's latest mail searches in this workspace on this phone, newest first. */
export function useRecentSearches() {
  return useSyncExternalStore(subscribe, () => read(currentKey()));
}
