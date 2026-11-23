import {
  createContext,
  use,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Module, PlaceParams } from "./menu-nav.ts";

export interface ShellState {
  /** The module panel is open (dragged up from the bottom notch). */
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** What the bottom bar's search field holds; the module's root page shows its results. */
  query: string;
  setQuery: (q: string) => void;
  /** The bottom bar's search field is open (the top bar and module notch step away). */
  searching: boolean;
  /** The module whose search field is open, or null; a search belongs to one module. */
  searchIn: Module | null;
  setSearchIn: (module: Module | null) => void;
  /** The page each module was last left on, to reopen it there. */
  lastPlace: Partial<Record<Module, PlaceParams>>;
  remember: (module: Module, params: PlaceParams) => void;
  /** The root page's rows have scrolled under the top bar. */
  scrolled: boolean;
  setScrolled: (scrolled: boolean) => void;
}

const ShellContext = createContext<ShellState | null>(null);

/** The shell's shared state: the module panel, scroll edge, and the bottom bar's search. */
export function MenuProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [searchIn, setSearchIn] = useState<Module | null>(null);
  const [lastPlace, setLastPlace] = useState<Partial<Record<Module, PlaceParams>>>({});
  const remember = useCallback((module: Module, params: PlaceParams) => {
    setLastPlace((was) => {
      const before = was[module];
      const same =
        before?.page === params.page &&
        before?.space === params.space &&
        before?.mailbox === params.mailbox;
      return same ? was : { ...was, [module]: params };
    });
  }, []);
  const value = useMemo(
    () => ({
      isOpen,
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((was) => !was),
      query,
      setQuery,
      searching: searchIn !== null,
      searchIn,
      setSearchIn,
      lastPlace,
      remember,
      scrolled,
      setScrolled,
    }),
    [isOpen, query, searchIn, lastPlace, remember, scrolled],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** The page each module was last left on; empty outside the signed-in shell. */
export function useLastPlaces() {
  return use(ShellContext)?.lastPlace ?? {};
}

/** The shell's state, for its bars, its module panel and the module pages under them. */
export function useMenu() {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useMenu needs a MenuProvider above it");
  return shell;
}
