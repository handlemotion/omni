import { EventEmitter } from "node:events";
import { Data, Deferred, Duration, Effect, Fiber, Schedule, Semaphore } from "effect";
import { ImapFlow } from "imapflow";
import {
  type FetchLimits,
  type FolderSyncResult,
  type NewMessageEvent,
  StoppedError,
  syncFolder,
} from "./folder-sync.ts";
import { type Capabilities, detectCapabilities, listFolders } from "./imap-server.ts";
import type { Logger } from "./log.ts";
import { loginFor, type MailboxConfig } from "./mailbox-config.ts";
import { imapTls } from "./mail-hosts.ts";
import type { FolderInfo, FolderRole, MailStore } from "./ports.ts";
import { backoff } from "./timing.ts";

const FILED_ROLES = new Set<FolderRole>(["archive", "trash", "junk"]);

/** What an outbox action gets while it holds the connection. */
export interface ImapSession {
  client: ImapFlow;
  capabilities: Capabilities;
  folder(role: FolderRole): FolderInfo | undefined;
  folders(): FolderInfo[];
  /** The folder for `role`, created at `path` when the server has none. */
  ensureFolder(role: FolderRole, path: string): Promise<FolderInfo>;
  syncFolder(path: string): Promise<FolderSyncResult>;
}

export interface ConnectionOptions extends Partial<FetchLimits> {
  store: MailStore;
  logger: Logger;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /**
   * A connection that stayed ready this long resets the backoff. One that drops sooner keeps
   * backing off, so a server that accepts the login and then hangs up is not hammered.
   */
  stableAfterMs?: number;
  /**
   * Socket silence before ImapFlow probes with NOOP; a second silence closes the connection. This
   * bounds how long a dead peer (NAT dropped the flow, no FIN) goes unnoticed to about twice this.
   */
  socketTimeoutMs?: number;
  /** Bounds work shared across mailboxes; each connect attempt (with its initial sync) holds a permit. */
  gate?: Semaphore.Semaphore;
  /**
   * Rejected logins in a row, each a full `reconnectMaxMs` apart, before the connection gives up
   * and emits `gave_up`. More than one, so a mail host's brief auth outage does not need a restart.
   */
  maxAuthFailures?: number;
}

type Events = {
  message: [NewMessageEvent];
  /** Logged in and INBOX synced: outbox actions run from here on, other folders sync next. */
  connected: [Capabilities];
  disconnected: [];
  /** The server rejected the credentials. Retried at the backoff ceiling, up to `maxAuthFailures`. */
  auth_failed: [];
  /** Stopped retrying after `maxAuthFailures` rejected logins. Only a new `start()` tries again. */
  gave_up: [];
};

/** The server rejected the login. Retrying soon cannot fix it; the user must replace the password. */
export class ImapAuthFailed extends Data.TaggedError("ImapAuthFailed")<{ cause: unknown }> {}

/** Connecting or the first sync failed: network, TLS, a timeout, storage. Retried with backoff. */
export class ImapConnectFailed extends Data.TaggedError("ImapConnectFailed")<{ cause: unknown }> {}

class ImapDropped extends Data.TaggedError("ImapDropped")<{}> {}

type SessionError = ImapAuthFailed | ImapConnectFailed | ImapDropped;

/** The mailbox is offline or still on its first sync. Retry later; the action is not at fault. */
export class MailboxUnavailableError extends Error {
  override name = "MailboxUnavailableError";
}

/**
 * One IMAP connection for one mailbox. It IDLEs on INBOX, syncs folders on request, and runs
 * outbox actions. Every IMAP command goes through one queue, so a sync and an action never
 * interleave on the wire, and the connection always returns to INBOX to keep IDLE there.
 */
export class MailboxConnection extends EventEmitter<Events> {
  readonly mailbox: MailboxConfig;
  private readonly store: MailStore;
  private readonly log: Logger;
  private readonly limits: FetchLimits;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly stableAfterMs: number;
  private readonly socketTimeoutMs: number;
  private readonly gate: Semaphore.Semaphore;
  private readonly maxAuthFailures: number;

  private client: ImapFlow | null = null;
  private capabilities: Capabilities | null = null;
  private folders: FolderInfo[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = true;
  private ready = false;
  private readySince = 0;
  private authFailures = 0;
  private fiber: Fiber.Fiber<void> | null = null;
  private started: PromiseWithResolvers<void> | null = null;
  private syncingAll: Promise<FolderSyncResult[]> | null = null;
  private inboxSyncQueued = false;
  private filedSyncQueued = false;

  constructor(mailbox: MailboxConfig, options: ConnectionOptions) {
    super();
    this.mailbox = mailbox;
    this.store = options.store;
    this.log = options.logger.child({ mailboxId: mailbox.id });
    this.limits = {
      batchSize: options.batchSize ?? 50,
      batchBytes: options.batchBytes ?? 16 * 1024 * 1024,
      streamAboveBytes: options.streamAboveBytes ?? 4 * 1024 * 1024,
    };
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5 * 60_000;
    this.stableAfterMs = options.stableAfterMs ?? 60_000;
    this.socketTimeoutMs = options.socketTimeoutMs ?? 90_000;
    this.gate = options.gate ?? Semaphore.makeUnsafe(1);
    this.maxAuthFailures = options.maxAuthFailures ?? 3;
  }

  get connected() {
    return this.client?.usable === true;
  }

  /** Connected and past the first INBOX sync. */
  get isReady() {
    return this.ready && this.connected;
  }

  /**
   * Connects and syncs every folder, retrying with backoff until that works, `stop()` is called, or
   * the server rejects the login `maxAuthFailures` times. A dropped connection reconnects the same
   * way for as long as the connection runs.
   */
  start() {
    if (this.fiber && this.started) return this.started.promise;
    this.stopped = false;
    this.authFailures = 0;
    this.started = Promise.withResolvers<void>();
    this.fiber = Effect.runFork(this.lifecycle());
    return this.started.promise;
  }

  /**
   * Lets the message being stored finish, abandons the rest of any sync (the next start resumes
   * it), waits for a running outbox action, then interrupts the connection: its scope logs out
   * and closes the socket, whether it was connected, mid-connect, or waiting to retry.
   */
  async stop() {
    this.stopped = true;
    this.ready = false;
    await this.queue.catch(() => {});
    const fiber = this.fiber;
    this.fiber = null;
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
    this.started?.resolve();
  }

  /**
   * Re-discovers folders and syncs all of them, INBOX last so IDLE resumes there. A folder that
   * fails is logged and skipped, so one bad folder never blocks the rest. A call while one is
   * queued or running joins it rather than queueing another full pass.
   *
   * A message deleted on the server leaves its row with no copy. So does a move, until the
   * destination folder is synced, so a missing copy alone proves nothing. A message that had no
   * copy when this pass began, and still has none after every folder synced cleanly, is gone
   * everywhere: the pass ends by deleting it (and a thread left empty).
   */
  syncAll() {
    this.syncingAll ??= (async () => {
      try {
        const { orphans, ordered } = await this.enqueue(async () => {
          const orphans = await this.store.orphanedMessages(this.mailbox.id);
          await this.discoverFolders();
          const inbox = this.inbox();
          const ordered = [...this.folders.filter((f) => f !== inbox), ...(inbox ? [inbox] : [])];
          return { orphans, ordered };
        });
        const results: FolderSyncResult[] = [];
        let clean = true;
        for (const folder of ordered) {
          try {
            const result = await this.enqueue(() => this.syncFolderNow(folder.path));
            if (result.failed > 0) clean = false;
            results.push(result);
          } catch (error) {
            if (error instanceof StoppedError || !this.connected) throw error;
            clean = false;
            this.log.warn("sync.folder_failed", { folder: folder.path, error });
          }
        }
        if (clean && orphans.length > 0) {
          const pruned = await this.enqueue(() =>
            this.store.pruneMessages(this.mailbox.id, orphans),
          );
          if (pruned.messages > 0) this.log.info("sync.pruned", pruned);
        }
        if (clean) {
          const discarded = await this.store.reportDiscarded(this.mailbox.id);
          if (discarded > 0) this.log.info("sync.discarded", { threads: discarded });
        }
        this.log.info("sync.all_done", { folders: results.length, clean });
        return results;
      } finally {
        this.syncingAll = null;
      }
    })();
    return this.syncingAll satisfies Promise<FolderSyncResult[]>;
  }

  syncFolder(path: string) {
    return this.enqueue(() => this.syncFolderNow(path)) satisfies Promise<FolderSyncResult>;
  }

  /**
   * Runs `task` with exclusive use of the connection. Fails fast with `MailboxUnavailableError`
   * while disconnected or still on the first sync, so an outbox action never waits behind a
   * long import (holding an outbox slot other mailboxes need).
   */
  run<T>(task: (session: ImapSession) => Promise<T>) {
    if (!this.isReady) {
      return Promise.reject(
        new MailboxUnavailableError(`mailbox ${this.mailbox.id} is not ready`),
      ) satisfies Promise<T>;
    }
    return this.enqueue(() => {
      const client = this.requireClient();
      return task({
        client,
        capabilities: this.capabilities as Capabilities,
        folder: (role) => this.folders.find((f) => f.role === role),
        folders: () => this.folders,
        ensureFolder: (role, path) => this.ensureFolder(role, path),
        syncFolder: (path) => this.syncFolderNow(path),
      });
    }) satisfies Promise<T>;
  }

  private lifecycle() {
    const schedule = backoff({
      baseMs: this.reconnectBaseMs,
      maxMs: this.reconnectMaxMs,
      floorMs: this.reconnectBaseMs / 2,
    }).pipe(
      Schedule.setInputType<SessionError>(),
      Schedule.while(
        ({ input }) =>
          !(input instanceof ImapAuthFailed) || this.authFailures < this.maxAuthFailures,
      ),
      Schedule.modifyDelay(({ input, duration }) =>
        Effect.succeed(
          input instanceof ImapAuthFailed ? Duration.millis(this.reconnectMaxMs) : duration,
        ),
      ),
      Schedule.tap(({ input, attempt, duration }) =>
        Effect.sync(() => {
          const retryInMs = Duration.toMillis(duration);
          if (input instanceof ImapDropped) {
            this.log.warn("imap.disconnected", { wasReady: true, failures: attempt, retryInMs });
          } else {
            this.log.warn("imap.connect_failed", {
              error: input.cause,
              attempt,
              authFailed: input instanceof ImapAuthFailed,
              retryInMs,
            });
          }
        }),
      ),
    );

    return this.session().pipe(
      Effect.catchDefect((cause) => Effect.fail(new ImapConnectFailed({ cause }))),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!(error instanceof ImapAuthFailed)) return;
          if (this.mailbox.auth.kind === "oauth2") this.mailbox.auth.token.invalidate();
          this.authFailures++;
          this.emit("auth_failed");
        }),
      ),
      Effect.retry(schedule),
      Effect.forever,
      Effect.catch((error) =>
        Effect.sync(() => {
          this.log.error("imap.gave_up", {
            reason: error.name,
            error: "cause" in error ? error.cause : undefined,
            authFailures: this.authFailures,
          });
          this.emit("gave_up");
        }),
      ),
      Effect.ensuring(Effect.sync(() => this.started?.resolve())),
    ) satisfies Effect.Effect<void>;
  }

  private session() {
    const result: Effect.Effect<void, SessionError> = Effect.gen({ self: this }, function* () {
      const login = yield* Effect.tryPromise({
        try: () => loginFor(this.mailbox),
        catch: (cause) =>
          this.mailbox.auth.kind === "oauth2" && this.mailbox.auth.token.isRevoked(cause)
            ? new ImapAuthFailed({ cause })
            : new ImapConnectFailed({ cause }),
      });
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => this.createClient(login)),
        (created) => this.release(created),
      );
      const closed = Deferred.makeUnsafe<void>();
      client.on("close", () => Deferred.doneUnsafe(closed, Effect.void));

      yield* Semaphore.withPermit(
        this.gate,
        Effect.tryPromise({
          try: () => this.connect(client),
          catch: (cause) =>
            (cause as { authenticationFailed?: unknown }).authenticationFailed === true
              ? new ImapAuthFailed({ cause })
              : new ImapConnectFailed({ cause }),
        }),
      );
      this.ready = true;
      this.readySince = Date.now();
      this.authFailures = 0;
      this.emit("connected", this.capabilities as Capabilities);
      this.log.info("imap.connected");
      this.started?.resolve();
      void Effect.runPromise(
        Semaphore.withPermit(
          this.gate,
          Effect.promise(() =>
            this.syncAll().catch((error: unknown) => {
              if (!this.stopped && this.connected) this.log.warn("sync.all_failed", { error });
            }),
          ),
        ),
      );

      yield* Deferred.await(closed);
      if (this.client === client) this.client = null;
      this.ready = false;
      this.emit("disconnected");
      if (Date.now() - this.readySince < this.stableAfterMs) return yield* new ImapDropped();
      this.log.warn("imap.disconnected", { wasReady: true, failures: 0 });
    }).pipe(Effect.scoped);
    return result;
  }

  private createClient(auth: Awaited<ReturnType<typeof loginFor>>) {
    const { imap } = this.mailbox;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      ...imapTls(imap),
      auth,
      logger: false,
      clientInfo: { name: "omni" },
      autoIdleDelay: 1_000,
      maxIdleTime: 4 * 60_000,
      socketTimeout: this.socketTimeoutMs,
      greetingTimeout: 30_000,
      connectionTimeout: 60_000,
    });
    client.on("error", (error: Error) => this.log.warn("imap.error", { error }));
    for (const name of ["exists", "expunge", "flags"] as const) {
      client.on(name, (event: { path: string }) => {
        if (event.path !== this.inbox()?.path) return;
        this.requestInboxSync();
        if (name === "expunge" || (name === "flags" && this.capabilities?.gmail)) {
          this.requestFiledSync();
        }
      });
    }
    return client satisfies ImapFlow;
  }

  private async connect(client: ImapFlow) {
    try {
      await client.connect();
      this.client = client;
      this.capabilities = detectCapabilities(client);
      this.log.info("imap.capabilities", { ...this.capabilities });
      await this.enqueue(async () => {
        await this.discoverFolders();
        const inbox = this.inbox();
        if (inbox) await this.syncFolderNow(inbox.path);
        if (inbox && this.mailbox.provider === "gmail") {
          await this.store.reconcileFolder(this.mailbox.id, inbox.path);
        }
      });
      if (!client.usable) throw new Error("connection closed during the first sync");
    } catch (error) {
      if (this.client === client) this.client = null;
      throw error;
    }
  }

  private release(client: ImapFlow) {
    return Effect.promise(async () => {
      if (this.client === client) this.client = null;
      if (client.usable) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          client.logout().catch(() => {}),
          new Promise((resolve) => (timer = setTimeout(resolve, 5_000))),
        ]);
        clearTimeout(timer);
      }
      client.close();
    }) satisfies Effect.Effect<void>;
  }

  private enqueue<T>(task: () => Promise<T>) {
    const run = this.queue.then(async () => {
      try {
        return await task();
      } finally {
        await this.returnToInbox();
      }
    });
    this.queue = run.catch(() => {});
    return run satisfies Promise<T>;
  }

  private async returnToInbox() {
    const client = this.client;
    const inbox = this.inbox();
    if (!client?.usable || !inbox || client.mailbox === false) return;
    if (client.mailbox.path === inbox.path) return;
    await client.mailboxOpen(inbox.path).catch(() => {});
    this.requestInboxSync();
  }

  private requestInboxSync() {
    const inbox = this.inbox();
    if (this.inboxSyncQueued || !inbox) return;
    this.inboxSyncQueued = true;
    this.enqueue(() => {
      this.inboxSyncQueued = false;
      return this.syncFolderNow(inbox.path);
    }).catch((error: unknown) => {
      if (!this.stopped) this.log.warn("sync.inbox_failed", { error });
    });
  }

  private requestFiledSync() {
    if (this.filedSyncQueued) return;
    this.filedSyncQueued = true;
    this.enqueue(async () => {
      this.filedSyncQueued = false;
      for (const folder of this.folders) {
        if (FILED_ROLES.has(folder.role)) await this.syncFolderNow(folder.path);
      }
    }).catch((error: unknown) => {
      if (!this.stopped) this.log.warn("sync.filed_failed", { error });
    });
  }

  private requireClient() {
    if (!this.client?.usable) throw new Error(`mailbox ${this.mailbox.id} is not connected`);
    return this.client satisfies ImapFlow;
  }

  private inbox() {
    return this.folders.find((f) => f.role === "inbox") satisfies FolderInfo | undefined;
  }

  private async discoverFolders() {
    this.folders = await listFolders(this.requireClient(), this.capabilities?.gmail === true);
    await this.store.saveFolders(this.mailbox.id, this.folders);
  }

  private async ensureFolder(role: FolderRole, path: string) {
    const existing = this.folders.find((f) => f.role === role);
    if (existing) return existing satisfies FolderInfo;
    await this.requireClient().mailboxCreate(path);
    await this.discoverFolders();
    return (this.folders.find((f) => f.path === path) ?? { path, role }) satisfies FolderInfo;
  }

  private async syncFolderNow(path: string) {
    return (await syncFolder(
      {
        client: this.requireClient(),
        mailbox: this.mailbox,
        store: this.store,
        log: this.log,
        condstore: this.capabilities?.condstore === true,
        gmail: this.capabilities?.gmail === true,
        role: this.folders.find((f) => f.path === path)?.role ?? "other",
        limits: this.limits,
        isStopped: () => this.stopped,
        onMessage: (event) => this.emit("message", event),
      },
      path,
    )) satisfies FolderSyncResult;
  }
}
