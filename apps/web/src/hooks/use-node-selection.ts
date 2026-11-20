import { useCallback, useMemo, useRef, useState, type PointerEvent, type MouseEvent } from "react";
import type { Selection } from "react-aria-components";
import type { StorageNode } from "@/lib/storage.ts";

/**
 * The items picked in one folder for a bulk action. Empty, the page behaves as it always did: a
 * click opens a folder or previews a file. Cmd/Ctrl- or Shift-click, or Cmd/Ctrl+A, starts it;
 * while it holds anything, a click toggles an item and Shift-click extends within its section.
 */
export interface NodeSelection {
  /** The picked items still listed, in the folder's order. */
  nodes: StorageNode[];
  ids: ReadonlySet<string>;
  active: boolean;
  all: boolean;
  set: (ids: Iterable<string>) => void;
  selectAll: () => void;
  clear: () => void;
  /** A section's change from its list (`GridList` `onSelectionChange`), merged with the rest. */
  changeIn: (section: StorageNode[], keys: Selection) => void;
  /** On a list's wrapper: the modifier click that starts a selection from nothing. */
  start: {
    onPointerDownCapture: (event: PointerEvent) => void;
    onClickCapture: (event: MouseEvent) => void;
  };
}

const rowOf = (target: EventTarget) =>
  target instanceof Element && !target.closest("button, input, [role=menu], [data-slot=control]")
    ? target.closest<HTMLElement>("[role=row][data-key]")
    : null;

/**
 * Selection of `nodes` at `placeKey`: forgotten when the folder changes, and an item that leaves
 * the listing (trashed, moved, by anyone) leaves the selection. `openId` is the previewed file,
 * which a modifier click adds to, as a desktop file browser does.
 */
export function useNodeSelection(
  nodes: StorageNode[],
  placeKey: string,
  openId: string | undefined,
) {
  const [state, setState] = useState({ placeKey, ids: new Set<string>() });
  const picked = state.placeKey === placeKey ? state.ids : EMPTY;
  const swallowClick = useRef(false);

  const set = useCallback(
    (ids: Iterable<string>) => setState({ placeKey, ids: new Set(ids) }),
    [placeKey],
  );
  const clear = useCallback(() => set([]), [set]);
  const selectAll = useCallback(() => set(nodes.map((n) => n.id)), [nodes, set]);

  const listed = useMemo(() => nodes.filter((n) => picked.has(n.id)), [nodes, picked]);
  const ids = useMemo(() => new Set(listed.map((n) => n.id)), [listed]);

  const changeIn = useCallback(
    (section: StorageNode[], keys: Selection) => {
      const inSection = new Set(section.map((n) => n.id));
      const kept = [...ids].filter((id) => !inSection.has(id));
      const chosen = keys === "all" ? [...inSection] : [...keys].map(String);
      set([...kept, ...chosen]);
    },
    [ids, set],
  );

  const start = useMemo(
    () => ({
      onPointerDownCapture: (event: PointerEvent) => {
        if (ids.size > 0 || event.button !== 0) return;
        const range = event.shiftKey;
        if (!range && !event.metaKey && !event.ctrlKey) return;
        const row = rowOf(event.target);
        const id = row?.dataset.key;
        if (!row || !id) return;
        row.focus();
        event.preventDefault();
        event.stopPropagation();
        swallowClick.current = true;
        set(range && openId ? between(nodes, openId, id) : openId ? [openId, id] : [id]);
      },
      onClickCapture: (event: MouseEvent) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [ids.size, nodes, openId, set],
  );

  return {
    nodes: listed,
    ids,
    active: ids.size > 0,
    all: nodes.length > 0 && ids.size === nodes.length,
    set,
    selectAll,
    clear,
    changeIn,
    start,
  } satisfies NodeSelection;
}

const EMPTY: ReadonlySet<string> = new Set();

function between(nodes: StorageNode[], from: string, to: string) {
  const a = nodes.findIndex((n) => n.id === from);
  const b = nodes.findIndex((n) => n.id === to);
  if (a < 0 || b < 0) return [to];
  return nodes.slice(Math.min(a, b), Math.max(a, b) + 1).map((n) => n.id);
}
