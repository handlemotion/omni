// Dialogs stacked over the settings dialog (transitive's member and revoke dialogs): a form that
// edits one thing, and a confirmation for what can't be undone. Rows never grow inline forms;
// they open one of these.
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
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

/** A list over settings (who can see a mailbox, a domain's records): title, rows, an action. */
export function SettingsListDialog({
  children,
  description,
  footer,
  isOpen,
  onOpenChange,
  title,
}: {
  children: ReactNode;
  description?: string;
  /** The one action on the whole list, at the bottom right: "Check records". */
  footer?: ReactNode;
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
      {footer && <DialogFooter>{footer}</DialogFooter>}
    </Dialog>
  );
}

/**
 * Renames one thing (you, a passkey, the workspace): a single field holding the current name,
 * Save once it changed. Mount it while open so the field starts from the current name.
 */
export function SettingsRenameDialog({
  description,
  label,
  maxLength = 120,
  name,
  onClose,
  onSave,
  saving,
  title,
}: {
  description?: string;
  label: string;
  maxLength?: number;
  name: string;
  onClose: () => void;
  onSave: (name: string) => void;
  saving?: boolean;
  title: string;
}) {
  const [value, setValue] = useState(name);
  const next = value.trim();
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={description}
      action="Save"
      disabled={!next || next === name}
      saving={saving}
      onSubmit={() => onSave(next)}
    >
      <TextField isRequired autoFocus maxLength={maxLength} value={value} onChange={setValue}>
        <Label>{label}</Label>
        <Input autoComplete="off" />
      </TextField>
    </SettingsFormDialog>
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
