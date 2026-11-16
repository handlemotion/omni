import { useEffect, useState } from "react";

/**
 * False until the browser is first idle after mount (or `now` is true), then true for good: for
 * something mounted but not yet shown, so its rendering and requests stay out of startup.
 */
export function useWhenIdle(now = false) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (idle) return;
    if (typeof requestIdleCallback === "undefined") {
      const timer = setTimeout(() => setIdle(true), 1000);
      return () => clearTimeout(timer);
    }
    const handle = requestIdleCallback(() => setIdle(true), { timeout: 3000 });
    return () => cancelIdleCallback(handle);
  }, [idle]);
  return idle || now;
}
