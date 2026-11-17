import { DurableObject } from "cloudflare:workers";
import type {
  CrmChangedEvent,
  HelpdeskRealtimeEvent,
  SlaTarget,
  StorageChangedEvent,
  StorageSpace,
} from "@omni/contracts";
import {
  forMember,
  mailboxAudience,
  membersAccepting,
  pushTokensFor,
  type Db,
  type NotificationKind,
} from "@omni/db";
import { z } from "zod";
import { openDb } from "./db.ts";
import type { Config } from "./env.ts";
import { createLogger } from "./log.ts";
import { docAppendMessage, MAX_DOC_MESSAGE, onDocAppend } from "./realtime-docs.ts";
import {
  filePresenceMessage,
  leaveFile,
  onFilePresence,
  setConversation,
} from "./realtime-files.ts";

/** Header the Worker sets (never the client) to tell the DO whose socket this is. */
export const MEMBER_HEADER = "x-omni-member-id";
/**
 * Set (by the Worker) on a desktop sync provider's socket: it hears `storage.changed` and nothing
 * else, since its token reaches Storage alone. Such a socket is tagged `sync:<memberId>`.
 */
export const SYNC_HEADER = "x-omni-sync";
const syncTag = (memberId: string) => `sync:${memberId}`;
/**
 * Set (by the Worker) on a watch socket: the desktop notifications of one workspace, kept open
 * for every workspace the user is in. It hears `WATCHED` events alone and never counts as the
 * member being online there, so their phone still gets its push. Tagged `watch:<memberId>`.
 */
export const WATCH_HEADER = "x-omni-watch";
const watchTag = (memberId: string) => `watch:${memberId}`;

export type RealtimeEvent =
  | { type: "changed"; mailboxId: string; threadIds: string[] }
  | { type: "merged"; mailboxId: string; intoThreadId: string; fromThreadIds: string[] }
  | { type: "action"; actionId: string; status: "failed"; error: string }
  | { type: "domain"; domainId: string }
  | { type: "notification"; threadId: string | null; kind: NotificationKind }
  | { type: "notification.removed"; threadId: string }
  | { type: "mail.arrived"; mailboxId: string; threadIds: string[] };

const WATCHED = new Set(["notification", "notification.removed", "mail.arrived"]);

type OutboundEvent = RealtimeEvent | HelpdeskRealtimeEvent | CrmChangedEvent | StorageChangedEvent;

const presenceMessage = z.object({
  type: z.literal("presence"),
  threadId: z.string().min(1).max(64),
  state: z.enum(["viewing", "replying", "left"]),
});
const clientMessage = z.union([presenceMessage, filePresenceMessage, docAppendMessage]);
const MAX_CLIENT_MESSAGE = 1024;

type Presence = { threadId: string; mailboxId: string; state: "viewing" | "replying" };

/**
 * One instance per org. Each open app holds a hibernatable websocket tagged with its member id;
 * the DO can sleep between events and still route by tag. Clients refetch what changed.
 */
export class Realtime extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request) {
    const memberId = request.headers.get(MEMBER_HEADER);
    if (!memberId || request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const tag = request.headers.has(SYNC_HEADER)
      ? syncTag(memberId)
      : request.headers.has(WATCH_HEADER)
        ? watchTag(memberId)
        : memberId;
    this.ctx.acceptWebSocket(server, [tag]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends the event to these members' sockets; returns the members with none open. */
  async broadcast(memberIds: string[], event: OutboundEvent) {
    return this.send(memberIds, [event]) satisfies Promise<string[]>;
  }

  /**
   * Sends the events, in order, to these members' app sockets (all but `mail.arrived`) and watch
   * sockets (`WATCHED` ones); returns the members with no app socket open.
   */
  async send(memberIds: string[], events: OutboundEvent[]) {
    const forApps = events.filter((e) => e.type !== "mail.arrived").map((e) => JSON.stringify(e));
    const forWatch = events.filter((e) => WATCHED.has(e.type)).map((e) => JSON.stringify(e));
    const offline: string[] = [];
    for (const memberId of new Set(memberIds)) {
      const sockets = this.ctx.getWebSockets(memberId);
      if (sockets.length === 0) offline.push(memberId);
      sendAll(sockets, forApps);
      if (forWatch.length) sendAll(this.ctx.getWebSockets(watchTag(memberId)), forWatch);
    }
    return offline satisfies string[];
  }

  /**
   * Tells whoever sees the drive that it changed: its owner for a My files drive, everyone in the
   * workspace for Shared. App sockets and sync sockets alike.
   */
  async storageChanged(space: StorageSpace, ownerMemberId: string | null) {
    const sockets =
      ownerMemberId === null
        ? this.ctx.getWebSockets()
        : [
            ...this.ctx.getWebSockets(ownerMemberId),
            ...this.ctx.getWebSockets(syncTag(ownerMemberId)),
          ];
    const message = JSON.stringify({ type: "storage.changed", space } satisfies OutboundEvent);
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {}
    }
  }

  /**
   * Presence (`{"type":"presence","threadId","state"}`): a socket is in at most one conversation.
   * The DO checks the member can see it, tells everyone else who can, and answers a new viewer
   * with who is already there. Anything else is ignored; "ping" is answered by the auto-response.
   */
  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    const doc = raw.startsWith('{"type":"doc.append"');
    if (raw.length > (doc ? MAX_DOC_MESSAGE : MAX_CLIENT_MESSAGE)) return;
    let message;
    try {
      message = clientMessage.parse(JSON.parse(raw));
    } catch {
      return;
    }
    const memberId = this.ctx.getTags(socket)[0];
    if (!memberId || memberId.startsWith("sync:") || memberId.startsWith("watch:")) return;
    if (message.type === "file.presence") {
      await onFilePresence(this.ctx, this.env, socket, memberId, message);
      return;
    }
    if (message.type === "doc.append") {
      await onDocAppend(this.ctx, this.env, socket, memberId, message);
      return;
    }
    const current = presenceOf(socket);
    if (message.state === "left") {
      if (current?.threadId === message.threadId) await this.leave(socket, memberId, current);
      return;
    }
    if (current && current.threadId !== message.threadId) {
      await this.leave(socket, memberId, current);
    }
    const { db, close } = openDb(this.env, 1);
    let audience;
    try {
      audience = await forMember(db, memberId).threadAudience(message.threadId);
    } finally {
      await close({ timeout: 0 });
    }
    if (!audience) return;
    const presence: Presence = {
      threadId: message.threadId,
      mailboxId: audience.mailboxId,
      state: message.state,
    };
    setConversation(socket, presence);
    const others = audience.memberIds.filter((m) => m !== memberId);
    await this.send(others, [presenceEvent(memberId, this.memberState(memberId, presence))]);
    if (current?.threadId !== presence.threadId) {
      const here = new Map<string, Presence>();
      for (const other of this.ctx.getWebSockets()) {
        const theirs = presenceOf(other);
        const them = this.ctx.getTags(other)[0];
        if (!theirs || !them || them === memberId || theirs.threadId !== presence.threadId) {
          continue;
        }
        if (here.get(them)?.state !== "replying") here.set(them, theirs);
      }
      for (const [them, theirs] of here) {
        socket.send(JSON.stringify(presenceEvent(them, theirs)));
      }
    }
  }

  override async webSocketClose(socket: WebSocket, code: number) {
    const presence = presenceOf(socket);
    const memberId = this.ctx.getTags(socket)[0];
    if (memberId) leaveFile(this.ctx, socket, memberId);
    if (presence && memberId) await this.leave(socket, memberId, presence);
    socket.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, "closing");
  }

  override async webSocketError(socket: WebSocket) {
    const presence = presenceOf(socket);
    const memberId = this.ctx.getTags(socket)[0];
    if (memberId) leaveFile(this.ctx, socket, memberId);
    if (presence && memberId) await this.leave(socket, memberId, presence);
  }

  private memberState(memberId: string, presence: Presence) {
    if (presence.state === "replying") return presence satisfies Presence;
    for (const other of this.ctx.getWebSockets(memberId)) {
      const theirs = presenceOf(other);
      if (theirs?.threadId === presence.threadId && theirs.state === "replying")
        return theirs satisfies Presence;
    }
    return presence satisfies Presence;
  }

  private async leave(socket: WebSocket, memberId: string, presence: Presence) {
    setConversation(socket, null);
    let still: Presence | null = null;
    for (const other of this.ctx.getWebSockets(memberId)) {
      const theirs = other === socket ? null : presenceOf(other);
      if (theirs?.threadId === presence.threadId && still?.state !== "replying") still = theirs;
    }
    if (still?.state === presence.state) return;
    const { db, close } = openDb(this.env, 1);
    let audience;
    try {
      audience = await mailboxAudience(db, [presence.mailboxId]);
    } finally {
      await close({ timeout: 0 });
    }
    await this.send(
      audience.map((row) => row.memberId).filter((m) => m !== memberId),
      [
        still
          ? presenceEvent(memberId, still)
          : {
              type: "presence",
              mailboxId: presence.mailboxId,
              threadId: presence.threadId,
              memberId,
              state: "left",
            },
      ],
    );
  }
}

function sendAll(sockets: WebSocket[], messages: string[]) {
  for (const socket of sockets) {
    for (const message of messages) {
      try {
        socket.send(message);
      } catch {}
    }
  }
}

const presenceOf: (socket: WebSocket) => Presence | null = (socket) => {
  try {
    const presence = (socket.deserializeAttachment() as Partial<Presence> | null) ?? null;
    return presence?.threadId ? (presence as Presence) : null;
  } catch {
    return null;
  }
};

const presenceEvent: (memberId: string, presence: Presence) => HelpdeskRealtimeEvent = (
  memberId,
  presence,
) => {
  return {
    type: "presence",
    mailboxId: presence.mailboxId,
    threadId: presence.threadId,
    memberId,
    state: presence.state,
  };
};

/**
 * Tells every member who can see the mailboxes that these threads changed: `changed` for the
 * mail views and `thread.changed` for helpdesk views. Members with no app open on a mailbox in
 * `push` get an Expo notification instead (when enabled). Watch sockets hear `arrived`, the new
 * mail among the changes (`newArrivals`), as `mail.arrived`.
 */
export async function fanOut(
  env: Env,
  db: Db,
  config: Config,
  changes: Map<string, Set<string>>,
  options: { push?: Set<string>; arrived?: Map<string, Set<string>> } = {},
) {
  const audience = await mailboxAudience(db, [...changes.keys()]);
  const offlineByMailbox = new Map<string, { address: string; memberIds: string[] }>();
  for (const [mailboxId, threadSet] of changes) {
    const rows = audience.filter((row) => row.mailboxId === mailboxId);
    const first = rows[0];
    if (!first) continue;
    const threadIds = [...threadSet];
    const stub = env.REALTIME.get(env.REALTIME.idFromName(first.orgId));
    const arrived = options.arrived?.get(mailboxId);
    const offline = await stub.send(
      rows.map((row) => row.memberId),
      [
        { type: "changed", mailboxId, threadIds },
        { type: "thread.changed", mailboxId, threadIds },
        ...(arrived?.size
          ? [{ type: "mail.arrived" as const, mailboxId, threadIds: [...arrived] }]
          : []),
      ],
    );
    if (options.push?.has(mailboxId)) {
      offlineByMailbox.set(mailboxId, { address: first.address, memberIds: offline });
    }
  }
  if (config.EXPO_PUSH_ENABLED) {
    for (const { address, memberIds } of offlineByMailbox.values()) {
      await sendExpoPush(db, config, memberIds, { title: address, body: "New message" });
    }
  }
}

/** Tells everyone who can see the mailbox that threads were merged, so readers can follow. */
export async function announceMerges(
  env: Env,
  db: Db,
  merges: { mailboxId: string; intoThreadId: string; fromThreadIds: string[] }[],
) {
  const audience = await mailboxAudience(db, [...new Set(merges.map((m) => m.mailboxId))]);
  for (const { mailboxId, intoThreadId, fromThreadIds } of merges) {
    const rows = audience.filter((row) => row.mailboxId === mailboxId);
    const first = rows[0];
    if (!first) continue;
    const stub = env.REALTIME.get(env.REALTIME.idFromName(first.orgId));
    await stub.broadcast(
      rows.map((row) => row.memberId),
      { type: "merged", mailboxId, intoThreadId, fromThreadIds },
    );
  }
}

/** Tells these members, whose preferences allow it, that they have a new notification. */
export async function notifyMembers(
  env: Env,
  db: Db,
  input: { orgId: string; threadId: string | null; memberIds: string[]; kind: NotificationKind },
) {
  if (input.memberIds.length === 0) return;
  const accepting = await membersAccepting(db, input.memberIds, input.kind, "realtime");
  if (accepting.length === 0) return;
  const stub = env.REALTIME.get(env.REALTIME.idFromName(input.orgId));
  await stub.broadcast(accepting, {
    type: "notification",
    threadId: input.threadId,
    kind: input.kind,
  });
}

/** Tells these members that notifications they had about the thread are gone. */
export async function withdrawNotifications(
  env: Env,
  input: { orgId: string; threadId: string; memberIds: string[] },
) {
  if (input.memberIds.length === 0) return;
  const stub = env.REALTIME.get(env.REALTIME.idFromName(input.orgId));
  await stub.broadcast(input.memberIds, { type: "notification.removed", threadId: input.threadId });
}

/** Tells everyone who can see the inbox that a note was added. */
export async function announceNote(
  env: Env,
  db: Db,
  note: { orgId: string; mailboxId: string; threadId: string; noteId: string },
) {
  const audience = await mailboxAudience(db, [note.mailboxId]);
  if (audience.length === 0) return;
  const stub = env.REALTIME.get(env.REALTIME.idFromName(note.orgId));
  await stub.broadcast(
    audience.map((row) => row.memberId),
    {
      type: "note.created",
      mailboxId: note.mailboxId,
      threadId: note.threadId,
      noteId: note.noteId,
    },
  );
}

/** Tells everyone who can see the inbox that a conversation's SLA is at risk or breached. */
export async function announceSla(
  env: Env,
  db: Db,
  alert: {
    orgId: string;
    mailboxId: string;
    threadId: string;
    target: SlaTarget;
    kind: "sla_at_risk" | "sla_breached";
    dueAt: Date;
  },
) {
  const audience = await mailboxAudience(db, [alert.mailboxId]);
  if (audience.length === 0) return;
  const stub = env.REALTIME.get(env.REALTIME.idFromName(alert.orgId));
  await stub.broadcast(
    audience.map((row) => row.memberId),
    {
      type: alert.kind === "sla_at_risk" ? "sla.at_risk" : "sla.breached",
      mailboxId: alert.mailboxId,
      threadId: alert.threadId,
      target: alert.target,
      dueAt: alert.dueAt.toISOString(),
    },
  );
}

/** Tells each member whose action failed for good, on their org's realtime object. */
export async function notifyFailedActions(
  env: Env,
  failures: { orgId: string; memberId: string | null; actionId: string; error: string }[],
) {
  for (const { orgId, memberId, actionId, error } of failures) {
    if (!memberId) continue;
    const stub = env.REALTIME.get(env.REALTIME.idFromName(orgId));
    await stub.broadcast([memberId], { type: "action", actionId, status: "failed", error });
  }
}

async function sendExpoPush(
  db: Db,
  config: Config,
  memberIds: string[],
  message: { title: string; body: string },
) {
  const tokens = await pushTokensFor(db, memberIds);
  if (tokens.length === 0) return;
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${config.EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify(tokens.map((t) => ({ to: t.expoToken, ...message, sound: "default" }))),
  });
  if (!response.ok) {
    createLogger({ component: "realtime" }).warn("expo.push_failed", { status: response.status });
  }
}
