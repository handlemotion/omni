import type { Forwarding } from "./forward-copy.ts";
import { Effect, Fiber, Semaphore } from "effect";
import type { Logger } from "./log.ts";
import {
  MailboxConnection,
  type MailboxConfig,
  type NewMessageEvent,
} from "./mailbox-connection.ts";
import { OutboxExecutor } from "./outbox.ts";
import type { ActionSource, MailStore, SendFiles } from "./ports.ts";
import { every } from "./timing.ts";

export interface SupervisorOptions {
  store: MailStore;
  actions: ActionSource;
  /** Reads send attachments from the object store. */
  files?: SendFiles;
  forwarding?: Forwarding;
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
  /** Wakes the outbox when the next pending action is due (an undo-send window ends). */
  private dueTimer: NodeJS.Timeout | null = null;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.log = options.logger;
    const permits = Semaphore.makeUnsafe(options.concurrency ?? 4);
    this.permits = permits;
    this.limit = (task) => Effect.runPromise(Semaphore.withPermit(permits, Effect.promise(task)));
    this.outbox = new OutboxExecutor({
      actions: options.actions,
      logger: options.logger,
      store: options.store,
      files: options.files,
      forwarding: options.forwarding,
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
    connection.on("connected", () => void this.ping({ mailboxId: mailbox.id }));
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

  /**
   * Removes the mailbox and waits for outbox work already running, so a send that started before
   * finishes (or fails) before the caller deletes the mailbox's rows or revokes its credentials.
   */
  async retire(mailboxId: string): Promise<void> {
    await this.remove(mailboxId);
    await Promise.all(this.inFlight);
  }

  /** Runs the outbox now. The HTTP ping lands here; `cause` names what asked, for the log. */
  async ping(cause: Record<string, unknown> = {}): Promise<void> {
    if (!this.running) return;
    const drain = this.outbox.drain().then(
      (actions) => this.log.debug("outbox.drained", { actions, ...cause }),
      (error: unknown) => this.log.error("outbox.drain_failed", { error }),
    );
    this.inFlight.add(drain);
    try {
      await drain;
    } finally {
      this.inFlight.delete(drain);
    }
    await this.wakeWhenDue();
  }

  /**
   * A send queued with an undo window is not due when the Worker pings. Without this it would
   * wait for the next poll (30 s); with it, it leaves when the window ends. Beyond the poll
   * interval the poll covers it.
   */
  private async wakeWhenDue(): Promise<void> {
    if (!this.running) return;
    const due = await this.options.actions.nextDueAt().catch((error: unknown) => {
      this.log.warn("outbox.next_due_failed", { error });
      return null;
    });
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = null;
    if (!due || !this.running) return;
    const delay = Math.max(0, due.getTime() - Date.now()) + 50;
    if (delay > (this.options.outboxIntervalMs ?? 30_000)) return;
    this.dueTimer = setTimeout(() => {
      this.dueTimer = null;
      void this.ping();
    }, delay);
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
    if (this.dueTimer) clearTimeout(this.dueTimer);
    this.dueTimer = null;
    const loops = this.loops;
    this.loops = [];
    await Effect.runPromise(Effect.forEach(loops, Fiber.interrupt, { discard: true }));
    await this.outbox.stop();
    await Promise.all(this.inFlight);
    await Promise.all([...this.connections.values()].map((c) => c.stop()));
    this.connections.clear();
  }
}
