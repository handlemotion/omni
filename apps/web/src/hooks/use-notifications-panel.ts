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
