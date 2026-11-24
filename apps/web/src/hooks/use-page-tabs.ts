import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { activeTab, PAGE_TABS_MAX, pageTabs, usePageTabs } from "@/lib/page-tabs.ts";
import { workspaceHome } from "@/lib/workspaces.ts";

const isShellHref = (href: string) =>
  /^\/[^/?#]+\/(mail|files|crm|calendar|meetings|settings)/.test(href);

/**
 * Keeps the active tab on the page the router shows, and makes ⌘-click (Ctrl-click) or a middle
 * click on an app link open it in a background tab, Shift as well opening it in front. Mount once
 * in the shell.
 */
export function usePageTabsSync() {
  const router = useRouter();
  useEffect(() => {
    const follow = () => {
      const { href } = router.state.resolvedLocation ?? router.state.location;
      if (isShellHref(href)) pageTabs.follow(href);
    };
    follow();
    return router.subscribe("onResolved", follow);
  }, [router]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const modified = event.metaKey || event.ctrlKey || event.button === 1;
      if (!modified || event.defaultPrevented || event.altKey) return;
      if (event.type === "click" && event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const href = `${url.pathname}${url.search}${url.hash}`;
      if (!isShellHref(href)) return;
      const tabs = pageTabs.get();
      if (!tabs || tabs.tabs.length >= PAGE_TABS_MAX) return;
      event.preventDefault();
      event.stopPropagation();
      pageTabs.open(href, event.shiftKey);
      if (event.shiftKey) void router.navigate({ href });
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
    };
  }, [router]);
}

/** The open tabs and what can be done with them; showing a tab navigates to its page. */
export function usePageTabsStrip(workspace: string) {
  const router = useRouter();
  const state = usePageTabs();
  return useMemo(() => {
    const show = () => {
      const tab = state && activeTab(pageTabs.get()!);
      if (tab && tab.href !== router.state.location.href) {
        void router.navigate({ href: tab.href, replace: true });
      }
    };
    return {
      state,
      full: (state?.tabs.length ?? 0) >= PAGE_TABS_MAX,
      title: pageTabs.title,
      activate: (id: string) => {
        pageTabs.activate(id);
        show();
      },
      close: (id: string) => {
        pageTabs.close(id);
        show();
      },
      closeOthers: (id: string) => {
        pageTabs.closeOthers(id);
        show();
      },
      move: pageTabs.move,
      duplicate: (tab: { href: string }) => pageTabs.open(tab.href, false),
      newTab: () => {
        const href = workspaceHome(workspace);
        pageTabs.open(href, true);
        void router.navigate({ href });
      },
    };
  }, [router, state, workspace]);
}

const claims = new Map<string, Map<symbol, { depth: number; title: string }>>();

function nameFromClaims(href: string) {
  let top: { depth: number; title: string } | undefined;
  for (const claim of claims.get(href)?.values() ?? []) {
    if (!top || claim.depth >= top.depth) top = claim;
  }
  if (top) pageTabs.name(href, top.title);
}

/**
 * Names the page on its tab while it is shown: a folder, a record or a thread's subject. `depth`
 * ranks parts of one page: a file open over its folder (1) names the tab over the folder (0).
 */
export function usePageTitle(title: string | undefined, depth = 0) {
  const href = useRouterState({
    select: (s) => (s.status === "idle" ? (s.resolvedLocation ?? s.location).href : undefined),
  });
  const [key] = useState(() => Symbol("page-title"));
  useEffect(() => {
    if (!title || !href) return;
    const own = claims.get(href) ?? new Map();
    claims.set(href, own.set(key, { depth, title }));
    nameFromClaims(href);
    return () => {
      own.delete(key);
      if (own.size === 0) claims.delete(href);
      nameFromClaims(href);
    };
  }, [href, key, title, depth]);
}
