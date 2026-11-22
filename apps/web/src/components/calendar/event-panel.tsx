import { IconLink, IconPencil, IconTrash, IconVideo, IconX } from "@/components/icons/central";
import { EventRecording } from "@/components/meetings/event-recording";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { appToast } from "@/components/ui/toast";
import { useAttendeesInCrm, useCalendarWrites } from "@/hooks/use-calendar.ts";
import { useHasCrm } from "@/hooks/use-crm.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import type { CalendarAnswer, CalendarEvent } from "@/lib/calendar.ts";
import { ownEvent } from "./week-grid.tsx";

const ANSWERS: { response: CalendarAnswer; label: string }[] = [
  { response: "accepted", label: "Yes" },
  { response: "declined", label: "No" },
  { response: "tentative", label: "Maybe" },
];

const RESPONSE_LABEL: Record<string, string> = {
  accepted: "Yes",
  declined: "No",
  tentative: "Maybe",
  needs_action: "Waiting",
  delegated: "Delegated",
};

const dayAndTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayOnly = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** When an event is, in the viewer's own time zone. */
export function whenOf(
  event: Pick<CalendarEvent, "start" | "end" | "allDay" | "startDay" | "endDay">,
) {
  if (event.allDay && event.startDay) {
    const [y = 0, m = 1, d = 1] = event.startDay.split("-").map(Number);
    return dayOnly.format(new Date(y, m - 1, d));
  }
  return `${dayAndTime.format(new Date(event.start))} – ${clock.format(new Date(event.end))}`;
}

export const answerable = (event: CalendarEvent) =>
  !event.organizing && event.myResponse !== null && event.status !== "cancelled";

/** Yes, No and Maybe for an invitation, the current answer filled. */
export function AnswerButtons({ event }: { event: CalendarEvent }) {
  const { answer } = useCalendarWrites();
  return (
    <div className="flex gap-1.5" role="group" aria-label="Answer">
      {ANSWERS.map(({ response, label }) => (
        <Button
          key={response}
          size="sm"
          intent={event.myResponse === response ? "primary" : "outline"}
          aria-pressed={event.myResponse === response}
          isPending={answer.isPending && answer.variables?.response === response}
          onPress={() =>
            answer.mutate(
              { id: event.id, response },
              { onError: () => appToast.error("The answer was not sent") },
            )
          }
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

/** The selected event beside the grid: when, who, the call, and what the member can do. */
export function EventPanel(props: {
  event: CalendarEvent;
  calendarAddress: string | undefined;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { event } = props;
  const { remove } = useCalendarWrites();
  return (
    <aside
      aria-label={event.title}
      className="flex h-svh w-80 shrink-0 flex-col border-l bg-background"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 ps-4 pe-2.5">
        <h2 className="min-w-0 flex-1 truncate text-md">{event.title || "(No title)"}</h2>
        <Button intent="outline" size="sq-sm" aria-label="Close" onPress={props.onClose}>
          <IconX />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-1 pb-4">
        <div className="flex flex-col gap-1 text-sm">
          <span className="tabular-nums">{whenOf(event)}</span>
          {props.calendarAddress && (
            <span className="text-muted-foreground">{props.calendarAddress}</span>
          )}
          {event.location && <span className="text-muted-foreground">{event.location}</span>}
        </div>
        {answerable(event) && <AnswerButtons event={event} />}
        {event.conferenceUrl && (
          <Button
            size="sm"
            intent="secondary"
            onPress={() => window.open(event.conferenceUrl ?? "", "_blank", "noopener")}
          >
            <IconVideo />
            Join
          </Button>
        )}
        <EventRecording event={event} />
        <People event={event} />
        {event.description && (
          <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
            {event.description}
          </p>
        )}
        {ownEvent(event) && (
          <div className="mt-auto flex gap-1.5">
            <Button size="sm" intent="outline" onPress={props.onEdit}>
              <IconPencil />
              Edit
            </Button>
            <Button
              size="sm"
              intent="danger"
              isPending={remove.isPending}
              onPress={() =>
                remove.mutate(event.id, {
                  onSuccess: props.onClose,
                  onError: () => appToast.error("The event was not deleted"),
                })
              }
            >
              <IconTrash />
              Delete and tell guests
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}

function People({ event }: { event: CalendarEvent }) {
  const hasCrm = useHasCrm();
  const addresses = event.attendees.map((a) => a.address);
  const found = useAttendeesInCrm(addresses, hasCrm).data;
  const { href } = useWorkspacePaths();
  const personOf = (address: string) =>
    found?.people.find((p) => p.addresses.some((a) => a.address.toLowerCase() === address));
  if (event.attendees.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5 text-sm">
        {event.attendees.map((attendee) => {
          const person = personOf(attendee.address);
          return (
            <li key={attendee.address} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">
                {person ? (
                  <Link href={href(`/crm/people/${person.id}`)}>{person.name}</Link>
                ) : (
                  (attendee.name ?? attendee.address)
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {RESPONSE_LABEL[attendee.response]}
              </span>
            </li>
          );
        })}
      </ul>
      {found && (found.companies.length > 0 || found.deals.length > 0) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {found.companies.map((company) => (
            <Link key={company.id} href={href(`/crm/companies/${company.id}`)}>
              <IconLink className="size-icon" />
              {company.name}
            </Link>
          ))}
          {found.deals.map((deal) => (
            <Link key={deal.id} href={href(`/crm/deals/${deal.id}`)}>
              {deal.name}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
