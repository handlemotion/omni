import { accentChain } from "glimm";
import { GlimmScope, type GlimmScopeHandle } from "glimm/react";
import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

// The sweep that reveals smart search results, confined to the mail list's rows: the sidebar and
// the list's header stay still. GlimmScope reveals a change by wiping the box's old content away
// behind its band, so it has to outlive the change. Every list route (inbox, search, ...) mounts
// its own `List`, so the scope lives in the app shell instead, in a node each `List` moves into
// its rows slot and renders its rows into. Under reduced motion GlimmScope applies the change
// with no sweep.

interface ListSweep {
  scope: RefObject<GlimmScopeHandle | null>;
  /** The scope's DOM, moved into whichever list's rows slot is mounted. */
  host: HTMLDivElement;
  /** Inside the scope: where the mounted list renders its rows. */
  rows: HTMLDivElement | null;
}

const ListSweepContext = createContext<ListSweep | null>(null);

// glimm's `azure` stops (cyan, blue, indigo) with blue doubled so it carries most of the band,
// then a short violet tail so the band isn't one flat blue. Violet rather than green: green
// reads as "done". A shader palette takes colors, not CSS tokens.
const BAND = accentChain(["#00C0E8", "#0088FF", "#0088FF", "#6155F5", "#9B4DF5"]);

// glimm fades a contained band out over its last 24px towards each edge (its `auto` feather).
// The scope reaches that far past the list's sides, where the slot clips it, so the band runs
// to the real edges (the sidebar's border, the window's edge) instead of fading short of them.
const FEATHER = 24;

export function ListSweepProvider({ children }: { children: ReactNode }) {
  const scope = useRef<GlimmScopeHandle>(null);
  const [host] = useState(() => {
    const el = document.createElement("div");
    el.className = "absolute inset-0";
    return el;
  });
  const [rows, setRows] = useState<HTMLDivElement | null>(null);
  return (
    <ListSweepContext value={{ scope, host, rows }}>
      {children}
      {createPortal(
        // Top to bottom from the top edge, as the popover closes above it. `curve`: glimm's
        // starting point for a whole view.
        <GlimmScope
          ref={scope}
          direction="ttb"
          palette={BAND}
          curve={0.12}
          style={{ position: "absolute", inset: `0 -${FEATHER}px` }}
        >
          {/* Filled: the sweep reveals by wiping away a frozen copy of the old rows, which has to
              hide the new ones under it (the list itself is transparent). Inset by the overhang,
              so the rows sit where the slot is. */}
          <div
            ref={setRows}
            className="flex h-full flex-col bg-background"
            style={{ paddingInline: FEATHER }}
          />
        </GlimmScope>,
        host,
      )}
    </ListSweepContext>
  );
}

function useListSweepContext() {
  const ctx = use(ListSweepContext);
  if (!ctx) throw new Error("List rows need a ListSweepProvider above them.");
  return ctx;
}

/** Where a list's rows go: inside the sweep's scope, which this slot holds while mounted. */
export function ListSweepSlot({ children }: { children: ReactNode }) {
  const { host, rows } = useListSweepContext();
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    slot.current?.appendChild(host);
  }, [host]);
  return (
    <div ref={slot} className="relative min-h-0 flex-1 overflow-hidden">
      {rows && createPortal(children, rows)}
    </div>
  );
}

/** Runs `change` (a navigation) and reveals the rows it brings with a sweep down the list. */
export function useListSweep() {
  const { scope } = useListSweepContext();
  // A returned promise (the route change) holds the band until the new rows have painted.
  return (change: () => void | Promise<unknown>) => scope.current?.play({ change });
}
