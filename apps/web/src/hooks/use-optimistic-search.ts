import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";

/**
 * One search param that changes on screen at once. `set` shows the new value in the same render
 * as the press, then navigates: the router runs every route's guards and loaders before it
 * commits a new URL, which a click shouldn't wait on. Once the router's value lands it takes over;
 * if the navigation ends somewhere else, the router's value shows again. While anything blocks
 * leaving (an editor with unsaved changes), the change waits for the router, so the blocker's
 * save-or-discard step runs before what it guards is replaced. `clear` names params the change
 * removes.
 */
export function useOptimisticSearch(name: string, clear: readonly string[] = []) {
  const routed = (useSearch({ strict: false }) as Record<string, unknown>)[name] as
    | string
    | undefined;
  const navigate = useNavigate();
  const router = useRouter();
  const [pending, setPending] = useState<{ value: string | undefined } | null>(null);
  if (pending && pending.value === routed) setPending(null);
  const cleared = clear.join(",");
  const set = useCallback(
    (value: string | null, replace = false) => {
      const want = { value: value ?? undefined };
      if (router.history._getBlockers().length === 0) setPending(want);
      const dropped = Object.fromEntries(
        (cleared ? cleared.split(",") : []).map((key) => [key, undefined]),
      );
      void navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          ...dropped,
          [name]: want.value,
        })) as never,
        replace,
      }).finally(() => {
        const now = (router.state.location.search as Record<string, unknown>)[name];
        if (now !== want.value) setPending((held) => (held === want ? null : held));
      });
    },
    [navigate, router, name, cleared],
  );
  return [pending ? pending.value : routed, set] as const;
}
