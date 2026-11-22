import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useThreadInvites } from "@/hooks/use-calendar.ts";
import { AnswerButtons, answerable, whenOf } from "./event-panel.tsx";

const CALENDAR_TYPES = new Set(["text/calendar", "application/ics"]);

/** Whether a message carries an invitation (a `text/calendar` part or an `.ics` file). */
export const carriesInvite = (attachments: readonly { mimeType: string; filename: string }[]) =>
  attachments.some(
    (a) =>
      CALENDAR_TYPES.has(a.mimeType.toLowerCase()) || a.filename.toLowerCase().endsWith(".ics"),
  );

/** The invitation a message carries, above its text: what, when, and Yes, No, Maybe. */
export function InviteCard({ threadId, messageId }: { threadId: string; messageId: string }) {
  const invites = useThreadInvites(threadId).data ?? [];
  const invite = invites.find((i) => i.messageId === messageId);
  if (!invite) return null;
  const { event } = invite;
  return (
    <Card role="group" aria-label={`Invitation: ${event.title}`}>
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{event.title}</span>
          {event.status === "cancelled" && <Badge intent="danger">Cancelled</Badge>}
        </div>
        <span className="text-sm text-muted-foreground tabular-nums">{whenOf(event)}</span>
        {event.location && <span className="text-sm text-muted-foreground">{event.location}</span>}
        {answerable(event) && invite.method !== "CANCEL" && <AnswerButtons event={event} />}
      </CardContent>
    </Card>
  );
}
