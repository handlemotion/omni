// Whether the app's history can go back or forward from here, for the desktop title bar's
// arrows (docs/spec/desktop.md, "Navigation changes in the web app"). Browsers say nothing about
// forward, so the furthest entry is tracked here: a push cuts off what was ahead of it. It is kept
// in sessionStorage, which a reload keeps, as it keeps the entries ahead.
import { useRouter } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

interface Ends {
  back: boolean;
  forward: boolean;
}

const STORAGE_KEY = "omni.history-furthest";

function stored(): number {
  try {
    return Number(sessionStorage.getItem(STORAGE_KEY) ?? -1);
  } catch {
    return -1;
  }
}

function store(index: number) {
  furthest = index;
  try {
    sessionStorage.setItem(STORAGE_KEY, String(index));
  } catch {
    // Storage blocked: forward is known until the next reload.
  }
}

let furthest = stored();
let ends: Ends = { back: false, forward: false };

function read(index: number): Ends {
  if (index > furthest) store(index);
  const next = { back: index > 0, forward: index < furthest };
  if (next.back !== ends.back || next.forward !== ends.forward) ends = next;
  return ends;
}

export function useHistoryEnds(): Ends {
  const { history } = useRouter();
  return useSyncExternalStore(
    (notify) =>
      history.subscribe(({ action, location }) => {
        // What was ahead of a new entry can't be reached any more.
        if (action.type === "PUSH") store(location.state.__TSR_index);
        notify();
      }),
    () => read(history.location.state.__TSR_index),
  );
}
