import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { desktop } from "@/lib/desktop.ts";

const SEGOE_FLUENT_GLYPH = { minimize: "", maximize: "", restore: "", close: "" };

let drawn = false;
let claiming: Promise<void> | undefined;
const listeners = new Set<() => void>();

function claim() {
  claiming ??= desktop.frame.claim().then((claimed) => {
    drawn = claimed;
    for (const listener of listeners) listener();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** True once the page draws the window's controls (the desktop app on Windows). */
export const useWindowControls = () => useSyncExternalStore(subscribe, () => drawn);

function useMaximized(on: boolean) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => (on ? desktop.frame.onMaximized(setMaximized) : undefined), [on]);
  return maximized;
}

function useWindowActive(on: boolean) {
  const [active, setActive] = useState(() => document.hasFocus());
  useEffect(() => {
    if (!on) return;
    const focus = () => setActive(true);
    const blur = () => setActive(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, [on]);
  return active;
}

/**
 * Minimize, maximize (restore when maximized) and close at the window's top right corner, drawn as
 * Windows draws them, on every screen. In the desktop app on Windows only: the page takes the
 * native frame off first, and a shell that won't let it keeps its frame and gets no second set.
 */
export function WindowControls() {
  useEffect(claim, []);
  const on = useWindowControls();
  const maximized = useMaximized(on);
  const active = useWindowActive(on);
  if (!on) return null;
  return (
    <div className="fixed end-0 top-0 z-100 flex" data-inactive={active ? undefined : ""}>
      <Button
        intent="caption"
        size="caption"
        aria-label="Minimize"
        onPress={desktop.frame.minimize}
      >
        {SEGOE_FLUENT_GLYPH.minimize}
      </Button>
      <Button
        intent="caption"
        size="caption"
        aria-label={maximized ? "Restore" : "Maximize"}
        onPress={desktop.frame.toggleMaximize}
      >
        {maximized ? SEGOE_FLUENT_GLYPH.restore : SEGOE_FLUENT_GLYPH.maximize}
      </Button>
      <Button
        intent="caption-close"
        size="caption"
        aria-label="Close"
        onPress={desktop.frame.close}
      >
        {SEGOE_FLUENT_GLYPH.close}
      </Button>
    </div>
  );
}
