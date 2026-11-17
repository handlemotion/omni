import { useEffect, useId, useRef } from "react";
import { appToast } from "@/components/ui/toast";

export function useSettingsPendingChanges({
  dirty,
  message = "You have unsaved changes",
  onDiscard,
  onSave,
  saveLabel = "Save",
  saving = false,
}: {
  dirty: boolean;
  /** Names what changed when a page has more than one form: "Workspace name changed". */
  message?: string;
  onDiscard: () => void;
  onSave: () => void;
  saveLabel?: string;
  saving?: boolean;
}) {
  const id = `settings-pending-${useId()}`;
  const handlers = useRef({ onDiscard, onSave, saving });
  useEffect(() => {
    handlers.current = { onDiscard, onSave, saving };
  });

  useEffect(() => {
    if (!dirty) {
      appToast.dismiss(id);
      return;
    }
    appToast.prompt(saving ? "Saving…" : message, {
      id,
      primary: {
        label: saving ? "Saving…" : saveLabel,
        onClick: () => {
          if (!handlers.current.saving) handlers.current.onSave();
        },
      },
      secondary: {
        label: "Discard",
        onClick: () => {
          if (!handlers.current.saving) handlers.current.onDiscard();
        },
      },
    });
  }, [dirty, id, message, saveLabel, saving]);

  useEffect(() => () => appToast.dismiss(id), [id]);
}
