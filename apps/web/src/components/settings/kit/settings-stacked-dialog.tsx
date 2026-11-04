// Dialogs stacked over the settings dialog (transitive's member and revoke dialogs): a form that
// edits one thing, and a confirmation for what can't be undone. Rows never grow inline forms;
// they open one of these.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** A small form over settings: title, one line on what it does, fields, Cancel and the action. */
export function SettingsFormDialog({
  action,
  children,
  description,
  disabled,
  isOpen,
  onOpenChange,
  onSubmit,
  saving,
  title,
}: {
  /** The submit button's label, saying what happens: "Invite", "Save". */
  action: string;
  children: ReactNode;
  description?: string;
  disabled?: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  saving?: boolean;
  title: string;
}) {
  return (
    <Dialog
      size="sm"
      isOpen={isOpen}
      onOpenChange={(open) => !saving && onOpenChange(open)}
      closeButton={!saving}
    >
      <form
        className="flex min-h-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogBody className="gap-4">{children}</DialogBody>
        <DialogFooter>
          <DialogClose intent="outline" isDisabled={saving}>
            Cancel
          </DialogClose>
          <Button type="submit" isDisabled={disabled} isPending={saving}>
            {action}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** A plain list over settings (who can see a mailbox): title, rows, Done. */
export function SettingsListDialog({
  children,
  description,
  isOpen,
  onOpenChange,
  title,
}: {
  children: ReactNode;
  description?: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
}) {
  return (
    <Dialog size="md" isOpen={isOpen} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <DialogBody>{children}</DialogBody>
    </Dialog>
  );
}

/** Asks before something that can't be undone; the button says what happens. */
export function SettingsConfirmDialog({
  action,
  description,
  isOpen,
  onConfirm,
  onOpenChange,
  saving,
  title,
}: {
  action: string;
  description: string;
  isOpen: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  saving?: boolean;
  title: string;
}) {
  return (
    <Dialog
      role="alertdialog"
      size="sm"
      isOpen={isOpen}
      onOpenChange={(open) => !saving && onOpenChange(open)}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose intent="outline" isDisabled={saving}>
          Cancel
        </DialogClose>
        <Button intent="danger" isPending={saving} onPress={onConfirm}>
          {action}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
