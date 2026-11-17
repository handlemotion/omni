// "Ana is editing" (ADR 0043 decision 3): who else has a Drive file open in their editor, and
// telling them you do.
import { useEffect, useSyncExternalStore } from "react";
import { FILE_REPEAT_MS, filePresenceStore, type FileEditor } from "../lib/file-presence.ts";
import { onRealtimeOpen, sendRealtime } from "../lib/realtime.ts";

/** Members editing the file, oldest first. Includes you when another of your tabs edits it. */
export function useFileEditors(nodeId: string) {
  return useSyncExternalStore(
    filePresenceStore.subscribe,
    () => filePresenceStore.get(nodeId),
    () => filePresenceStore.get(nodeId),
  ) satisfies readonly FileEditor[];
}

/**
 * Says `editing` on the file's workspace socket while mounted with a file: again every 30 s so it
 * outlives a missed event, again after a reconnect, and `left` when it closes.
 */
export function useReportEditing(file: { id: string; orgId: string } | undefined) {
  const nodeId = file?.id;
  const orgId = file?.orgId;
  useEffect(() => {
    if (!nodeId || !orgId) return;
    const say = () => sendRealtime(orgId, { type: "file.presence", nodeId, state: "editing" });
    say();
    const repeat = setInterval(say, FILE_REPEAT_MS);
    const stopListening = onRealtimeOpen((opened) => opened === orgId && say());
    return () => {
      clearInterval(repeat);
      stopListening();
      sendRealtime(orgId, { type: "file.presence", nodeId, state: "left" });
    };
  }, [nodeId, orgId]);
}
