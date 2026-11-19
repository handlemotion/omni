import * as SecureStore from "./secure-store";

const KEY = "omni_workspace";
let current: string | null = SecureStore.getItem(KEY);
let epoch = 0;
const listeners = new Set<() => void>();

/** The workspace calls name, or null before one is chosen (the Worker then uses the session's). */
export const currentWorkspaceId = () => current;

/**
 * Moves on each time the workspace is set, which is each time the cache is emptied for another
 * workspace or account. A call that began under an older epoch must not write into the cache.
 */
export const cacheEpoch = () => epoch;

export function storeWorkspaceId(id: string | null) {
  current = id;
  epoch += 1;
  if (id) SecureStore.setItem(KEY, id);
  else void SecureStore.deleteItemAsync(KEY);
  for (const listener of listeners) listener();
}

export function subscribeWorkspaceId(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
