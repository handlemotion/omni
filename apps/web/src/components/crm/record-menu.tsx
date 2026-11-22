import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  IconArchive,
  IconArrowUpRight,
  IconBoard,
  IconRestore,
  IconTrash,
  IconUserMinus,
  IconUserRound,
} from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import type { ContextMenuAction, ContextMenuEntry } from "@/components/ui/context-menu";
import { appToast } from "@/components/ui/toast";
import {
  useBulkCrm,
  useCanDeleteForever,
  useCrmStages,
  useMoveDeal,
  useOwners,
} from "@/hooks/use-crm.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import type { CrmRecordKind } from "@/lib/crm.ts";
import type { BulkAction } from "@/lib/crm-mutations.ts";
import { PAST, reportRefusals } from "./bulk-bar.tsx";
import { crmErrorText, crmErrorToast } from "./crm-errors.ts";
import { countOf, DeleteForeverDialog, NOUNS } from "./record-actions.tsx";

/** What a menu needs of a listed record; a deal adds its stage. */
export interface MenuRecord {
  id: string;
  name: string;
  archivedAt?: string | null | undefined;
  stageId?: string | null | undefined;
}

/** The picked rows of a list, when the right-clicked one is among them. */
export interface MenuSelection {
  keys: ReadonlySet<string>;
  clear: () => void;
}

type Icon = ContextMenuAction["icon"];

const avatarIcon = (name: string, image: string | null | undefined) =>
  function OwnerAvatar() {
    return <Avatar src={image} initials={name.slice(0, 1)} />;
  } satisfies Icon;

/**
 * A listed record's right-click rows, the record page's own (Archive or Restore, Delete forever)
 * and the bulk bar's (owner, stage): for the record alone, or for the picked rows when it is one
 * of them. `dialogs` holds the delete confirmation and must be rendered.
 */
export function useRecordMenu(kind: CrmRecordKind) {
  const navigate = useNavigate();
  const { href: inWorkspace } = useWorkspacePaths();
  const bulk = useBulkCrm();
  const move = useMoveDeal();
  const canDelete = useCanDeleteForever();
  const owners = useOwners();
  const stages = useCrmStages().data ?? [];
  const [deleting, setDeleting] = useState<{ ids: string[]; title: string } | null>(null);
  const [onDeleted, setOnDeleted] = useState<() => void>(() => () => {});

  const run = (ids: string[], action: BulkAction, then?: () => void) =>
    bulk
      .mutateAsync({ kind, ids, action })
      .then(({ refused }) => {
        reportRefusals(kind, action, ids.length, refused);
        return then?.();
      })
      .catch((error: unknown) =>
        appToast.error(crmErrorText(error, `It wasn't ${PAST[action.action]}`)),
      );

  const shared = (ids: string[], archived: boolean, done?: () => void) => {
    const many = ids.length > 1;
    const what = many ? ` ${countOf(kind, ids.length)}` : "";
    return [
      {
        icon: IconUserRound,
        label: "Set owner",
        items: [
          {
            icon: IconUserMinus,
            label: "No owner",
            onAction: () => void run(ids, { action: "owner", ownerMemberId: null }, done),
          },
          ...owners.map((owner) => ({
            icon: avatarIcon(owner.name, owner.image),
            label: owner.name,
            onAction: () => void run(ids, { action: "owner", ownerMemberId: owner.id }, done),
          })),
        ],
      },
      "separator",
      archived
        ? {
            icon: IconRestore,
            label: `Restore${what}`,
            onAction: () => void run(ids, { action: "restore" }, done),
          }
        : {
            icon: IconArchive,
            label: `Archive${what}`,
            onAction: () => void run(ids, { action: "archive" }, done),
          },
      canDelete && "separator",
      canDelete && {
        icon: IconTrash,
        label: `Delete${what} forever`,
        danger: true,
        onAction: () => {
          setOnDeleted(() => done ?? (() => {}));
          setDeleting({
            ids,
            title: many
              ? `Delete ${countOf(kind, ids.length)}?`
              : `Delete this ${NOUNS[kind].one}?`,
          });
        },
      },
    ] satisfies ContextMenuEntry[];
  };

  const stageMenu = (ids: string[], current?: string | null) =>
    (kind === "deals" &&
      stages.length > 0 && {
        icon: IconBoard,
        label: "Move to stage",
        items: stages.map((stage) => ({
          icon: IconBoard,
          label: stage.name,
          disabled: stage.id === current,
          onAction: () =>
            ids.length === 1 && ids[0]
              ? move.mutate(
                  { dealId: ids[0], stage },
                  { onError: (error) => crmErrorToast(error, "The deal was not moved") },
                )
              : void run(ids, { action: "stage", stageId: stage.id }),
        })),
      }) satisfies ContextMenuEntry;

  const entries = (record: MenuRecord, selection?: MenuSelection) => {
    if (selection && selection.keys.size > 1 && selection.keys.has(record.id)) {
      const ids = [...selection.keys];
      return [
        stageMenu(ids),
        ...shared(ids, !!record.archivedAt, selection.clear),
      ] satisfies ContextMenuEntry[];
    }
    const href = inWorkspace(`/crm/${kind}/${encodeURIComponent(record.id)}`);
    return [
      { icon: IconArrowUpRight, label: "Open", onAction: () => void navigate({ href }) },
      "separator",
      !record.archivedAt && stageMenu([record.id], record.stageId),
      ...shared([record.id], !!record.archivedAt),
    ] satisfies ContextMenuEntry[];
  };

  const dialogs = deleting && (
    <DeleteForeverDialog
      title={deleting.title}
      action={`Delete ${countOf(kind, deleting.ids.length)} forever`}
      saving={bulk.isPending}
      onConfirm={() =>
        void run(deleting.ids, { action: "delete" }, () => {
          onDeleted();
          setDeleting(null);
        })
      }
      onClose={() => setDeleting(null)}
    />
  );

  return { entries, dialogs };
}
