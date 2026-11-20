import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { IconArchive, IconEllipsis, IconRestore, IconTrash } from "@/components/icons/central";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useCanDeleteForever, useRecordLifecycle } from "@/hooks/use-crm.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import type { CrmRecordKind } from "@/lib/crm.ts";
import type { RecordLifecycle } from "@/lib/crm-mutations.ts";
import { crmErrorToast } from "./crm-errors.ts";

/** "company" and "companies", for buttons and toasts. */
export const NOUNS: Record<CrmRecordKind, { one: string; many: string }> = {
  companies: { one: "company", many: "companies" },
  people: { one: "person", many: "people" },
  deals: { one: "deal", many: "deals" },
};

export const countOf = (kind: CrmRecordKind, n: number) =>
  `${n} ${n === 1 ? NOUNS[kind].one : NOUNS[kind].many}`;

/** Asks before something is deleted for good; the button says what happens. */
export function DeleteForeverDialog(props: {
  title: string;
  action: string;
  saving: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      role="alertdialog"
      size="sm"
      isOpen
      onOpenChange={(open) => !open && !props.saving && props.onClose()}
    >
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogFooter>
        <DialogClose intent="outline" isDisabled={props.saving}>
          Cancel
        </DialogClose>
        <Button intent="danger" isPending={props.saving} onPress={props.onConfirm}>
          {props.action}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

const FAILED: Record<RecordLifecycle, string> = {
  archive: "It was not archived",
  restore: "It was not restored",
  delete: "It was not deleted",
};

/** The page's own actions: Restore while archived, then the menu. */
export function RecordActions(props: {
  kind: CrmRecordKind;
  id: string;
  name: string;
  archived: boolean;
}) {
  const lifecycle = useRecordLifecycle();
  const canDelete = useCanDeleteForever();
  const navigate = useNavigate();
  const { href: inWorkspace } = useWorkspacePaths();
  const [confirming, setConfirming] = useState(false);
  const run = (action: RecordLifecycle, then?: () => void) =>
    lifecycle.mutate(
      { kind: props.kind, id: props.id, action },
      { onSuccess: then, onError: (error) => crmErrorToast(error, FAILED[action]) },
    );
  return (
    <>
      {props.archived && (
        <Button
          intent="outline"
          size="sm"
          isPending={lifecycle.isPending && lifecycle.variables?.action === "restore"}
          onPress={() => run("restore")}
        >
          Restore
        </Button>
      )}
      <MenuTrigger>
        <Button intent="plain" size="sq-sm" aria-label="More actions">
          <IconEllipsis />
        </Button>
        <Menu placement="bottom end" aria-label="Actions">
          {props.archived ? (
            <MenuItem id="restore" textValue="Restore" onAction={() => run("restore")}>
              <IconRestore data-slot="icon" />
              <MenuLabel>Restore</MenuLabel>
            </MenuItem>
          ) : (
            <MenuItem id="archive" textValue="Archive" onAction={() => run("archive")}>
              <IconArchive data-slot="icon" />
              <MenuLabel>Archive</MenuLabel>
            </MenuItem>
          )}
          {canDelete && <MenuSeparator />}
          {canDelete && (
            <MenuItem
              id="delete"
              intent="danger"
              textValue="Delete forever"
              onAction={() => setConfirming(true)}
            >
              <IconTrash data-slot="icon" />
              <MenuLabel>Delete forever</MenuLabel>
            </MenuItem>
          )}
        </Menu>
      </MenuTrigger>
      {confirming && (
        <DeleteForeverDialog
          title={`Delete ${props.name}?`}
          action={`Delete ${NOUNS[props.kind].one} forever`}
          saving={lifecycle.isPending}
          onConfirm={() =>
            run("delete", () => {
              setConfirming(false);
              void navigate({ href: inWorkspace(`/crm/${props.kind}`) });
            })
          }
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** Beside an archived record's name. */
export function ArchivedBadge() {
  return (
    <Badge intent="secondary" className="shrink-0">
      Archived
    </Badge>
  );
}
