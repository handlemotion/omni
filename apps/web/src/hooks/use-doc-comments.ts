import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { LiveDoc } from "@/lib/live-doc.ts";
import { keys } from "@/lib/query-keys.ts";
import {
  COMMENT_MUTATION,
  storageCommentsQuery,
  threadsOf,
  type MarkedThread,
  type TextAnchor,
} from "@/lib/storage-comments.ts";

/** A doc's comments on its text: the panel beside it, the thread picked, and one being written. */
export interface DocComments {
  nodeId: string;
  shareId: string | undefined;
  /** The page is a doc being edited, where comments go on its text. */
  on: boolean;
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** The thread picked in the doc or the panel. */
  active: string | null;
  pick: (id: string | null) => void;
  /** The passage a new comment is being written on. */
  pending: TextAnchor | null;
  start: (anchor: TextAnchor) => void;
  cancel: () => void;
  /** Open threads on the doc's text, and the pending one, to mark in the doc. */
  marked: MarkedThread[];
  /** Open threads, on its text or on the whole doc. */
  count: number;
}

export const DocCommentsContext = createContext<DocComments | null>(null);

/** The doc's comments, for the page it opens in; nothing when `on` is false. */
export function useDocCommentsState(nodeId: string, shareId: string | undefined, on: boolean) {
  const comments = useQuery({ ...storageCommentsQuery(nodeId, shareId), enabled: on });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<TextAnchor | null>(null);
  useEffect(() => {
    setOpen(false);
    setActive(null);
    setPending(null);
  }, [nodeId]);
  const threads = useMemo(() => threadsOf(comments.data?.comments ?? [], false), [comments.data]);
  return useMemo(() => {
    const marked: MarkedThread[] = threads.flatMap(({ root }) =>
      root.anchor?.kind === "text" ? [{ id: root.id, anchor: root.anchor }] : [],
    );
    if (pending) marked.push({ id: "pending", anchor: pending });
    const state: DocComments = {
      nodeId,
      shareId,
      on,
      open: on && open,
      toggle: () => setOpen((was) => !was),
      close: () => {
        setOpen(false);
        setActive(null);
        setPending(null);
      },
      active,
      pick: (id) => {
        setActive(id);
        if (id) setOpen(true);
      },
      pending,
      start: (anchor) => {
        setPending(anchor);
        setActive(null);
        setOpen(true);
      },
      cancel: () => setPending(null),
      marked,
      count: threads.length,
    };
    return state;
  }, [nodeId, shareId, on, open, active, pending, threads]);
}

/** The doc's comments, inside a page that has them. */
export function useDocComments() {
  return useContext(DocCommentsContext);
}

/**
 * Keeps everyone in a live doc on the same comments: a change made here is announced through the
 * doc's presence, and one announced by a co-editor fetches the comments again.
 */
export function useLiveComments(doc: LiveDoc | null, nodeId: string) {
  const client = useQueryClient();
  useEffect(() => {
    if (!doc) return;
    const seen = new Map<number, unknown>();
    const heard = () => {
      let changed = false;
      for (const [clientId, state] of doc.awareness.getStates()) {
        if (clientId === doc.doc.clientID) continue;
        const said = (state as { comments?: unknown }).comments;
        if (said !== undefined && seen.has(clientId) && seen.get(clientId) !== said) changed = true;
        seen.set(clientId, said);
      }
      if (changed) void client.invalidateQueries({ queryKey: keys.storageComments(nodeId) });
    };
    heard();
    doc.awareness.on("change", heard);
    const stop = client.getMutationCache().subscribe((event) => {
      const { mutation } = event;
      if (!mutation || event.type !== "updated" || event.action.type !== "success") return;
      if (mutation.options.mutationKey?.[0] !== COMMENT_MUTATION[0]) return;
      if ((mutation.state.variables as { id?: string } | undefined)?.id !== nodeId) return;
      doc.awareness.setLocalStateField("comments", `${doc.doc.clientID}:${Date.now()}`);
    });
    return () => {
      doc.awareness.off("change", heard);
      stop();
    };
  }, [client, doc, nodeId]);
}
