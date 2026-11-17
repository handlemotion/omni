import { appToast } from "@/components/ui/toast";
import type { Queued } from "@/hooks/use-compose.ts";

/**
 * "Sending · Undo" for as long as the send waits in the outbox (the member's undo window). Undo
 * runs `cancel`; when that comes too late the mail has left, and the toast says so.
 */
export function offerUndoSend(queued: Queued, cancel: () => Promise<boolean>, label = "Sending") {
  const left = new Date(queued.undoUntil).getTime() - Date.now();
  if (left < 500) return;
  appToast.message(label, {
    id: `undo-send-${queued.actionId}`,
    duration: left,
    action: {
      label: "Undo",
      onClick: () => {
        cancel().then(
          (stopped) => {
            if (!stopped) appToast.message("Already sent");
          },
          () => appToast.error("Could not stop the send. Check your connection."),
        );
      },
    },
  });
}
