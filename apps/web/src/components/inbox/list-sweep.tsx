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
        // Top to bottom from the top edge, as the popover closes above it. Azure: the preset
        // closest to the brand blue (the 0.4 default, spectrum, is a full rainbow). The band
        // fades out towards the box's edges on its own (glimm's `feather`, on for any canvas
        // smaller than the viewport). `curve`: glimm's starting point for a whole view.
        <GlimmScope
          ref={scope}
          direction="ttb"
          palette="azure"
          curve={0.12}
          style={{ position: "absolute", inset: 0 }}
        >
          {/* Filled: the sweep reveals by wiping away a frozen copy of the old rows, which has to
              hide the new ones under it (the list itself is transparent). */}
          <div ref={setRows} className="flex h-full flex-col bg-background" />
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
    <div ref={slot} className="relative min-h-0 flex-1">
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
