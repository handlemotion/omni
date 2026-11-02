// Tells the Worker about newly indexed mail and permanently failed outbox actions (`POST
// /internal/mail-events`, HMAC-signed) so it can queue AI jobs and notify open apps. Events are
// batched and retried with backoff; delivery is at least once, and the Worker dedupes by message
// or action id. Events still queued when the process dies are lost: the Worker's triage sweep is
// the backstop for new mail, and `GET /api/actions/:id` for failures.
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
  /** After this many failed attempts a batch is dropped and logged. */
  maxAttempts?: number;
}

export class WorkerNotifier {
  private readonly options: Required<NotifierOptions>;
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
        await this.deliver(batch);
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

  private async deliver(events: MailEvent[]): Promise<void> {
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
        if (response.ok) return;
        throw new Error(`worker answered ${response.status}`);
      } catch (error) {
        if (this.stopped || attempt >= this.options.maxAttempts) {
          log.error("notify.dropped", { events: events.length, attempt, error });
          return;
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
