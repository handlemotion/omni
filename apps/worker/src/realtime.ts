import { DurableObject } from "cloudflare:workers";
import type { MailActionKind } from "@omni/contracts";
import { findAction, mailboxAudience, pushTokensFor, type Db } from "@omni/db";
import { publicActionError } from "./action-errors.ts";
import type { Config } from "./env.ts";

/** Header the Worker sets (never the client) to tell the DO whose socket this is. */
export const MEMBER_HEADER = "x-omni-member-id";

/**
 * What an open app hears. `changed`: refetch these threads (and lists and counts). `action`: an
 * outbox action this member asked for failed for good; `error` is safe to show.
 */
export type RealtimeEvent =
  | { type: "changed"; mailboxId: string; threadIds: string[] }
  | { type: "action"; actionId: string; kind: MailActionKind; status: "failed"; error: string };

/** How long a reported failure is remembered: well past the mail service's last redelivery. */
const FAILURE_DEDUPE_MS = 60 * 60_000;

/**
 * One instance per org. Each open app holds a hibernatable websocket tagged with its member id;
 * the DO can sleep between events and still route by tag. Clients refetch what changed.
 */
export class Realtime extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request) {
    const memberId = request.headers.get(MEMBER_HEADER);
    if (!memberId || request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [memberId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends the event to these members' sockets; returns the members with none open. */
  async broadcast(memberIds: string[], event: RealtimeEvent): Promise<string[]> {
    const message = JSON.stringify(event);
    const offline: string[] = [];
    for (const memberId of new Set(memberIds)) {
      const sockets = this.ctx.getWebSockets(memberId);
      if (sockets.length === 0) offline.push(memberId);
      for (const socket of sockets) {
        try {
          socket.send(message);
        } catch {
          // Closing; the runtime drops it.
        }
      }
    }
    return offline;
  }

  override async webSocketMessage() {
    // Clients only listen; "ping" is answered by the auto-response.
  }

  override async webSocketClose(socket: WebSocket, code: number) {
    socket.close(code === 1005 ? 1000 : code, "closing");
  }
}

/**
 * Tells every member who can see the mailboxes that these threads changed. With `push`, members
 * with no app open get an Expo notification instead (when enabled).
 */
export async function fanOut(
  env: Env,
  db: Db,
  config: Config,
  changes: Map<string, Set<string>>,
  options: { push?: boolean } = {},
) {
  const audience = await mailboxAudience(db, [...changes.keys()]);
  const offlineByMailbox = new Map<string, { address: string; memberIds: string[] }>();
  for (const [mailboxId, threadIds] of changes) {
    const rows = audience.filter((row) => row.mailboxId === mailboxId);
    const first = rows[0];
    if (!first) continue;
    const stub = env.REALTIME.get(env.REALTIME.idFromName(first.orgId));
    const offline = await stub.broadcast(
      rows.map((row) => row.memberId),
      { type: "changed", mailboxId, threadIds: [...threadIds] },
    );
    offlineByMailbox.set(mailboxId, { address: first.address, memberIds: offline });
  }
  if (options.push && config.EXPO_PUSH_ENABLED) {
    for (const { address, memberIds } of offlineByMailbox.values()) {
      await sendExpoPush(db, config, memberIds, { title: address, body: "New message" });
    }
  }
}

/**
 * Tells the member who asked for each action that it failed, once per action however often the
 * event is delivered. Actions that are not `failed` (a stale or unknown id) or have no member
 * (system mail, a removed member) tell nobody. An app that missed it reads `GET /api/actions/:id`.
 */
export async function notifyFailedActions(env: Env, db: Db, actionIds: string[]) {
  const reported = env.REPLAY_GUARD.get(env.REPLAY_GUARD.idFromName("failed-actions"));
  for (const actionId of new Set(actionIds)) {
    const action = await findAction(db, actionId);
    if (!action || action.status !== "failed" || !action.memberId) continue;
    if (!(await reported.claim(action.id, Date.now() + FAILURE_DEDUPE_MS))) continue;
    const stub = env.REALTIME.get(env.REALTIME.idFromName(action.orgId));
    await stub.broadcast([action.memberId], {
      type: "action",
      actionId: action.id,
      kind: action.kind,
      status: "failed",
      error: publicActionError(action.kind, action.lastError ?? ""),
    });
  }
}

/**
 * Expo push seam: off unless `EXPO_PUSH_ENABLED`. Sends no mail content, only which mailbox has
 * news. Receipts and token pruning come with the iOS app.
 */
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
  if (!response.ok) console.warn(`expo push failed: ${response.status}`);
}
