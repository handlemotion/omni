import { useSyncExternalStore } from "react";
import { dismissUndo, runUndo, undoStore, type UndoOffer } from "../lib/undo.ts";
import { announce, useShortcut } from "./use-shortcuts.ts";

function undo() {
  if (runUndo()) announce("Undone");
}

/**
 * The standing undo offer for the toast: `{ offer, undo, dismiss }`. `offer` is null when there
 * is nothing to undo. While one stands, `z` runs it too.
 */
export const useUndo: () => {
  offer: UndoOffer | null;
  undo: () => void;
  dismiss: () => void;
} = () => {
  const offer = useSyncExternalStore(undoStore.subscribe, undoStore.get, undoStore.get);
  useShortcut("undo", undo, !!offer);
  return { offer, undo, dismiss: dismissUndo };
};

export { offerUndo } from "../lib/undo.ts";
