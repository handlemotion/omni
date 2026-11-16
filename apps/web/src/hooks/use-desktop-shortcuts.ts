// The desktop app's history and reload keys (docs/spec/desktop.md, "Navigation changes in the web
// app"). A browser has its own, so `lib/shortcuts.ts` binds no key to these there. Mount once,
// in the signed-in shell.
import { useRouter } from "@tanstack/react-router";
import { useShortcut } from "./use-shortcuts.ts";

export function useDesktopShortcuts() {
  const router = useRouter();
  // The window's first entry is the desktop app's own start page: going back past the app's
  // first screen would leave Omni for it.
  useShortcut("back", () => {
    if (router.history.canGoBack()) router.history.back();
  });
  useShortcut("forward", () => router.history.forward());
  useShortcut("reload", () => window.location.reload());
}
