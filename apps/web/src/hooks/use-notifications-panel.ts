// The notifications panel beside the sidebar: the bell toggles it, a desktop notification about
// the workspace opens it. One store, so every opener reaches it without props.
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (open === next) return;
  open = next;
  for (const notify of listeners) notify();
}

export const openNotificationsPanel = () => set(true);
export const closeNotificationsPanel = () => set(false);
export const toggleNotificationsPanel = () => set(!open);

export function useNotificationsPanel() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => open,
  );
}
