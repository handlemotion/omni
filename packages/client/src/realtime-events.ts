import type {
  CrmChangedKind,
  HelpdeskRealtimeEvent,
  MailActionKind,
  SlaTarget,
  StorageChangedEvent,
  StorageDocEvent,
  StorageFilePresenceEvent,
  StorageTeamspacesChangedEvent,
  TalkEvent,
} from "@omni/contracts";
import type { schema } from "@omni/db";
import type { Realtime as RealtimeObject } from "@omni/worker";
import { isId, isIds, isObject, isSeqNum, isTime, keyOf } from "./realtime-guards.ts";
import { parseStorageEvent } from "./realtime-storage.ts";
import { parseTalkEvent } from "./realtime-talk.ts";

/**
 * Why a member was notified: assigned to them, @mentioned in a note, a note on a conversation they
 * take part in, a customer replied, an SLA, a teammate joined the workspace.
 */
export type NotificationKind = (typeof schema.notificationKind.enumValues)[number];

/**
 * This member has a new notification about the thread (`GET /api/notifications` lists it). Sent
 * only to members whose preferences allow realtime notifications of that kind.
 */
export type NotificationEvent =
  | { type: "notification"; threadId: string | null; kind: NotificationKind }
  | { type: "notification.removed"; threadId: string };

/**
 * What the Worker's realtime Durable Object broadcasts: the events typed from its `broadcast`,
 * plus the helpdesk events from `@omni/contracts` and notifications.
 */
export type RealtimeEvent =
  | Parameters<RealtimeObject["broadcast"]>[1]
  | HelpdeskRealtimeEvent
  | NotificationEvent
  | StorageFilePresenceEvent
  | StorageDocEvent
  | StorageChangedEvent
  | StorageTeamspacesChangedEvent
  | TalkEvent;

type Parser = (event: Record<string, unknown>) => RealtimeEvent | undefined;

const isNotificationKind = keyOf<NotificationKind>({
  assigned: true,
  mention: true,
  customer_reply: true,
  sla_at_risk: true,
  sla_breached: true,
  note: true,
  member_joined: true,
  comment: true,
});

const isActionKind = keyOf<MailActionKind>({
  send: true,
  forward_copy: true,
  archive: true,
  move: true,
  mark_read: true,
  mark_unread: true,
  trash: true,
  spam: true,
  not_spam: true,
});

const isCrmChangedKind = keyOf<CrmChangedKind>({
  company: true,
  person: true,
  deal: true,
  note: true,
  stages: true,
  settings: true,
  contract: true,
  task: true,
});

const isPresenceState = keyOf<Extract<HelpdeskRealtimeEvent, { type: "presence" }>["state"]>({
  viewing: true,
  replying: true,
  left: true,
});

const isSlaTarget = keyOf<SlaTarget>({
  first_response: true,
  next_response: true,
  resolution: true,
});

const isMeetingStatus = keyOf<(typeof schema.meetingsStatus.enumValues)[number]>({
  recording: true,
  uploaded: true,
  transcribing: true,
  naming: true,
  writing: true,
  ready: true,
  failed: true,
});

const MAIL_PARSERS: Record<string, Parser> = {
  changed: ({ mailboxId, threadIds }) =>
    typeof mailboxId === "string" &&
    Array.isArray(threadIds) &&
    threadIds.every((id) => typeof id === "string")
      ? { type: "changed", mailboxId, threadIds }
      : undefined,
  "mail.arrived": ({ mailboxId, threadIds }) =>
    isId(mailboxId) && isIds(threadIds)
      ? { type: "mail.arrived", mailboxId, threadIds }
      : undefined,
  action: ({ actionId, status, error }) =>
    typeof actionId === "string" && status === "failed" && typeof error === "string"
      ? { type: "action", actionId, status, error }
      : undefined,
  merged: ({ mailboxId, intoThreadId, fromThreadIds }) =>
    isId(mailboxId) && isId(intoThreadId) && isIds(fromThreadIds)
      ? { type: "merged", mailboxId, intoThreadId, fromThreadIds }
      : undefined,
  domain: ({ domainId }) =>
    typeof domainId === "string" ? { type: "domain", domainId } : undefined,
  notification: ({ threadId, kind }) =>
    (threadId === null || isId(threadId)) && isNotificationKind(kind)
      ? { type: "notification", threadId, kind }
      : undefined,
  "notification.removed": ({ threadId }) =>
    isId(threadId) ? { type: "notification.removed", threadId } : undefined,
  "crm.changed": ({ kind, ids }) =>
    isCrmChangedKind(kind) && isIds(ids) ? { type: "crm.changed", kind, ids } : undefined,
  "calendar.changed": ({ calendarIds }) =>
    isIds(calendarIds) && calendarIds.length > 0
      ? { type: "calendar.changed", calendarIds }
      : undefined,
  "meetings.changed": ({ meetingId, status }) =>
    isId(meetingId) && isMeetingStatus(status)
      ? { type: "meetings.changed", meetingId, status }
      : undefined,
};

type HelpdeskParser = (
  mailboxId: string,
  event: Record<string, unknown>,
) => HelpdeskRealtimeEvent | undefined;

const parseSla: HelpdeskParser = (mailboxId, { type, threadId, target, dueAt }) =>
  (type === "sla.at_risk" || type === "sla.breached") &&
  isId(threadId) &&
  isSlaTarget(target) &&
  isTime(dueAt)
    ? { type, mailboxId, threadId, target, dueAt }
    : undefined;

const HELPDESK_PARSERS: Record<HelpdeskRealtimeEvent["type"], HelpdeskParser> = {
  "thread.changed": (mailboxId, { threadIds }) =>
    isIds(threadIds) && threadIds.length > 0
      ? { type: "thread.changed", mailboxId, threadIds }
      : undefined,
  "note.created": (mailboxId, { threadId, noteId }) =>
    isId(threadId) && isId(noteId)
      ? { type: "note.created", mailboxId, threadId, noteId }
      : undefined,
  presence: (mailboxId, { threadId, memberId, state }) =>
    isId(threadId) && isId(memberId) && isPresenceState(state)
      ? { type: "presence", mailboxId, threadId, memberId, state }
      : undefined,
  "action.succeeded": (mailboxId, { actionId, kind }) =>
    isId(actionId) && isActionKind(kind)
      ? { type: "action.succeeded", mailboxId, actionId, kind }
      : undefined,
  "sla.at_risk": parseSla,
  "sla.breached": parseSla,
};

const isHelpdeskType = keyOf(HELPDESK_PARSERS);

const parseHelpdeskEvent: Parser = (event) => {
  const { type, mailboxId } = event;
  if (!isId(mailboxId) || !isHelpdeskType(type)) return undefined;
  return HELPDESK_PARSERS[type](mailboxId, event);
};

const parseEvent: Parser = (event) => {
  const { type } = event;
  if (typeof type === "string" && Object.hasOwn(MAIL_PARSERS, type)) {
    return MAIL_PARSERS[type]?.(event);
  }
  return parseTalkEvent(event) ?? parseHelpdeskEvent(event) ?? parseStorageEvent(event);
};

const parseJson = (data: string) => {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * One text message off the socket. `sync`: where the Worker's log is and whether this socket
 * resumed. Otherwise the log position it carries, if any, and the event, if it is one this
 * client knows.
 */
export type SocketMessage =
  | { kind: "sync"; epoch: string; seq: number; resumed: boolean }
  | { kind: "event"; seq: number | undefined; event: RealtimeEvent | undefined };

export const readSocketMessage: (data: string) => SocketMessage = (data) => {
  const value = parseJson(data);
  if (!isObject(value)) return { kind: "event", seq: undefined, event: undefined };
  const { type, epoch, seq, resumed } = value;
  if (type === "sync" && typeof epoch === "string" && isSeqNum(seq)) {
    return { kind: "sync", epoch, seq, resumed: resumed === true };
  }
  return { kind: "event", seq: isSeqNum(seq) ? seq : undefined, event: parseEvent(value) };
};
