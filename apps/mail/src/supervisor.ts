import type { Logger } from "./log.ts";
import {
  MailboxConnection,
  type MailboxConfig,
  type NewMessageEvent,
} from "./mailbox-connection.ts";
import { OutboxExecutor } from "./outbox.ts";
import type { ActionSource, MailStore } from "./ports.ts";
import { createLimiter } from "./timing.ts";

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
  private readonly limit: ReturnType<typeof createLimiter>;
  private readonly outbox: OutboxExecutor;
  private readonly log: Logger;
  private readonly options: SupervisorOptions;
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.log = options.logger;
    this.limit = createLimiter(options.concurrency ?? 4);
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

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timers.push(
      setInterval(() => void this.syncAll(), this.options.syncIntervalMs ?? 5 * 60_000),
      setInterval(() => void this.ping(), this.options.outboxIntervalMs ?? 30_000),
    );
  }

  /** Adds a mailbox and connects it in the background. Connect attempts share the `concurrency` gate. */
  add(mailbox: MailboxConfig): MailboxConnection {
    const existing = this.connections.get(mailbox.id);
    if (existing) return existing;
    const connection = new MailboxConnection(mailbox, {
      store: this.options.store,
      logger: this.log,
      gate: this.limit,
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
    try {
      await this.outbox.drain();
    } catch (error) {
      this.log.error("outbox.drain_failed", { error });
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

  /** Stops timers, lets in-flight work finish, and logs out of every mailbox. */
  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await Promise.all([...this.connections.values()].map((c) => c.stop()));
    this.connections.clear();
  }
}
