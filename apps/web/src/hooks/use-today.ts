import { useEffect, useState } from "react";

/**
 * The local day (`Date.toDateString()`), which changes at midnight, so relative dates (Today,
 * Yesterday, a row's time or day) move on while a list stays open. A tab woken from sleep
 * catches up when it is shown again, since a sleeping tab's timer can fire late.
 */
export function useToday() {
  const [today, setToday] = useState(() => new Date().toDateString());
  useEffect(() => {
    const sync = () => setToday(new Date().toDateString());
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    // A second past midnight, so the new day has begun when it fires.
    const timer = setTimeout(sync, nextMidnight.getTime() - now.getTime() + 1000);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [today]);
  return today;
}
