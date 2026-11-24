import { useSyncExternalStore } from "react";

/**
 * Page tabs: several pages open at once, across every workspace the person is in, like a
 * browser's tabs inside the app. The router shows one page at a time; a tab is where to return
 * (its href, `/<workspace>/…`) and its workspace is the href's first segment, so a tab of another
 * workspace switches workspace when it is shown. The active tab follows the page the router
 * shows. Kept per browser in local storage.
 */

export interface PageTab {
  id: string;
  href: string;
}

export interface PageTabsState {
  tabs: PageTab[];
  activeId: string;
}

export const PAGE_TABS_MAX = 10;
const STORAGE_KEY = "omni:page-tabs";

export type TabModule = "mail" | "files" | "crm" | "calendar" | "meetings" | "settings";

/** The workspace slug an href is under. */
export const tabWorkspace = (href: string) =>
  decodeURIComponent(href.split(/[?#]/)[0]!.split("/")[1] ?? "");

const parts = (href: string) => {
  const url = new URL(href, "https://omni.invalid");
  return { segments: url.pathname.split("/").slice(2), search: url.searchParams };
};

export function tabModule(href: string) {
  const [root] = parts(href).segments;
  if (root === "files" || root === "crm" || root === "calendar" || root === "meetings") return root;
  if (root === "settings") return "settings";
  return "mail";
}

const MAIL: Record<string, string> = {
  inbox: "Inbox",
  later: "Later",
  all: "All mail",
  archive: "Archive",
  done: "Done",
  drafts: "Drafts",
  sent: "Sent",
  trash: "Trash",
  spam: "Spam",
  search: "Search",
  compose: "New email",
};
const LANES: Record<string, string> = {
  needs_reply: "Needs reply",
  waiting_on_them: "Awaiting reply",
};
const FILES: Record<string, string> = {
  recents: "Recents",
  trash: "Trash",
  "shared-with-me": "Shared with me",
};
const CRM: Record<string, string> = {
  companies: "Companies",
  people: "People",
  deals: "Deals",
  projects: "Projects",
  tasks: "Tasks",
};

/** A page's name from its path, for a tab no page has named (`usePageTitle`). */
export function tabTitleFromHref(href: string) {
  const { segments, search } = parts(href);
  const [root, section] = segments;
  switch (tabModule(href)) {
    case "files":
      return FILES[section ?? ""] ?? "Drive";
    case "crm":
      return CRM[section ?? ""] ?? "Clients";
    case "calendar":
      return "Calendar";
    case "meetings":
      return "Meetings";
    case "settings":
      return "Settings";
    case "mail":
      return LANES[search.get("lane") ?? ""] ?? MAIL[section ?? ""] ?? (root ? "Mail" : "Inbox");
  }
}

const newId = () => crypto.randomUUID();

export function activeTab(state: PageTabsState) {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];
}

/** The page shown moved: the active tab follows it (the first page makes the first tab). */
export function followPage(state: PageTabsState | null, href: string) {
  if (!state || state.tabs.length === 0) {
    const tab = { id: newId(), href };
    return { tabs: [tab], activeId: tab.id };
  }
  const active = activeTab(state)!;
  if (active.href === href) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === active.id ? { ...tab, href } : tab)),
  };
}

export function openTab(state: PageTabsState, href: string, activate: boolean) {
  if (state.tabs.length >= PAGE_TABS_MAX) return state;
  const tab = { id: newId(), href };
  const at = state.tabs.findIndex((t) => t.id === state.activeId);
  const tabs = [...state.tabs];
  tabs.splice(at + 1, 0, tab);
  return { tabs, activeId: activate ? tab.id : state.activeId };
}

/** Closing the active tab shows the one to its right, else its left. The last tab stays. */
export function closeTab(state: PageTabsState, id: string) {
  if (state.tabs.length <= 1) return state;
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId =
    state.activeId === id ? tabs[Math.min(index, tabs.length - 1)]!.id : state.activeId;
  return { tabs, activeId };
}

export function closeOtherTabs(state: PageTabsState, id: string) {
  const keep = state.tabs.find((tab) => tab.id === id);
  return keep ? { tabs: [keep], activeId: keep.id } : state;
}

export function moveTab(state: PageTabsState, id: string, to: number) {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from === -1 || from === to) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(tabs.length, to)), 0, tab!);
  return { ...state, tabs };
}

function parse(raw: string | null) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PageTabsState>;
    const tabs = (Array.isArray(value.tabs) ? value.tabs : [])
      .filter(
        (tab): tab is PageTab =>
          typeof tab?.id === "string" &&
          typeof tab.href === "string" &&
          tab.href.startsWith("/") &&
          !tab.href.startsWith("//"),
      )
      .slice(0, PAGE_TABS_MAX);
    if (tabs.length === 0) return null;
    const activeId = tabs.some((tab) => tab.id === value.activeId) ? value.activeId! : tabs[0]!.id;
    return { tabs, activeId };
  } catch {
    return null;
  }
}

let state: PageTabsState | null =
  typeof window === "undefined" ? null : parse(window.localStorage.getItem(STORAGE_KEY));
const titles = new Map<string, string>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

function set(next: PageTabsState | null) {
  if (next === state) return;
  state = next;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

let switchingTo: string | null = null;
let switchedAt = 0;
const startSwitch = (href: string) => {
  switchedAt = performance.now();
  switchingTo = tabWorkspace(href);
};

export const pageTabs = {
  get: () => state,
  /**
   * After a tab is shown, a page of another workspace that lands late (a switch started before)
   * is not that tab's: it is ignored until the tab's own workspace shows.
   */
  follow: (href: string) => {
    if (switchingTo !== null) {
      const late = tabWorkspace(href) !== switchingTo && performance.now() - switchedAt < 10_000;
      switchingTo = late ? switchingTo : null;
      if (late) return;
    }
    set(followPage(state, href));
  },
  open: (href: string, activate: boolean) => {
    if (!state) return;
    if (activate) startSwitch(href);
    set(openTab(state, href, activate));
  },
  activate: (id: string) => {
    const tab = state?.tabs.find((t) => t.id === id);
    if (!state || !tab) return;
    startSwitch(tab.href);
    set({ ...state, activeId: id });
  },
  close: (id: string) => {
    if (!state) return;
    const next = closeTab(state, id);
    if (next.activeId !== state.activeId) startSwitch(activeTab(next)!.href);
    set(next);
  },
  closeOthers: (id: string) => {
    if (!state) return;
    if (state.activeId !== id) pageTabs.activate(id);
    set(closeOtherTabs(state, id));
  },
  move: (id: string, to: number) => state && set(moveTab(state, id, to)),
  /** What a page calls itself (a thread's subject), shown on the tabs that hold it. */
  name: (href: string, title: string | undefined) => {
    const path = href.split(/[?#]/)[0]!;
    if (title ? titles.get(path) === title : !titles.has(path)) return;
    if (title) titles.set(path, title);
    else titles.delete(path);
    if (state) state = { ...state };
    emit();
  },
  title: (href: string) => titles.get(href.split(/[?#]/)[0]!) ?? tabTitleFromHref(href),
};

export const usePageTabs = () => useSyncExternalStore(subscribe, () => state);
