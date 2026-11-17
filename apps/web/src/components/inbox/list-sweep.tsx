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

interface ListSweep {
  scope: RefObject<GlimmScopeHandle | null>;
  host: HTMLDivElement;
  rows: HTMLDivElement | null;
}

const ListSweepContext = createContext<ListSweep | null>(null);

const BAND = accentChain(["#00C0E8", "#0088FF", "#0088FF", "#6155F5", "#9B4DF5"]);

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
        <GlimmScope
          ref={scope}
          direction="ttb"
          palette={BAND}
          curve={0.12}
          pageEffect={false}
          style={{ position: "absolute", inset: `0 -${FEATHER}px` }}
        >
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
  return (change: () => void | Promise<unknown>) => scope.current?.play({ change });
}
