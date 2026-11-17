// Rename as Finder does it: the name turns into a field where it is drawn (the item's card or
// row, or the open file's title in the preview), its name selected to type over. Enter or
// leaving the field renames it, Esc leaves it as it was. Until the Worker answers the new name
// shows in its place; a refusal puts the old one back and says why. Steps naming → saving → gone.
import { useCallback, useMemo, useRef, useState } from "react";
import { storageErrorText } from "@/components/storage/storage-errors.ts";
import { appToast } from "@/components/ui/toast";
import type { StorageNode } from "@/lib/storage.ts";
import { nameProblem, type FinishedBy } from "@/lib/storage-names.ts";
import { useChangeNode } from "./use-storage.ts";

/** Where the name is being changed: in the folder's cards and rows, or the preview's title. */
export type RenameAt = "list" | "preview";

export interface Renaming {
  id: string;
  at: RenameAt;
  step: "naming" | "saving";
  /** The name being saved. */
  name: string;
}

export interface InlineRename {
  renaming: Renaming | null;
  /** "stay" when Enter met a name that cannot be used. */
  finish: (node: StorageNode, value: string, by: FinishedBy) => "stay" | "done";
}

export function useInlineRename(source: { shareId: string | undefined; nodes: StorageNode[] }) {
  const { shareId, nodes } = source;
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const change = useChangeNode().mutateAsync;
  // Read by the field's callbacks between renders.
  const latest = useRef({ renaming, nodes });
  latest.current = { renaming, nodes };

  const start = useCallback((node: StorageNode, at: RenameAt) => {
    setRenaming({ id: node.id, at, step: "naming", name: node.name });
  }, []);

  const finish = useCallback(
    (node: StorageNode, value: string, by: FinishedBy) => {
      const current = latest.current.renaming;
      if (current?.id !== node.id || current.step !== "naming")
        return "done" satisfies "stay" | "done";
      const given = value.trim();
      const refocus = by !== "blur";
      if (by === "escape" || !given || given === node.name) {
        setRenaming(null);
        if (refocus && current.at === "list") focusRow(node.id);
        return "done" satisfies "stay" | "done";
      }
      const siblings = latest.current.nodes.filter((n) => n.id !== node.id).map((n) => n.name);
      const problem = nameProblem(given, siblings);
      if (problem) {
        appToast.error(storageErrorText({ code: problem }, "It was not renamed"));
        // Enter keeps the field to try another name; leaving it keeps the name it had.
        if (by === "enter") return "stay" satisfies "stay" | "done";
        setRenaming(null);
        return "done" satisfies "stay" | "done";
      }
      setRenaming({ ...current, step: "saving", name: given });
      if (refocus && current.at === "list") focusRow(node.id);
      const saved = () =>
        setRenaming((now) => (now?.id === node.id && now.step === "saving" ? null : now));
      change({ id: node.id, name: given, ...(shareId ? { shareId } : {}) })
        .catch((error: unknown) => {
          appToast.error(storageErrorText(error, "It was not renamed"));
        })
        .finally(saved);
      return "done" satisfies "stay" | "done";
    },
    [change, shareId],
  );

  const rename = useMemo<InlineRename>(() => ({ renaming, finish }), [renaming, finish]);
  return { rename, start };
}

/**
 * Hands focus back to the renamed card or row once the field has gone, unless focus has gone
 * somewhere since: it never takes focus from anything.
 */
function focusRow(id: string) {
  requestAnimationFrame(() => {
    const free = !document.activeElement || document.activeElement === document.body;
    const row = document.querySelector<HTMLElement>(`[role="row"][data-key="${CSS.escape(id)}"]`);
    if (free) row?.focus();
  });
}
