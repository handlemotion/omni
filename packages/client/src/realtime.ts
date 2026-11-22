import type {
  CrmChangedEvent,
  CrmChangedKind,
  HelpdeskRealtimeEvent,
  MailActionKind,
  StorageChangedEvent,
  StorageDocEvent,
  StorageFilePresenceEvent,
  StorageLiveRecord,
} from "@omni/contracts";
import type { schema } from "@omni/db";
import type { Realtime as RealtimeObject } from "@omni/worker";

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
  | StorageChangedEvent;
export type RealtimeStatus = "connecting" | "open" | "closed";

/**
 * What an app sends on the socket. `presence`: this member is viewing or replying in a
 * conversation, or `left` it; the Durable Object adds the member and mailbox and tells the
 * inbox's other members. `file.presence`: this socket has a Drive file open in its
 * editor, or closed it; those who see the file hear it. `doc.append`: one
 * record for the live document of the file this socket edits (`storageDocEventSchema`).
 */
export type RealtimeClientMessage =
  | { type: "presence"; threadId: string; state: "viewing" | "replying" | "left" }
  | { type: "file.presence"; nodeId: string; state: "editing" | "left" }
  | {
      type: "doc.append";
      nodeId: string;
      ref: number;
      record: StorageLiveRecord;
      matchSeqNum?: number;
    }
  | { type: "doc.presence"; nodeId: string; u: string };

export interface RealtimeOptions {
  /** The Worker's origin; the socket is `/api/realtime` on it. */
  baseUrl: string;
  /**
   * One of the user's organizations: the socket carries that org's events for their member
   * there. Without it, the session's active organization.
   */
  orgId?: string;
  /**
   * A watch socket: only `mail.arrived` and the member's notifications, for desktop
   * notifications. It does not count as an open app, so the member's phone still gets its push.
   */
  watch?: boolean;
  /**
   * A doc opened through a share link by someone outside the workspace
   * (`docs/spec/live-sharing.md`): the socket is `/api/storage/shared/:shareId/realtime?node=`
   * instead, and carries that doc's events alone. It stops for good when the Worker closes it
   * because the link no longer opens the doc to them (`4403`); closed for sending too much
   * (`4429`), it reconnects with backoff like any dropped socket.
   */
  shared?: { shareId: string; nodeId: string; onEnded?: (code: number) => void };
  onEvent: (event: RealtimeEvent) => void;
  /**
   * Socket state. An `"open"` with `reconnected: true` follows a socket that dropped or never
   * opened, so events may have been missed while none was listening: refetch what is on screen.
   */
  onStatus?: (status: RealtimeStatus, info: { reconnected: boolean }) => void;
  /**
   * Opens the socket. Browsers send the session cookie themselves. On iOS, pass it:
   * `(url) => new WebSocket(url, null, { headers: { cookie } })`.
   */
  openSocket?: (url: string) => WebSocket;
  /** Backoff bounds between reconnects; each wait is jittered. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** How often to ping. A ping unanswered by the next one counts as a dead socket. */
  pingIntervalMs?: number;
  /** How long `wake()` waits for its ping's answer before it counts the socket as dead. */
  probeTimeoutMs?: number;
}

export interface Realtime {
  /** Stops reconnecting and closes the socket. Call on sign-out. */
  close(): void;
  /**
   * The network may be back, or the app is in front again after a while (browser `online`,
   * `visibilitychange`, React Native `AppState` "active"). A socket waiting out its backoff
   * reconnects now; an open one is pinged and dropped if it does not answer in time.
   */
  wake(): void;
  /** Sends on the open socket. False when none is open: nothing is queued. */
  send(message: RealtimeClientMessage): boolean;
}

/**
 * Keeps one realtime socket open, reconnecting with jittered exponential backoff, and hands
 * each event it knows to `onEvent`. Messages it does not know are ignored, so the Worker can
 * add event types without breaking older apps.
 */
export function connectRealtime(options: RealtimeOptions) {
  const {
    minDelayMs = 500,
    maxDelayMs = 30_000,
    pingIntervalMs = 25_000,
    probeTimeoutMs = 5_000,
    openSocket = (url) => new WebSocket(url),
  } = options;
  const { shared } = options;
  const path = shared
    ? `/api/storage/shared/${encodeURIComponent(shared.shareId)}/realtime`
    : "/api/realtime";
  const url = new URL(path, options.baseUrl);
  if (shared) url.searchParams.set("node", shared.nodeId);
  if (options.orgId && !shared) url.searchParams.set("org", options.orgId);
  if (options.watch) url.searchParams.set("watch", "1");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  let socket: WebSocket | undefined;
  let attempt = 0;
  let dropped = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let probe: (() => void) | undefined;

  const connect = () => {
    options.onStatus?.("connecting", { reconnected: dropped });
    const current = openSocket(url.toString());
    socket = current;
    let awaitingPong = false;

    const drop = () => {
      if (socket !== current) return;
      socket = undefined;
      probe = undefined;
      clearInterval(pingTimer);
      clearTimeout(probeTimer);
      try {
        current.close();
      } catch {}
      dropped = true;
      options.onStatus?.("closed", { reconnected: dropped });
      if (stopped) return;
      const ceiling = Math.min(maxDelayMs, minDelayMs * 2 ** attempt++);
      retryTimer = setTimeout(connect, ceiling / 2 + (Math.random() * ceiling) / 2);
    };

    current.addEventListener("open", () => {
      if (socket !== current) return;
      attempt = 0;
      pingTimer = setInterval(() => {
        if (awaitingPong) return drop();
        awaitingPong = true;
        current.send("ping");
      }, pingIntervalMs);
      probe = () => {
        if (awaitingPong) return;
        awaitingPong = true;
        current.send("ping");
        clearTimeout(probeTimer);
        probeTimer = setTimeout(() => awaitingPong && drop(), probeTimeoutMs);
      };
      options.onStatus?.("open", { reconnected: dropped });
    });
    current.addEventListener("message", (message) => {
      if (socket !== current || typeof message.data !== "string") return;
      if (message.data === "pong") {
        awaitingPong = false;
        clearTimeout(probeTimer);
        return;
      }
      const event = parseEvent(message.data);
      if (event) options.onEvent(event);
    });
    current.addEventListener("close", (event) => {
      if (shared && event.code === 4403) {
        stopped = true;
        shared.onEnded?.(event.code);
      }
      drop();
    });
    current.addEventListener("error", drop);
  };

  connect();
  return {
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      const current = socket;
      socket = undefined;
      probe = undefined;
      clearInterval(pingTimer);
      clearTimeout(probeTimer);
      current?.close(1000);
      if (current) options.onStatus?.("closed", { reconnected: dropped });
    },
    send(message) {
      if (!probe || !socket) return false;
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },
    wake() {
      if (stopped) return;
      if (socket) return probe?.();
      clearTimeout(retryTimer);
      attempt = 0;
      connect();
    },
  } satisfies Realtime;
}

/** `STORAGE_DOC_PRESENCE_MAX` in `@omni/contracts`, without pulling its schemas in. */
export const DOC_PRESENCE_MAX = 4096;

/** `STORAGE_LIVE_SNAP_EVERY` in `@omni/contracts`, without pulling its schemas in. */
export const LIVE_SNAP_EVERY = 200;

const parseEvent: (data: string) => RealtimeEvent | undefined = (data) => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Partial<RealtimeEvent>;
  if (
    event.type === "changed" &&
    typeof event.mailboxId === "string" &&
    Array.isArray(event.threadIds) &&
    event.threadIds.every((id) => typeof id === "string")
  ) {
    return { type: "changed", mailboxId: event.mailboxId, threadIds: event.threadIds };
  }
  if (
    event.type === "mail.arrived" &&
    isId(event.mailboxId) &&
    Array.isArray(event.threadIds) &&
    event.threadIds.every(isId)
  ) {
    return { type: "mail.arrived", mailboxId: event.mailboxId, threadIds: event.threadIds };
  }
  if (
    event.type === "action" &&
    typeof event.actionId === "string" &&
    event.status === "failed" &&
    typeof event.error === "string"
  ) {
    return { type: "action", actionId: event.actionId, status: "failed", error: event.error };
  }
  if (
    event.type === "merged" &&
    isId(event.mailboxId) &&
    isId(event.intoThreadId) &&
    Array.isArray(event.fromThreadIds) &&
    event.fromThreadIds.every(isId)
  ) {
    const { mailboxId, intoThreadId, fromThreadIds } = event;
    return { type: "merged", mailboxId, intoThreadId, fromThreadIds };
  }
  if (event.type === "domain" && typeof event.domainId === "string") {
    return { type: "domain", domainId: event.domainId };
  }
  if (event.type === "notification") {
    const { threadId, kind } = event;
    if (threadId !== null && !isId(threadId)) return undefined;
    if (typeof kind !== "string" || !Object.hasOwn(NOTIFICATION_KINDS, kind)) return undefined;
    return { type: "notification", threadId, kind: kind as NotificationKind };
  }
  if (event.type === "notification.removed") {
    return isId(event.threadId)
      ? { type: "notification.removed", threadId: event.threadId }
      : undefined;
  }
  const record = value as Record<string, unknown>;
  return parseCrmEvent(record) ?? parseHelpdeskEvent(record) ?? parseStorageEvent(record);
};

const PRESENCE_STATES = new Set(["viewing", "replying", "left"]);
const SLA_TARGETS = new Set(["first_response", "next_response", "resolution"]);
const ACTION_KINDS: Record<MailActionKind, true> = {
  send: true,
  forward_copy: true,
  archive: true,
  move: true,
  mark_read: true,
  mark_unread: true,
  trash: true,
  spam: true,
  not_spam: true,
};

const NOTIFICATION_KINDS: Record<NotificationKind, true> = {
  assigned: true,
  mention: true,
  customer_reply: true,
  sla_at_risk: true,
  sla_breached: true,
  note: true,
  member_joined: true,
  comment: true,
};

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const CRM_CHANGED_KINDS: Record<CrmChangedKind, true> = {
  company: true,
  person: true,
  deal: true,
  note: true,
  stages: true,
  settings: true,
  contract: true,
  task: true,
};

const parseCrmEvent: (event: Record<string, unknown>) => CrmChangedEvent | undefined = (event) => {
  if (event.type !== "crm.changed") return undefined;
  const { kind, ids } = event;
  if (typeof kind !== "string" || !Object.hasOwn(CRM_CHANGED_KINDS, kind)) return undefined;
  if (!Array.isArray(ids) || !ids.every(isId)) return undefined;
  return { type: "crm.changed", kind: kind as CrmChangedKind, ids };
};

const isSeqNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const DOC_REFUSALS = new Set([
  "tail",
  "editing",
  "denied",
  "locked",
  "unavailable",
  "read_only",
  "rate",
]);

const parseLiveRecord: (value: unknown) => StorageLiveRecord | undefined = (value) => {
  if (typeof value !== "object" || value === null) return undefined;
  const { t, cv, e, u } = value as Record<string, unknown>;
  if (t === "seed" && isSeqNum(cv) && typeof u === "string") return { t, cv, u };
  if (t === "update" && isSeqNum(e) && typeof u === "string") return { t, e, u };
  const { s } = value as Record<string, unknown>;
  if (t === "fold" && isSeqNum(e) && isSeqNum(cv) && isSeqNum(s)) return { t, e, cv, s };
  return undefined;
};

const parseStorageEvent: (
  event: Record<string, unknown>,
) => StorageFilePresenceEvent | StorageDocEvent | StorageChangedEvent | undefined = (event) => {
  const { nodeId, ref, seqNum } = event;
  if (event.type === "storage.changed") {
    const { space, parentIds } = event;
    if (space !== "personal" && space !== "shared") return undefined;
    if (!Array.isArray(parentIds)) return { type: "storage.changed", space };
    const named = parentIds.filter((p): p is string | null => p === null || isId(p));
    return { type: "storage.changed", space, parentIds: named };
  }
  if (!isId(nodeId)) return undefined;
  switch (event.type) {
    case "file.presence": {
      const { memberId, state } = event;
      if (!isId(memberId) || (state !== "editing" && state !== "left")) return;
      return { type: "file.presence", nodeId, memberId, state };
    }
    case "doc.appended":
      if (!Number.isInteger(ref) || !isSeqNum(seqNum)) return;
      return { type: "doc.appended", nodeId, ref: ref as number, seqNum };
    case "doc.refused": {
      const { reason } = event;
      if (!Number.isInteger(ref) || !DOC_REFUSALS.has(reason as string)) return;
      return {
        type: "doc.refused",
        nodeId,
        ref: ref as number,
        reason: reason as Extract<StorageDocEvent, { type: "doc.refused" }>["reason"],
      };
    }
    case "doc.record": {
      const record = parseLiveRecord(event.record);
      if (!isSeqNum(seqNum) || !record) return;
      return { type: "doc.record", nodeId, seqNum, record };
    }
    case "doc.presence": {
      const { u } = event;
      if (typeof u !== "string" || u.length > DOC_PRESENCE_MAX) return;
      return { type: "doc.presence", nodeId, u };
    }
    case "doc.access": {
      const { role } = event;
      if (role !== null && role !== "editor" && role !== "commenter") return;
      return { type: "doc.access", nodeId, role };
    }
    case "doc.comments":
      return { type: "doc.comments", nodeId };
  }
  return undefined;
};

const parseHelpdeskEvent: (event: Record<string, unknown>) => HelpdeskRealtimeEvent | undefined = (
  event,
) => {
  const { mailboxId, threadId } = event;
  if (!isId(mailboxId)) return undefined;
  switch (event.type) {
    case "thread.changed": {
      const { threadIds } = event;
      if (!Array.isArray(threadIds) || !threadIds.length || !threadIds.every(isId)) return;
      return { type: "thread.changed", mailboxId, threadIds };
    }
    case "note.created":
      if (!isId(threadId) || !isId(event.noteId)) return;
      return { type: "note.created", mailboxId, threadId, noteId: event.noteId };
    case "presence": {
      const { memberId, state } = event;
      if (!isId(threadId) || !isId(memberId) || !PRESENCE_STATES.has(state as string)) return;
      return {
        type: "presence",
        mailboxId,
        threadId,
        memberId,
        state: state as "viewing" | "replying" | "left",
      };
    }
    case "action.succeeded": {
      const { actionId, kind } = event;
      if (!isId(actionId) || typeof kind !== "string" || !Object.hasOwn(ACTION_KINDS, kind)) return;
      return { type: "action.succeeded", mailboxId, actionId, kind: kind as MailActionKind };
    }
    case "sla.at_risk":
    case "sla.breached": {
      const { target, dueAt } = event;
      if (!isId(threadId) || !SLA_TARGETS.has(target as string)) return;
      if (typeof dueAt !== "string" || Number.isNaN(Date.parse(dueAt))) return;
      return {
        type: event.type,
        mailboxId,
        threadId,
        target: target as "first_response" | "next_response" | "resolution",
        dueAt,
      };
    }
  }
  return undefined;
};
