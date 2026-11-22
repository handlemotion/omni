import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crmErrorToast } from "@/components/crm/crm-errors.ts";
import { RecordPicker } from "@/components/crm/task-dialog.tsx";
import { IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
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

const LINK = "truncate text-foreground underline-offset-2 hover:underline";

/**
 * The CRM records a meeting is on, linked: the one someone put it on, else the companies and
 * projects its attendees are from. Its editors put it on a record or take it off.
 */
export function MeetingRecord(props: { meeting: Meeting; canEdit: boolean }) {
  const hasCrm = useHasCrm();
  if (!hasCrm) return null;
  return (
    <>
      <dt className="text-muted-foreground">Record</dt>
      <dd className="flex min-h-8 min-w-0 items-center gap-3">
        <Records {...props} />
      </dd>
    </>
  );
}

function Records(props: { meeting: Meeting; canEdit: boolean }) {
  const { meeting } = props.meeting;
  const place = useMutation(placeMeetingMutation(useQueryClient()));
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
            size="sq-xs"
            intent="plain"
            aria-label="Remove from record"
            isPending={place.isPending}
            onPress={() => onRecord("remove", { records, id: placed.id })}
          >
            <IconX />
          </Button>
        )}
      </>
    );
  }
  return (
    <>
      {!meeting.recordOff && <Matched addresses={props.meeting.attendees.map((a) => a.address)} />}
      {props.canEdit && (
        <div className="ms-auto w-56 shrink-0">
          <RecordPicker
            label={false}
            value={null}
            onChange={(picked) =>
              picked && onRecord("put", { records: picked.kind, id: picked.id })
            }
          />
        </div>
      )}
    </>
  );
}

function PlacedLink(props: { records: CrmRecordsKind; id: string }) {
  const { href } = useWorkspacePaths();
  const company = useCrmCompany(props.id, { enabled: props.records === "companies" }).data;
  const person = useCrmPerson(props.id, { enabled: props.records === "people" }).data;
  const deal = useCrmDeal(props.id, { enabled: props.records === "deals" }).data;
  const name = company?.company.name ?? person?.person.name ?? deal?.deal.name;
  if (!name) return <span className="text-muted-foreground">–</span>;
  return (
    <Link href={href(`/crm/${props.records}/${props.id}`)} className={LINK}>
      {name}
    </Link>
  );
}

function Matched({ addresses }: { addresses: string[] }) {
  const { href } = useWorkspacePaths();
  const found = useAttendeesInCrm(addresses, true).data;
  const links = [
    ...(found?.deals ?? []).map((d) => ({
      key: `d:${d.id}`,
      to: `/crm/deals/${d.id}`,
      name: d.name,
    })),
    ...(found?.companies ?? []).map((c) => ({
      key: `c:${c.id}`,
      to: `/crm/companies/${c.id}`,
      name: c.name,
    })),
  ];
  if (!links.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
      {links.map((link) => (
        <Link key={link.key} href={href(link.to)} className={LINK}>
          {link.name}
        </Link>
      ))}
    </span>
  );
}
