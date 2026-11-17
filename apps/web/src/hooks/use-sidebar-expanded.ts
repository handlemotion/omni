// Which rows of a sidebar tree are open (Drive's folders, the CRM's companies), kept for the tab
// so a tree survives moving between pages. One store per tree, so every row and page agree.
import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const trees = new Map<string, ReadonlySet<string>>();

function read(tree: string) {
  let open = trees.get(tree);
  if (!open) {
    try {
      open = new Set(JSON.parse(sessionStorage.getItem(`omni:tree:${tree}`) ?? "[]") as string[]);
    } catch {
      open = new Set(); // Storage unavailable: open rows last for the page.
    }
    trees.set(tree, open);
  }
  return open satisfies ReadonlySet<string>;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `{ value, toggle }`: whether row `id` of `tree` is open, and the way to flip it. */
export function useSidebarExpanded(tree: string, id: string) {
  const value = useSyncExternalStore(subscribe, () => read(tree).has(id));
  const toggle = useCallback(() => {
    const next = new Set(read(tree));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    trees.set(tree, next);
    try {
      sessionStorage.setItem(`omni:tree:${tree}`, JSON.stringify([...next]));
    } catch {
      // Kept for the page only.
    }
    for (const listener of listeners) listener();
  }, [tree, id]);
  return { value, toggle };
}
