import { buildCalendar, type OutgoingEvent, type OutgoingMethod } from "@omni/mail-core/calendar";
import { enqueueAction, replyHeadersOf, senderIdentity } from "../mail.ts";
import type { Db } from "../client.ts";
import type { CalendarResponse } from "./read.ts";
import type { Ex } from "./core.ts";

/** Who sends a calendar mail and for whom: the inbox, the member, the request. */
export interface Sender {
  orgId: string;
  mailboxId: string;
  address: string;
  memberId: string;
  requestId: string | null;
}

const ANSWER_WORDS: Record<CalendarResponse, string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentative",
  needs_action: "Not answered",
  delegated: "Delegated",
};

const VERBS: Record<CalendarResponse, string> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentatively accepted",
  needs_action: "has not answered",
  delegated: "delegated",
};

function when(event: OutgoingEvent, zone: string | null) {
  if (event.allDay && event.startDay) {
    const last = new Date(Date.parse(`${event.endDay ?? event.startDay}T00:00:00Z`) - 86_400_000);
    const first = event.startDay;
    const end = last.toISOString().slice(0, 10);
    return first === end ? first : `${first} – ${end}`;
  }
  const timeZone = zone ?? "UTC";
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${format.format(event.start)} – ${time.format(event.end)} (${timeZone})`;
}

function words(method: OutgoingMethod, event: OutgoingEvent, zone: string | null, name: string) {
  const lines = [event.title, when(event, zone)];
  if (event.location) lines.push(event.location);
  if (event.conferenceUrl) lines.push(event.conferenceUrl);
  if (method === "REQUEST" && event.description) lines.push("", event.description);
  if (method === "CANCEL") lines.unshift(`${name} cancelled this event.`, "");
  return lines.join("\n");
}

/**
 * Queues one iMIP send (`docs/spec/calendar.md`, "Sending") in the caller's transaction: the
 * change and its mail are written together, and a retried key queues nothing new.
 */
export async function queueCalendarMail(
  tx: Ex,
  sender: Sender,
  mail: {
    key: string;
    method: OutgoingMethod;
    event: OutgoingEvent;
    to: string[];
    zone: string | null;
    subject: string;
    replying?: string;
    answer?: CalendarResponse;
    replyTo?: { messageId: string } | null;
  },
) {
  if (mail.to.length === 0) return null;
  const identity = await senderIdentity(tx as Db, sender.memberId);
  const name = identity?.name ?? sender.address;
  const headers = mail.replyTo
    ? await replyHeadersOf(tx, { mailboxId: sender.mailboxId, messageId: mail.replyTo.messageId })
    : null;
  const ics = buildCalendar(mail.method, mail.event, { replying: mail.replying });
  const body = words(mail.method, mail.event, mail.zone, name);
  const text = mail.answer ? `${name} ${VERBS[mail.answer]} this invitation.\n\n${body}` : body;
  return enqueueAction(tx, {
    orgId: sender.orgId,
    mailboxId: sender.mailboxId,
    memberId: sender.memberId,
    requestId: sender.requestId,
    idempotencyKey: mail.key,
    kind: "send",
    payload: {
      from: sender.address,
      ...(identity?.name ? { fromName: identity.name } : {}),
      to: mail.to,
      subject: mail.subject,
      text,
      ...(headers
        ? {
            inReplyTo: headers.messageIdHeader,
            references: [...(headers.references ?? []), headers.messageIdHeader],
            inReplyToMessageId: mail.replyTo?.messageId,
          }
        : {}),
      calendar: { method: mail.method, ics },
    },
  });
}

export const answerSubject = (response: CalendarResponse, title: string) =>
  `${ANSWER_WORDS[response]}: ${title}`;
