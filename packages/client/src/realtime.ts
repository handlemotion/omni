import type { Realtime as RealtimeObject } from "@omni/worker";

/** What the Worker's realtime Durable Object broadcasts, typed from its `broadcast`. */
export type RealtimeEvent = Parameters<RealtimeObject["broadcast"]>[1];
export type RealtimeStatus = "connecting" | "open" | "closed";

export interface RealtimeOptions {
  /** The Worker's origin; the socket is `/api/realtime` on it. */
  baseUrl: string;
  onEvent: (event: RealtimeEvent) => void;
  /**
   * Socket state. An `"open"` with `reconnected: true` means events may have been missed while
   * the socket was down: refetch what is on screen.
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
}

/**
 * Keeps one realtime socket open, reconnecting with jittered exponential backoff, and hands
 * each `changed` event to `onEvent`. Messages it does not know are ignored, so the Worker can
 * add event types without breaking older apps.
 */
export function connectRealtime(options: RealtimeOptions): Realtime {
  const {
    minDelayMs = 500,
    maxDelayMs = 30_000,
    pingIntervalMs = 25_000,
    probeTimeoutMs = 5_000,
    openSocket = (url) => new WebSocket(url),
  } = options;
  const url = new URL("/api/realtime", options.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  let socket: WebSocket | undefined;
  let attempt = 0;
  let everOpened = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pings the open socket now; set while one is open. */
  let probe: (() => void) | undefined;

  const connect = () => {
    options.onStatus?.("connecting", { reconnected: everOpened });
    const current = openSocket(url.toString());
    socket = current;
    let awaitingPong = false;

    // A socket is dropped once: on close, error, or a missed pong, whichever comes first.
    const drop = () => {
      if (socket !== current) return;
      socket = undefined;
      probe = undefined;
      clearInterval(pingTimer);
      clearTimeout(probeTimer);
      try {
        current.close();
      } catch {
        // Already closed.
      }
      options.onStatus?.("closed", { reconnected: everOpened });
      if (stopped) return;
      const ceiling = Math.min(maxDelayMs, minDelayMs * 2 ** attempt++);
      retryTimer = setTimeout(connect, ceiling / 2 + (Math.random() * ceiling) / 2);
    };

    current.addEventListener("open", () => {
      if (socket !== current) return;
      const reconnected = everOpened;
      everOpened = true;
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
      options.onStatus?.("open", { reconnected });
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
    current.addEventListener("close", drop);
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
      if (current) options.onStatus?.("closed", { reconnected: everOpened });
    },
    wake() {
      if (stopped) return;
      if (socket) return probe?.();
      // Waiting out the backoff: the reason to wait may be gone, so try now and start over.
      clearTimeout(retryTimer);
      attempt = 0;
      connect();
    },
  };
}

function parseEvent(data: string): RealtimeEvent | undefined {
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
    event.type === "action" &&
    typeof event.actionId === "string" &&
    event.status === "failed" &&
    typeof event.error === "string"
  ) {
    return { type: "action", actionId: event.actionId, status: "failed", error: event.error };
  }
  return undefined;
}
