import { useRouter } from "@tanstack/react-router";
import { useShortcut } from "./use-shortcuts.ts";

export function useDesktopShortcuts() {
  const router = useRouter();
  useShortcut("back", () => {
    if (router.history.canGoBack()) router.history.back();
  });
  useShortcut("forward", () => router.history.forward());
  useShortcut("reload", () => window.location.reload());
}
