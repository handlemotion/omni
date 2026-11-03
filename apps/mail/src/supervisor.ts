import { Duration, Effect, Fiber, Schedule, Semaphore } from "effect";
import type { Logger } from "./log.ts";
import {
  MailboxConnection,
  type MailboxConfig,
  type NewMessageEvent,
} from "./mailbox-connection.ts";
import { OutboxExecutor } from "./outbox.ts";
import type { ActionSource, MailStore } from "./ports.ts";

export interface SupervisorOptions {
  store: MailStore;
  actions: ActionSource;
  logger: Logger;
  /** Non-inbox folders are synced on this interval; INBOX is live through IDLE. */
  syncIntervalMs?: number;
  /** The outbox is polled on this interval, so a lost ping only delays an action. */
  outboxIntervalMs?: number;
  /** Mailboxes connecting or syncing at the same time. */
  concurrency?: number;
  onMessage?: (event: NewMessageEvent) => void;
}

/** Owns one `MailboxConnection` per mailbox, the periodic folder sync, and the outbox loop. */
export class Supervisor {
  private readonly connections = new Map<string, MailboxConnection>();
  /** Mailboxes connecting or syncing at once (`concurrency`). */
  private readonly permits: Semaphore.Semaphore;
  private readonly limit: <T>(task: () => Promise<T>) => Promise<T>;
  private readonly outbox: OutboxExecutor;
  private readonly log: Logger;
  private readonly options: SupervisorOptions;
  /** The periodic folder sync and outbox poll. */
  private loops: Fiber.Fiber<unknown, unknown>[] = [];
  private running = false;
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.log = options.logger;
    const permits = Semaphore.makeUnsafe(options.concurrency ?? 4);
    this.permits = permits;
    this.limit = (task) => Effect.runPromise(Semaphore.withPermit(permits, Effect.promise(task)));
    this.outbox = new OutboxExecutor({
      actions: options.actions,
      logger: options.logger,
      connection: (id) => this.connections.get(id),
    });
  }

  get mailboxCount(): number {
    return this.connections.size;
  }

  get connectedCount(): number {
    return [...this.connections.values()].filter((c) => c.connected).length;
  }

  /** Connected and past the first sync: their outbox actions run. */
  get readyCount(): number {
    return [...this.connections.values()].filter((c) => c.isReady).length;
  }

  connection(mailboxId: string): MailboxConnection | undefined {
    return this.connections.get(mailboxId);
  }

  has(mailboxId: string): boolean {
    return this.connections.has(mailboxId);
  }

  mailboxIds(): string[] {
    return [...this.connections.keys()];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = [
      every(this.options.syncIntervalMs ?? 5 * 60_000, () => this.syncAll()),
      every(this.options.outboxIntervalMs ?? 30_000, () => this.ping()),
    ];
  }

  /** Adds a mailbox and connects it in the background. Connect attempts share the `concurrency` gate. */
  add(mailbox: MailboxConfig): MailboxConnection {
    if (this.stopping) throw new Error("supervisor is stopping");
    const existing = this.connections.get(mailbox.id);
    if (existing) return existing;
    const connection = new MailboxConnection(mailbox, {
      store: this.options.store,
      logger: this.log,
      gate: this.permits,
    });
    if (this.options.onMessage) connection.on("message", this.options.onMessage);
    // Actions that failed while the mailbox was offline become runnable again on reconnect.
    connection.on("connected", () => void this.ping());
    this.connections.set(mailbox.id, connection);
    void connection
      .start()
      .catch((error: unknown) =>
        this.log.error("supervisor.start_failed", { mailboxId: mailbox.id, error }),
      );
    return connection;
  }

  async remove(mailboxId: string): Promise<void> {
    const connection = this.connections.get(mailboxId);
    this.connections.delete(mailboxId);
    await connection?.stop();
  }

  /** Runs the outbox now. The HTTP ping lands here. */
  async ping(): Promise<void> {
    if (!this.running) return;
    const drain = this.outbox.drain().then(
      () => {},
      (error: unknown) => this.log.error("outbox.drain_failed", { error }),
    );
    this.inFlight.add(drain);
    try {
      await drain;
    } finally {
      this.inFlight.delete(drain);
    }
  }

  async syncAll(): Promise<void> {
    await Promise.all(
      [...this.connections.values()]
        .filter((c) => c.connected)
        .map((c) =>
          this.limit(() => c.syncAll()).catch((error: unknown) =>
            this.log.warn("sync.mailbox_failed", { mailboxId: c.mailbox.id, error }),
          ),
        ),
    );
  }

  /**
   * Stops the periodic loops and claims, lets claimed actions finish and record their outcome while storage
   * is still open, then stops every mailbox: each finishes the message it is storing, abandons the
   * rest of its sync (the next start resumes it) and logs out.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    const loops = this.loops;
    this.loops = [];
    await Effect.runPromise(Effect.forEach(loops, Fiber.interrupt, { discard: true }));
    await this.outbox.stop();
    await Promise.all(this.inFlight);
    await Promise.all([...this.connections.values()].map((c) => c.stop()));
    this.connections.clear();
  }
}

/**
 * Runs `task` every `intervalMs`, first after one interval, on its own fiber. A run that takes
 * longer than the interval delays the next instead of overlapping it, and a failure (these tasks
 * log their own) never ends the loop.
 */
function every(intervalMs: number, task: () => Promise<unknown>): Fiber.Fiber<unknown, unknown> {
  return Effect.runFork(
    Effect.schedule(
      Effect.tryPromise(task).pipe(Effect.ignore),
      Schedule.fixed(Duration.millis(intervalMs)),
    ),
  );
}
