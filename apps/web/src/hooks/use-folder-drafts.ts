// New folders as Finder makes them: New folder shows one at once, at the top of Folders, with its
// name selected to type over; Enter, a press elsewhere, Tab, Esc or leaving the page creates it
// (Esc keeps the name it was given), and the folder takes its place in the list once the Worker
// answers. Each draft steps naming → creating → created, and leaves once the list holds it.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { StorageNode, StoragePlace } from "@/lib/storage.ts";
import { freeFolderName, nameProblem } from "@/lib/storage-names.ts";
import { storageErrorText } from "@/components/storage/storage-errors.ts";
import { appToast } from "@/components/ui/toast";
import { useCreateFolder } from "./use-storage.ts";

export interface FolderDraft {
  /** Its key in the list, kept from New folder until the folder replaces it. */
  key: string;
  place: StoragePlace;
  placeKey: string;
  shareId: string | undefined;
  step: "naming" | "creating" | "created";
  /** The name it was given while naming; the name it is created with after. */
  name: string;
  /** The folder's id, once created. */
  id?: string;
  /** Named from the keyboard: focus moves to the folder once it is in the list. */
  focus: boolean;
}

/** How a name was finished: Enter, Esc, or leaving the field (a click, Tab, another page). */
export type FinishedBy = "enter" | "escape" | "blur";

type Event =
  | { type: "start"; draft: FolderDraft }
  | { type: "commit"; key: string; name: string; focus: boolean }
  | { type: "created"; key: string; id: string }
  | { type: "leave"; key: string };

/** The drafts after `event`. */
export function stepDrafts(drafts: FolderDraft[], event: Event): FolderDraft[] {
  switch (event.type) {
    case "start":
      return [event.draft, ...drafts];
    case "commit":
      return drafts.map((d) =>
        d.key === event.key && d.step === "naming"
          ? { ...d, step: "creating", name: event.name, focus: event.focus }
          : d,
      );
    case "created":
      return drafts.map((d) =>
        d.key === event.key && d.step === "creating" ? { ...d, step: "created", id: event.id } : d,
      );
    case "leave":
      return drafts.filter((d) => d.key !== event.key);
  }
}

/** A created folder that the list has not shown by then leaves anyway (it is past a page). */
const LAND_WITHIN_MS = 4000;

export function useFolderDrafts(source: {
  place: StoragePlace;
  shareId: string | undefined;
  nodes: StorageNode[];
  /** The list has loaded: drafts show inside it, so New folder pressed before waits for it. */
  ready: boolean;
}) {
  const { place, shareId, nodes, ready } = source;
  const placeKey = JSON.stringify(place);
  const [drafts, dispatch] = useReducer(stepDrafts, []);
  const create = useCreateFolder().mutateAsync;
  // Read by callbacks between renders: the drafts, the list, and each draft's text as typed.
  const latest = useRef({ drafts, nodes, placeKey });
  latest.current = { drafts, nodes, placeKey };
  const typed = useRef(new Map<string, string>());
  // A name is finished once: Enter unmounts the field, which can blur it as well.
  const finished = useRef(new Set<string>());

  const siblings = useCallback((draft: FolderDraft) => {
    const { drafts: all, nodes: list, placeKey: here } = latest.current;
    const others = all.filter((d) => d.placeKey === draft.placeKey && d.key !== draft.key);
    return [
      ...(draft.placeKey === here ? list.map((n) => n.name) : []),
      ...others.filter((d) => d.step !== "naming").map((d) => d.name),
    ];
  }, []);

  /** Creates the draft's folder. "stay" when Enter met a name that cannot be used. */
  const finish = useCallback(
    (key: string, value: string, by: FinishedBy): "stay" | "done" => {
      const draft = latest.current.drafts.find((d) => d.key === key);
      if (!draft || draft.step !== "naming" || finished.current.has(key)) return "done";
      const given = value.trim();
      const problem = given ? nameProblem(given, siblings(draft)) : null;
      if (problem && by === "enter") {
        appToast.error(storageErrorText({ code: problem }, "That name can't be used"));
        return "stay";
      }
      // Esc, or an empty or unusable name, keeps the name it was given. A taken name left by a
      // click gets a number from the Worker rather than being lost.
      const name = by === "escape" || !given || problem === "invalid_name" ? draft.name : given;
      finished.current.add(key);
      typed.current.delete(key);
      dispatch({ type: "commit", key, name, focus: by !== "blur" });
      create({ name, place: draft.place, ...(draft.shareId ? { shareId: draft.shareId } : {}) })
        .then(({ node }) => dispatch({ type: "created", key, id: node.id }))
        .catch((error: unknown) => {
          appToast.error(storageErrorText(error, "The folder was not created"));
          dispatch({ type: "leave", key });
        });
      return "done";
    },
    [create, siblings],
  );

  // New folder pressed while the folder is still loading: it opens once the list is there.
  const [waiting, setWaiting] = useState<string | null>(null);
  const start = useCallback(() => {
    if (!ready) {
      setWaiting(placeKey);
      return;
    }
    // One name at a time: a draft still being named is created as it stands.
    for (const d of latest.current.drafts) {
      if (d.step === "naming") finish(d.key, typed.current.get(d.key) ?? "", "blur");
    }
    const key = `new-folder:${crypto.randomUUID()}`;
    const draft: FolderDraft = {
      key,
      place,
      placeKey,
      shareId,
      step: "naming",
      name: "",
      focus: false,
    };
    draft.name = freeFolderName(siblings(draft));
    dispatch({ type: "start", draft });
  }, [ready, place, placeKey, shareId, finish, siblings]);
  useEffect(() => {
    if (!waiting || !ready) return;
    setWaiting(null);
    if (waiting === placeKey) start();
  }, [waiting, ready, placeKey, start]);

  // Off to another folder mid-name (Back, a shortcut: nothing blurred the field), or off the page
  // altogether: that draft is created where it was started, with what was typed.
  const finishAll = useRef((_onlyElsewhere: boolean) => {});
  finishAll.current = (onlyElsewhere) => {
    for (const d of latest.current.drafts) {
      if (d.step !== "naming" || (onlyElsewhere && d.placeKey === latest.current.placeKey))
        continue;
      finish(d.key, typed.current.get(d.key) ?? "", "blur");
    }
  };
  useEffect(() => finishAll.current(true), [placeKey]);
  useEffect(() => () => finishAll.current(false), []);

  // A created folder leaves its draft once the list shows it, taking focus if named by keyboard.
  const ids = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const d of drafts) {
      if (d.step !== "created" || !d.id) continue;
      if (ids.has(d.id)) {
        dispatch({ type: "leave", key: d.key });
        if (d.focus) focusRow(d.id);
      } else {
        timers.push(setTimeout(() => dispatch({ type: "leave", key: d.key }), LAND_WITHIN_MS));
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [drafts, ids]);

  const shown = useMemo(
    () => drafts.filter((d) => d.placeKey === placeKey && !(d.id && ids.has(d.id))),
    [drafts, placeKey, ids],
  );
  const onType = useCallback((key: string, value: string) => typed.current.set(key, value), []);
  return { drafts: shown, start, finish, onType };
}

export type FolderDrafts = ReturnType<typeof useFolderDrafts>;

/**
 * Focuses a folder's row or card once it has rendered, unless focus has gone somewhere since
 * the name was finished (the next new folder's name, a link): it never takes focus from anything.
 */
function focusRow(id: string) {
  requestAnimationFrame(() => {
    const free = !document.activeElement || document.activeElement === document.body;
    const row = document.querySelector<HTMLElement>(`[role="row"][data-key="${CSS.escape(id)}"]`);
    if (free) row?.focus();
  });
}
