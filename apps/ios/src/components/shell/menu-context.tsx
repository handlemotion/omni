import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Module } from "./menu-nav.ts";
import { useModules } from "./modules.ts";

export interface ShellState {
  /** The menu covers the module. */
  isOpen: boolean;
  /** Opens the menu on `module`'s page. */
  open: (module: Module) => void;
  close: () => void;
  /**
   * The module the menu (and the top bar's pill) shows while it is open: always one this
   * workspace has, so a switch to a Personal space while CRM shows falls back to the first.
   */
  browsing: Module;
  browse: (module: Module) => void;
  /** What the bottom bar's search field holds; the module's root page shows its results. */
  query: string;
  setQuery: (q: string) => void;
  /** The bottom bar's search field is open (the top bar steps away). */
  searching: boolean;
  /** The module whose search field is open, or null; a search belongs to one module. */
  searchIn: Module | null;
  setSearchIn: (module: Module | null) => void;
  /** The root page's rows have scrolled under the top bar. */
  scrolled: boolean;
  setScrolled: (scrolled: boolean) => void;
}

const ShellContext = createContext<ShellState | null>(null);

/** The shell's shared state: the menu, the module it shows, and the bottom bar's search. */
export function MenuProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [picked, browse] = useState<Module>("mail");
  const modules = useModules();
  const browsing = modules.some((m) => m.id === picked) ? picked : (modules[0]?.id ?? "mail");
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [searchIn, setSearchIn] = useState<Module | null>(null);
  const value = useMemo(
    () => ({
      isOpen,
      open: (module: Module) => {
        browse(module);
        setOpen(true);
      },
      close: () => setOpen(false),
      browsing,
      browse,
      query,
      setQuery,
      searching: searchIn !== null,
      searchIn,
      setSearchIn,
      scrolled,
      setScrolled,
    }),
    [isOpen, browsing, query, searchIn, scrolled],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** The shell's state, for its bars, its menu and the module pages under them. */
export function useMenu() {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useMenu needs a MenuProvider above it");
  return shell;
}
