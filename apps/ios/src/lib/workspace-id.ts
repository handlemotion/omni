import * as SecureStore from "./secure-store";

const KEY = "omni_workspace";
let current: string | null = SecureStore.getItem(KEY);
const listeners = new Set<() => void>();

/** The workspace calls name, or null before one is chosen (the Worker then uses the session's). */
export const currentWorkspaceId = () => current;

export function storeWorkspaceId(id: string | null) {
  current = id;
  if (id) SecureStore.setItem(KEY, id);
  else void SecureStore.deleteItemAsync(KEY);
  for (const listener of listeners) listener();
}

export function subscribeWorkspaceId(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
