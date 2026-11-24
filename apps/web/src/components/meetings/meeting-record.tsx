import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crmErrorToast } from "@/components/crm/crm-errors.ts";
import { RecordPicker } from "@/components/crm/task-dialog.tsx";
import { useState } from "react";
import { DetailRow } from "./meeting-aside.tsx";
import {
  IconBuildings,
  IconHandshake,
  IconLink,
  IconUserRound,
  IconX,
} from "@/components/icons/central";
import { Button, buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { useAttendeesInCrm } from "@/hooks/use-calendar.ts";
import { useCrmCompany, useCrmDeal, useCrmPerson, useHasCrm } from "@/hooks/use-crm.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { placeMeetingMutation, type CrmRecordsKind } from "@/lib/crm-meetings.ts";
import type { Meeting } from "@/lib/meetings.ts";

const RECORDS: Record<string, CrmRecordsKind> = {
  company: "companies",
  person: "people",
  deal: "deals",
};

const ICONS = { companies: IconBuildings, people: IconUserRound, deals: IconHandshake };

/**
 * The CRM records a meeting is on, as the task panel shows a task's: the one someone put it on,
 * else the companies and projects its attendees are from. Its editors put it on one or take it off.
 */
export function MeetingRecord(props: { meeting: Meeting; canEdit: boolean }) {
  const hasCrm = useHasCrm();
  if (!hasCrm) return null;
  return (
    <DetailRow label="Linked to">
      <Records {...props} />
    </DetailRow>
  );
}

function Records(props: { meeting: Meeting; canEdit: boolean }) {
  const { meeting } = props.meeting;
  const place = useMutation(placeMeetingMutation(useQueryClient()));
  const [picking, setPicking] = useState(false);
  const placed = meeting.record;
  const records = placed ? RECORDS[placed.kind] : undefined;
  const onRecord = (action: "put" | "remove", to: { records: CrmRecordsKind; id: string }) =>
    place.mutate(
      { ...to, meetingId: meeting.id, action },
      { onError: (error) => crmErrorToast(error, "The meeting's record was not changed") },
    );
  if (placed && records) {
    return (
      <>
        <PlacedLink records={records} id={placed.id} />
        {props.canEdit && (
          <Button
            size="sq-2xs"
            intent="plain"
            aria-label="Remove from record"
            isPending={place.isPending}
            className="opacity-0 group-hover/property:opacity-100 focus-visible:opacity-100"
            onPress={() => onRecord("remove", { records, id: placed.id })}
          >
            <IconX />
          </Button>
        )}
      </>
    );
  }
  if (picking) {
    return (
      <div className="w-full">
        <RecordPicker
          label={false}
          autoFocus
          value={null}
          onBlur={() => setPicking(false)}
          onChange={(picked) => {
            if (!picked) return;
            setPicking(false);
            onRecord("put", { records: picked.kind, id: picked.id });
          }}
        />
      </div>
    );
  }
  return (
    <>
      {!meeting.recordOff && <Matched addresses={props.meeting.attendees.map((a) => a.address)} />}
      {props.canEdit && (
        <Button
          intent="property-plain"
          size="property"
          data-empty=""
          onPress={() => setPicking(true)}
          className="-me-1.5"
        >
          <IconLink />
          <span className="truncate">Add to record</span>
        </Button>
      )}
    </>
  );
}

const CHIP = buttonStyles({ intent: "property", size: "property" });

function PlacedLink(props: { records: CrmRecordsKind; id: string }) {
  const { href } = useWorkspacePaths();
  const company = useCrmCompany(props.id, { enabled: props.records === "companies" }).data;
  const person = useCrmPerson(props.id, { enabled: props.records === "people" }).data;
  const deal = useCrmDeal(props.id, { enabled: props.records === "deals" }).data;
  const name = company?.company.name ?? person?.person.name ?? deal?.deal.name;
  const Icon = ICONS[props.records];
  if (!name) return <span className="text-muted-foreground">–</span>;
  return (
    <Link href={href(`/crm/${props.records}/${props.id}`)} className={CHIP}>
      <Icon />
      <span className="truncate">{name}</span>
    </Link>
  );
}

function Matched({ addresses }: { addresses: string[] }) {
  const { href } = useWorkspacePaths();
  const found = useAttendeesInCrm(addresses, true).data;
  const links = [
    ...(found?.deals ?? []).map((d) => ({
      key: `d:${d.id}`,
      icon: ICONS.deals,
      to: `/crm/deals/${d.id}`,
      name: d.name,
    })),
    ...(found?.companies ?? []).map((c) => ({
      key: `c:${c.id}`,
      icon: ICONS.companies,
      to: `/crm/companies/${c.id}`,
      name: c.name,
    })),
  ];
  if (!links.length) return null;
  return (
    <>
      {links.map(({ key, to, name, icon: Icon }) => (
        <Link key={key} href={href(to)} className={CHIP}>
          <Icon />
          <span className="truncate">{name}</span>
        </Link>
      ))}
    </>
  );
}
