import type { StorageLiveRecord } from "@omni/contracts";
import { readSocketMessage, type RealtimeEvent } from "./realtime-events.ts";

export type { NotificationEvent, NotificationKind, RealtimeEvent } from "./realtime-events.ts";
export { LiveParts, splitLiveRecord, type LiveWhole } from "@omni/contracts/storage-live-parts";
export {
  STORAGE_DOC_PRESENCE_MAX as DOC_PRESENCE_MAX,
  STORAGE_LIVE_SNAP_EVERY as LIVE_SNAP_EVERY,
} from "@omni/contracts/storage-types";

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
  /**
   * An app that shows Talk: the member counts as online to their teammates, and the socket hears
   * `talk.*` events. Ignored on a watch socket.
   */
  talk?: boolean;
  onEvent: (event: RealtimeEvent) => void;
  /**
   * Socket state. An `"open"` with `reconnected: true` follows a socket that dropped or never
   * opened, so events may have been missed while none was listening: refetch what is on screen,
   * unless `resumed`. Then the Worker has already handed `onEvent` everything addressed to this
   * member that went by meanwhile (mail, helpdesk, notifications, CRM, calendar, Drive listings,
   * Talk), in order, before this `"open"`. Presence and live documents are not replayed.
   */
  onStatus?: (status: RealtimeStatus, info: { reconnected: boolean; resumed: boolean }) => void;
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
  /**
   * How long an opened socket waits for the Worker's `sync` (where its log is, and whether it
   * resumed) before saying `open` without it, as for a Worker that keeps no log.
   */
  syncTimeoutMs?: number;
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
    syncTimeoutMs = 3_000,
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
  else if (options.talk) url.searchParams.set("talk", "1");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  let socket: WebSocket | undefined;
  let attempt = 0;
  let dropped = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let probe: (() => void) | undefined;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let cursor: { epoch: string; seq: number } | undefined;
  const status = (next: RealtimeStatus, resumed = false) =>
    options.onStatus?.(next, { reconnected: dropped, resumed });

  const connect = () => {
    status("connecting");
    const at = new URL(url);
    if (cursor && !shared) at.searchParams.set("since", `${cursor.epoch}.${cursor.seq}`);
    const current = openSocket(at.toString());
    socket = current;
    let awaitingPong = false;
    let awaitingSync = false;
    const opened = (resumed: boolean) => {
      if (!awaitingSync) return;
      awaitingSync = false;
      clearTimeout(syncTimer);
      status("open", resumed);
    };

    const drop = () => {
      if (socket !== current) return;
      socket = undefined;
      probe = undefined;
      clearInterval(pingTimer);
      clearTimeout(probeTimer);
      clearTimeout(syncTimer);
      try {
        current.close();
      } catch {}
      dropped = true;
      status("closed");
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
      awaitingSync = true;
      syncTimer = setTimeout(() => opened(false), syncTimeoutMs);
    });
    current.addEventListener("message", (message) => {
      if (socket !== current || typeof message.data !== "string") return;
      if (message.data === "pong") {
        awaitingPong = false;
        clearTimeout(probeTimer);
        return;
      }
      const read = readSocketMessage(message.data);
      if (read.kind === "sync") {
        cursor = { epoch: read.epoch, seq: read.seq };
        return opened(read.resumed);
      }
      if (cursor && read.seq !== undefined && read.seq > cursor.seq) cursor.seq = read.seq;
      if (read.event) options.onEvent(read.event);
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
      clearTimeout(syncTimer);
      current?.close(1000);
      if (current) status("closed");
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
