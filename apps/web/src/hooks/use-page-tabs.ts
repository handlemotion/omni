import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
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

/** Names the page on its tab (a thread's subject) while it is shown. */
export function usePageTitle(title: string | undefined) {
  const router = useRouter();
  useEffect(() => {
    const href = router.state.location.href;
    pageTabs.name(href, title);
  }, [router, title]);
}
