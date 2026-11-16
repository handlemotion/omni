// Settings is a page in the app shell: `/settings/<page>`, its nav in the sidebar's place. ⌘., the
// workspace menu and the bell's settings button open it; its Back row (and ⌘. again) returns to
// where the app was. Both places are remembered here, outside React, so any opener can use them.
import { useLocation, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

export const SETTINGS_PAGES = [
  "profile",
  "security",
  "shortcuts",
  "notifications",
  "accounts",
  "forwarding",
  "general",
  "people",
  "inboxes",
  "shared",
  "helpdesk",
  "pipeline",
  "ai",
  "billing",
] as const;

export type SettingsPageId = (typeof SETTINGS_PAGES)[number];

export function isSettingsPage(page: string): page is SettingsPageId {
  return (SETTINGS_PAGES as readonly string[]).includes(page);
}

export const isSettingsPath = (pathname: string) =>
  pathname === "/settings" || pathname.startsWith("/settings/");

/** The settings page shown last: `/settings` and ⌘. open it. */
let lastPage: SettingsPageId = "profile";
/** Where the app was before settings opened: Back returns here. */
let appHref = "/inbox";

export function rememberSettingsPage(page: SettingsPageId) {
  lastPage = page;
}

export function lastSettingsPage() {
  return lastPage;
}

/** Called by the shell on every move outside settings. */
export function rememberAppHref(href: string) {
  appHref = href;
}

export function settingsBackHref() {
  return appHref;
}

/** `open(page)` opens settings on `page`, or on the page it showed last. */
export function useOpenSettings() {
  const router = useRouter();
  return useCallback(
    (page?: SettingsPageId) =>
      void router.navigate({ to: "/settings/$page", params: { page: page ?? lastPage } }),
    [router],
  );
}

/** ⌘.: opens settings, or leaves it for where the app was. */
export function useToggleSettings() {
  const router = useRouter();
  const open = useOpenSettings();
  const { pathname } = useLocation();
  return useCallback(() => {
    if (isSettingsPath(pathname)) void router.history.push(appHref);
    else open();
  }, [pathname, router, open]);
}
