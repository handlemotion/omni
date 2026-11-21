import { useEffect, useState } from "react";
import { desktop } from "@/lib/desktop.ts";

/** The version of a desktop app update that is downloaded and waiting for a restart. */
export function useDesktopUpdate() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop.isDesktop) return;
    let live = true;
    void desktop.update.ready().then((ready) => live && setVersion(ready));
    const stop = desktop.update.onReady((ready) => live && setVersion(ready));
    return () => {
      live = false;
      stop();
    };
  }, []);
  return version;
}
