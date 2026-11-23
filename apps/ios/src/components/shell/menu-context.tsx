import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Module } from "./menu-nav.ts";

export interface ShellState {
  /** The left navigation drawer is open (the current page slid right to reveal it). */
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** What the bottom bar's search field holds; the module's root page shows its results. */
  query: string;
  setQuery: (q: string) => void;
  /** The bottom bar's search field is open (the top bar and module dock step away). */
  searching: boolean;
  /** The module whose search field is open, or null; a search belongs to one module. */
  searchIn: Module | null;
  setSearchIn: (module: Module | null) => void;
  /** The root page's rows have scrolled under the top bar. */
  scrolled: boolean;
  setScrolled: (scrolled: boolean) => void;
}

const ShellContext = createContext<ShellState | null>(null);

/** The shell's shared state: the left drawer, scroll edge, and the bottom bar's search. */
export function MenuProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [searchIn, setSearchIn] = useState<Module | null>(null);
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
      scrolled,
      setScrolled,
    }),
    [isOpen, query, searchIn, scrolled],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** The shell's state, for its bars, its drawer and the module pages under them. */
export function useMenu() {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useMenu needs a MenuProvider above it");
  return shell;
}
