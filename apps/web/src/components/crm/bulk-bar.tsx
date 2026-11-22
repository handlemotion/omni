import { useState } from "react";
import {
  IconBoard,
  IconEllipsis,
  IconTrash,
  IconUserMinus,
  IconUserRound,
  IconX,
} from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSubMenu,
  MenuTrigger,
} from "@/components/ui/menu";
import { appToast } from "@/components/ui/toast";
import { useBulkCrm, useCanDeleteForever, useCrmStages, useOwners } from "@/hooks/use-crm.ts";
import { ApiError } from "@/lib/api.ts";
import type { CrmRecordKind } from "@/lib/crm.ts";
import type { BulkAction } from "@/lib/crm-mutations.ts";
import { crmErrorText } from "./crm-errors.ts";
import { countOf, DeleteForeverDialog } from "./record-actions.tsx";

export const PAST: Record<BulkAction["action"], string> = {
  archive: "archived",
  restore: "restored",
  delete: "deleted",
  owner: "changed",
  stage: "moved",
};

export function reportRefusals(
  kind: CrmRecordKind,
  action: BulkAction,
  total: number,
  refused: { code: string }[],
) {
  const [first] = refused;
  if (!first) return;
  const summary = `${countOf(kind, refused.length)} of ${total} weren't ${PAST[action.action]}`;
  const reason = crmErrorText(new ApiError(409, first.code, { code: first.code }), "");
  appToast.error(reason ? `${summary}. ${reason}` : summary);
}

/**
 * The header while rows are picked, in place of search and New (Drive's selection bar): how many,
 * Archive or Restore, and the rest in a menu.
 */
export function BulkBar(props: {
  kind: CrmRecordKind;
  ids: string[];
  /** The archived view: Restore in place of Archive. */
  archived: boolean;
  onClear: () => void;
}) {
  const bulk = useBulkCrm();
  const canDelete = useCanDeleteForever();
  const [confirming, setConfirming] = useState(false);
  const run = (action: BulkAction) =>
    bulk
      .mutateAsync({ kind: props.kind, ids: props.ids, action })
      .then(({ refused }) => {
        reportRefusals(props.kind, action, props.ids.length, refused);
        props.onClear();
      })
      .catch((error: unknown) =>
        appToast.error(crmErrorText(error, `They weren't ${PAST[action.action]}`)),
      );
  return (
    <>
      <span className="px-1 text-sm text-muted-foreground tabular-nums">
        {props.ids.length} selected
      </span>
      <Button
        intent="outline"
        size="sm"
        isPending={bulk.isPending && !confirming}
        onPress={() => void run({ action: props.archived ? "restore" : "archive" })}
      >
        {props.archived ? "Restore" : "Archive"}
      </Button>
      <MenuTrigger>
        <Button intent="outline" size="sq-sm" aria-label="More bulk actions">
          <IconEllipsis />
        </Button>
        <Menu placement="bottom end" aria-label="Bulk actions">
          <MenuSubMenu>
            <MenuItem id="owner" textValue="Set owner">
              <IconUserRound data-slot="icon" />
              <MenuLabel>Set owner</MenuLabel>
            </MenuItem>
            <OwnerMenu onPick={(ownerMemberId) => void run({ action: "owner", ownerMemberId })} />
          </MenuSubMenu>
          {props.kind === "deals" && (
            <MenuSubMenu>
              <MenuItem id="stage" textValue="Move to stage">
                <IconBoard data-slot="icon" />
                <MenuLabel>Move to stage</MenuLabel>
              </MenuItem>
              <StageMenu onPick={(stageId) => void run({ action: "stage", stageId })} />
            </MenuSubMenu>
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
      <Button intent="plain" size="sq-sm" aria-label="Clear selection" onPress={props.onClear}>
        <IconX />
      </Button>
      {confirming && (
        <DeleteForeverDialog
          title={`Delete ${countOf(props.kind, props.ids.length)}?`}
          action={`Delete ${countOf(props.kind, props.ids.length)} forever`}
          saving={bulk.isPending}
          onConfirm={() => void run({ action: "delete" }).then(() => setConfirming(false))}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

function OwnerMenu(props: { onPick: (ownerMemberId: string | null) => void }) {
  const owners = useOwners();
  return (
    <Menu aria-label="Owner">
      <MenuItem id="none" textValue="No owner" onAction={() => props.onPick(null)}>
        <IconUserMinus data-slot="icon" />
        <MenuLabel>No owner</MenuLabel>
      </MenuItem>
      {owners.map((owner) => (
        <MenuItem
          key={owner.id}
          id={owner.id}
          textValue={owner.name}
          onAction={() => props.onPick(owner.id)}
        >
          <Avatar src={owner.image} initials={owner.name.slice(0, 1)} />
          <MenuLabel>{owner.name}</MenuLabel>
        </MenuItem>
      ))}
    </Menu>
  );
}

function StageMenu(props: { onPick: (stageId: string) => void }) {
  const stages = useCrmStages().data ?? [];
  return (
    <Menu aria-label="Stage">
      {stages.map((stage) => (
        <MenuItem
          key={stage.id}
          id={stage.id}
          textValue={stage.name}
          onAction={() => props.onPick(stage.id)}
        >
          <IconBoard data-slot="icon" />
          <MenuLabel>{stage.name}</MenuLabel>
        </MenuItem>
      ))}
    </Menu>
  );
}
