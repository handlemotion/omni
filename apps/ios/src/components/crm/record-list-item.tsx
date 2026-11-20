import { Link } from "expo-router";
import type { ReactElement } from "react";
import { IconArchive, IconArrowRotateClockwise } from "@/components/icons.ts";
import { SwipeRow } from "@/components/ui/swipe-row.tsx";
import { confirmDeleteForever, useIsAdmin, useRecordMove, useSetOwner } from "@/lib/crm-actions.ts";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import { useMoveDeal, type CrmRecordKind } from "@/lib/crm-mutations.ts";
import { useMemberNames, useStages, type CrmStage } from "@/lib/crm-timeline.ts";

const PATH = {
  companies: "/crm/company/[id]",
  people: "/crm/person/[id]",
  deals: "/crm/deal/[id]",
} as const;

/** The record a list row shows, as far as its menu needs it. */
export interface ListRecord {
  id: string;
  name: string;
  archivedAt: string | null;
  ownerMemberId?: string | null;
  stageId?: string;
}

/**
 * A record's row in a CRM list: a swipe left archives it (restores it in Archived), and a long
 * press opens its menu: a deal's stage, the owner, Archive; in Archived, Restore and, for owners
 * and admins, Delete forever. The native menu reads its items straight from its children, so
 * they are all built here.
 */
export function RecordListItem(props: {
  kind: CrmRecordKind;
  record: ListRecord;
  children: ReactElement;
}) {
  const { kind, record } = props;
  const actions = useRowActions(kind, record);
  const archived = !!record.archivedAt;
  return (
    <SwipeRow
      itemKey={record.id}
      left={
        archived
          ? {
              label: "Restore",
              icon: IconArrowRotateClockwise,
              tone: "primary",
              run: actions.restore,
            }
          : { label: "Archive", icon: IconArchive, tone: "warning", run: actions.archive }
      }
    >
      <Link href={{ pathname: PATH[kind], params: { id: record.id } }} asChild>
        <Link.Trigger>{props.children}</Link.Trigger>
        {archived ? (
          <Link.Menu>
            <Link.MenuAction icon="arrow.uturn.backward" onPress={actions.restore}>
              Restore
            </Link.MenuAction>
            {actions.admin ? (
              <Link.MenuAction icon="trash" destructive onPress={actions.deleteForever}>
                Delete forever
              </Link.MenuAction>
            ) : null}
          </Link.Menu>
        ) : (
          <Link.Menu>
            {kind === "deals" && actions.stages.length ? (
              <Link.Menu title="Move to stage" icon="flag">
                {actions.stages.map((stage) => (
                  <Link.MenuAction
                    key={stage.id}
                    isOn={stage.id === record.stageId}
                    onPress={() => actions.moveTo(stage)}
                  >
                    {stage.name}
                  </Link.MenuAction>
                ))}
              </Link.Menu>
            ) : null}
            <Link.Menu title="Owner" icon="person.crop.circle">
              <Link.MenuAction
                icon="person.slash"
                isOn={actions.owner === null}
                onPress={() => actions.setOwner(null)}
              >
                No owner
              </Link.MenuAction>
              {actions.members.map(([id, name]) => (
                <Link.MenuAction
                  key={id}
                  icon="person"
                  isOn={actions.owner === id}
                  onPress={() => actions.setOwner(id)}
                >
                  {name}
                </Link.MenuAction>
              ))}
            </Link.Menu>
            <Link.Menu inline>
              <Link.MenuAction icon="archivebox" onPress={actions.archive}>
                Archive
              </Link.MenuAction>
            </Link.Menu>
          </Link.Menu>
        )}
      </Link>
    </SwipeRow>
  );
}

function useRowActions(kind: CrmRecordKind, record: ListRecord) {
  const archive = useRecordMove(kind, "archive").mutate;
  const restore = useRecordMove(kind, "restore").mutate;
  const remove = useRecordMove(kind, "deleteForever").mutate;
  const owner = useSetOwner(kind).mutate;
  const move = useMoveDeal().mutate;
  const current = record.ownerMemberId ?? null;
  return {
    admin: useIsAdmin(),
    stages: useStages().data ?? [],
    members: [...(useMemberNames().data ?? [])],
    owner: current,
    archive: () => archive(record.id),
    restore: () => restore(record.id),
    deleteForever: () => confirmDeleteForever(record.name, () => remove(record.id)),
    setOwner: (ownerMemberId: string | null) =>
      ownerMemberId !== current && owner({ id: record.id, ownerMemberId }),
    moveTo: (stage: CrmStage) =>
      stage.id !== record.stageId &&
      move(
        { dealId: record.id, stage },
        { onError: (error) => crmErrorAlert(error, "The deal was not moved") },
      ),
  };
}
