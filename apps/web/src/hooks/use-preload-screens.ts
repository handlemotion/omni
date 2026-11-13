import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Loads the code of every screen in the app shell (each list, the open thread, compose) once
 * the browser is idle after startup. A screen's code is its own chunk, and the router waits for
 * it before switching: without this, the first visit to a list waits on a download, and on a
 * slow connection the old screen stays up long after the click. Data still loads on the visit
 * (or on hover), so this costs scripts only, most of them shared.
 */
export function usePreloadScreens() {
  const router = useRouter();
  useEffect(() => {
    const preload = () => {
      for (const [id, route] of Object.entries(router.routesById)) {
        if (id.startsWith("/_authed/_member/")) router.loadRouteChunk(route)?.catch(() => {});
      }
    };
    if (typeof requestIdleCallback === "undefined") {
      const timer = setTimeout(preload, 1000);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(preload, { timeout: 3000 });
    return () => cancelIdleCallback(idle);
  }, [router]);
}
