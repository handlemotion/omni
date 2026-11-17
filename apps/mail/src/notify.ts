import { randomUUID } from "node:crypto";
import { MAIL_EVENTS_PATH, type MailEvent, MAX_EVENTS_PER_REQUEST } from "@omni/contracts";
import { signRequest } from "@omni/crypto";
import type { Logger } from "./log.ts";
import { backoffDelay } from "./timing.ts";

/** An event on its way, with the `pending_mail_events` row that keeps it when it has one. */
export interface QueuedEvent {
  event: MailEvent;
  pendingId?: string;
}

function durableKey({ event, pendingId }: QueuedEvent) {
  if (pendingId) return `pending:${pendingId}`;
  return event.type === "message.created" ? `message:${event.messageId}` : null;
}

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
  onDelivered?: (events: QueuedEvent[]) => Promise<void>;
}

export class WorkerNotifier {
  private readonly options: Required<Omit<NotifierOptions, "onDelivered">> &
    Pick<NotifierOptions, "onDelivered">;
  private readonly pending = new Set<string>();
  private readonly url: string;
  private queue: QueuedEvent[] = [];
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

  /** `pendingId`: the event's `pending_mail_events` row, deleted once the Worker accepts it. */
  push(event: MailEvent, pendingId?: string) {
    if (this.stopped) return;
    const key = durableKey({ event, pendingId });
    if (key) {
      if (this.pending.has(key)) return;
      this.pending.add(key);
    }
    this.queue.push(pendingId ? { event, pendingId } : { event });
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.batchDelayMs);
  }

  /** Sends everything queued so far. Concurrent calls share one flush. */
  flush() {
    this.flushing ??= (async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_EVENTS_PER_REQUEST);
        try {
          if (await this.deliver(batch.map((queued) => queued.event))) {
            await this.options.onDelivered?.(batch);
          }
        } finally {
          for (const queued of batch) {
            const key = durableKey(queued);
            if (key) this.pending.delete(key);
          }
        }
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Stops retrying and sends what is queued once. */
  async stop() {
    this.stopped = true;
    this.wake?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush().catch(() => {});
  }

  private async deliver(events: MailEvent[]) {
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
