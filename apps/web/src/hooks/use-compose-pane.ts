// Whether new mail is open in the reading pane, beside the list, where an open thread sits. One
// value for the whole app: Compose and the `c` key open it, the pane's close button and opening
// a thread close it. Not remembered across reloads: a reload lands on the list.
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let current = false;

function set(open: boolean) {
  if (current === open) return;
  current = open;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `[open, close]`. */
export function useComposePane() {
  const open = useSyncExternalStore(subscribe, () => current);
  const close = useCallback(() => set(false), []);
  return [open, close] as const;
}

/** Opens new mail in the pane. An open thread closes first: the pane takes its place. */
export function useOpenCompose() {
  const navigate = useNavigate();
  const location = useLocation();
  const { threadId } = useParams({ strict: false });
  return useCallback(() => {
    set(true);
    // The deep-link page has no list, so no pane: new mail opens beside the inbox instead.
    if (location.pathname === "/compose") return void navigate({ to: "/inbox" });
    if (!threadId) return;
    const path = location.pathname.slice(0, location.pathname.lastIndexOf("/"));
    void navigate({ href: path + location.searchStr });
  }, [navigate, location, threadId]);
}

/** Closes the pane when a thread opens in its place. */
export const closeComposePane = () => set(false);
