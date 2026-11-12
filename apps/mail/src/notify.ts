// Tells the Worker about newly indexed mail (`POST /internal/mail-events`, HMAC-signed) so it can
// queue AI jobs, apply the helpdesk status rules and notify open apps. Events are batched and
// retried with backoff; delivery is at least once, and the Worker dedupes by message id.
// `message.created` is durable: each new row is flagged `notify_pending` until the Worker accepts
// its event (`onDelivered`), and `sweep` re-sends whatever a crash or a Worker outage left behind.
import { randomUUID } from "node:crypto";
import { MAIL_EVENTS_PATH, type MailEvent, MAX_EVENTS_PER_REQUEST } from "@omni/contracts";
import { signRequest } from "@omni/crypto";
import type { Logger } from "./log.ts";
import { backoffDelay } from "./timing.ts";

export interface NotifierOptions {
  workerUrl: string;
  secret: string;
  logger: Logger;
  /** Waits this long after the first queued event, so a burst goes out as one request. */
  batchDelayMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** After this many failed attempts a batch is dropped and logged (the sweep sends it again). */
  maxAttempts?: number;
  /** The Worker accepted these events. Must not throw. */
  onDelivered?: (events: MailEvent[]) => Promise<void>;
}

export class WorkerNotifier {
  private readonly options: Required<Omit<NotifierOptions, "onDelivered">> &
    Pick<NotifierOptions, "onDelivered">;
  /** `message.created` ids queued or in flight, so a sweep never sends one twice at once. */
  private readonly pending = new Set<string>();
  private readonly url: string;
  private queue: MailEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(options: NotifierOptions) {
    this.options = {
      batchDelayMs: 50,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000,
      maxAttempts: 8,
      ...options,
    };
    this.url = new URL(MAIL_EVENTS_PATH, options.workerUrl).toString();
  }

  push(event: MailEvent): void {
    if (this.stopped) return;
    if (event.type === "message.created") {
      if (this.pending.has(event.messageId)) return;
      this.pending.add(event.messageId);
    }
    this.queue.push(event);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.batchDelayMs);
  }

  /** Sends everything queued so far. Concurrent calls share one flush. */
  flush(): Promise<void> {
    this.flushing ??= (async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_EVENTS_PER_REQUEST);
        try {
          if (await this.deliver(batch)) await this.options.onDelivered?.(batch);
        } finally {
          for (const event of batch) {
            if (event.type === "message.created") this.pending.delete(event.messageId);
          }
        }
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Stops retrying and sends what is queued once. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush().catch(() => {});
  }

  /** True once the Worker accepted the batch; false when it was dropped. */
  private async deliver(events: MailEvent[]): Promise<boolean> {
    const body = JSON.stringify({ events });
    const log = this.options.logger;
    for (let attempt = 1; ; attempt++) {
      try {
        const headers = await signRequest({
          secret: this.options.secret,
          method: "POST",
          path: new URL(this.url).pathname,
          body,
          nonce: randomUUID(),
        });
        const response = await fetch(this.url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body,
        });
        if (response.ok) return true;
        throw new Error(`worker answered ${response.status}`);
      } catch (error) {
        if (this.stopped || attempt >= this.options.maxAttempts) {
          log.error("notify.dropped", { events: events.length, attempt, error });
          return false;
        }
        const retryInMs = Math.round(
          backoffDelay(attempt, this.options.retryBaseMs, this.options.retryMaxMs),
        );
        log.warn("notify.failed", { events: events.length, attempt, retryInMs, error });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryInMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }
}
