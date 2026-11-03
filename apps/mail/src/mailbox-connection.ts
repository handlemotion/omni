import { EventEmitter } from "node:events";
import { Data, Deferred, Duration, Effect, Fiber, Schedule, Semaphore } from "effect";
import { ImapFlow, type ListResponse } from "imapflow";
import type { Logger } from "./log.ts";
import type { FlagChange, FolderInfo, FolderRole, MailStore, SyncPosition } from "./ports.ts";
import { backoff } from "./timing.ts";

export interface ServerEndpoint {
  host: string;
  port: number;
  /** Implicit TLS (993 / 465). False means plain, upgraded with STARTTLS when offered. */
  secure: boolean;
}

/** A mailbox with its decrypted app password. Lives only inside the mail service. */
export interface MailboxConfig {
  id: string;
  orgId: string;
  address: string;
  /** Shared mailboxes keep read state per person in Postgres; we never touch their `\Seen`. */
  kind: "personal" | "shared";
  user: string;
  pass: string;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
}

export interface Capabilities {
  idle: boolean;
  condstore: boolean;
  uidplus: boolean;
  move: boolean;
  /** Every capability the server advertised, logged on connect to show what a host supports. */
  all: string[];
}

export interface NewMessageEvent {
  mailboxId: string;
  folder: string;
  role: FolderRole;
  uid: number;
}

export interface FolderSyncResult {
  folder: string;
  added: number;
  /** New messages that could not be stored this time; the next sync retries them. */
  failed: number;
  removed: number;
  flagsChanged: number;
  reset: boolean;
  mode: "condstore" | "uid-diff" | "unchanged";
}

/** What an outbox action gets while it holds the connection. */
export interface ImapSession {
  client: ImapFlow;
  capabilities: Capabilities;
  folder(role: FolderRole): FolderInfo | undefined;
  /** The folder for `role`, created at `path` when the server has none. */
  ensureFolder(role: FolderRole, path: string): Promise<FolderInfo>;
  syncFolder(path: string): Promise<FolderSyncResult>;
}

export interface ConnectionOptions {
  store: MailStore;
  logger: Logger;
  /** Messages fetched per round trip during import and catch-up. */
  batchSize?: number;
  /** A fetch batch also stops at this many bytes, so big messages come one at a time. */
  batchBytes?: number;
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
  /** Logged in and the first full sync finished: outbox actions run from here on. */
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

/** A ready connection closed before it counted as stable (`stableAfterMs`). Retried with backoff. */
class ImapDropped extends Data.TaggedError("ImapDropped")<{}> {}

type SessionError = ImapAuthFailed | ImapConnectFailed | ImapDropped;

/** The mailbox is offline or still on its first sync. Retry later; the action is not at fault. */
export class MailboxUnavailableError extends Error {
  override name = "MailboxUnavailableError";
}

/** `stop()` was called while a sync was running. Nothing past the last stored message is lost. */
class StoppedError extends Error {
  override name = "StoppedError";
}

/** Consecutive messages that fail to store before a folder sync gives up (storage is likely down). */
const MAX_CONSECUTIVE_STORE_FAILURES = 5;

const ROLE_BY_SPECIAL_USE: Record<string, FolderRole> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Archive": "archive",
  "\\Trash": "trash",
  "\\Drafts": "drafts",
  "\\Junk": "junk",
};

/**
 * One IMAP connection for one mailbox. It IDLEs on INBOX, syncs folders on request, and runs
 * outbox actions. Every IMAP command goes through one queue, so a sync and an action never
 * interleave on the wire, and the connection always returns to INBOX to keep IDLE there.
 */
export class MailboxConnection extends EventEmitter<Events> {
  readonly mailbox: MailboxConfig;
  private readonly store: MailStore;
  private readonly log: Logger;
  private readonly batchSize: number;
  private readonly batchBytes: number;
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
  /** Runs `lifecycle()`: connect, serve, reconnect. Interrupting it closes the socket. */
  private fiber: Fiber.Fiber<void> | null = null;
  /** Settles `start()`: on the first ready connection, a give-up, or `stop()`. */
  private started: PromiseWithResolvers<void> | null = null;
  private syncingAll: Promise<FolderSyncResult[]> | null = null;
  private inboxSyncQueued = false;

  constructor(mailbox: MailboxConfig, options: ConnectionOptions) {
    super();
    this.mailbox = mailbox;
    this.store = options.store;
    this.log = options.logger.child({ mailboxId: mailbox.id });
    this.batchSize = options.batchSize ?? 50;
    this.batchBytes = options.batchBytes ?? 16 * 1024 * 1024;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5 * 60_000;
    this.stableAfterMs = options.stableAfterMs ?? 60_000;
    this.socketTimeoutMs = options.socketTimeoutMs ?? 90_000;
    this.gate = options.gate ?? Semaphore.makeUnsafe(1);
    this.maxAuthFailures = options.maxAuthFailures ?? 3;
  }

  get connected(): boolean {
    return this.client?.usable === true;
  }

  /** Connected and past the first full sync. */
  get isReady(): boolean {
    return this.ready && this.connected;
  }

  /**
   * Connects and syncs every folder, retrying with backoff until that works, `stop()` is called, or
   * the server rejects the login `maxAuthFailures` times. A dropped connection reconnects the same
   * way for as long as the connection runs.
   */
  start(): Promise<void> {
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
  async stop(): Promise<void> {
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
   */
  syncAll(): Promise<FolderSyncResult[]> {
    this.syncingAll ??= this.enqueue(async () => {
      try {
        await this.discoverFolders();
        const results: FolderSyncResult[] = [];
        const inbox = this.inbox();
        const ordered = [...this.folders.filter((f) => f !== inbox), ...(inbox ? [inbox] : [])];
        for (const folder of ordered) {
          try {
            results.push(await this.syncFolderNow(folder.path));
          } catch (error) {
            // The connection itself is gone: the reconnect resyncs everything.
            if (error instanceof StoppedError || !this.connected) throw error;
            this.log.warn("sync.folder_failed", { folder: folder.path, error });
          }
        }
        return results;
      } finally {
        this.syncingAll = null;
      }
    });
    return this.syncingAll;
  }

  syncFolder(path: string): Promise<FolderSyncResult> {
    return this.enqueue(() => this.syncFolderNow(path));
  }

  /**
   * Runs `task` with exclusive use of the connection. Fails fast with `MailboxUnavailableError`
   * while disconnected or still on the first sync, so an outbox action never waits behind a
   * long import (holding an outbox slot other mailboxes need).
   */
  run<T>(task: (session: ImapSession) => Promise<T>): Promise<T> {
    if (!this.isReady) {
      return Promise.reject(new MailboxUnavailableError(`mailbox ${this.mailbox.id} is not ready`));
    }
    return this.enqueue(() => {
      const client = this.requireClient();
      return task({
        client,
        capabilities: this.capabilities as Capabilities,
        folder: (role) => this.folders.find((f) => f.role === role),
        ensureFolder: (role, path) => this.ensureFolder(role, path),
        syncFolder: (path) => this.syncFolderNow(path),
      });
    });
  }

  /**
   * Connection sessions, forever. A session that fails (or drops before it was stable) is retried
   * on a jittered, capped exponential backoff; a stable one that drops reconnects at once with the
   * backoff reset. Rejected logins wait the longest delay, and after `maxAuthFailures` in a row the
   * loop stops. Defects (bugs in the sync code) are retried like failures: one mailbox's bug must
   * not end its loop or reach the process.
   */
  private lifecycle(): Effect.Effect<void> {
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
      // Wrong credentials will not fix themselves in a second: wait the longest.
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
    );
  }

  /**
   * One connection, from socket to close. The client is a scoped resource: however the session
   * ends (dropped, failed, interrupted by `stop()`), its finalizer logs out if it can and closes
   * the socket, so no attempt leaves a connection behind against the server's connection cap.
   */
  private session(): Effect.Effect<void, SessionError> {
    return Effect.gen({ self: this }, function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => this.createClient()),
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

      yield* Deferred.await(closed);
      if (this.client === client) this.client = null;
      this.ready = false;
      this.emit("disconnected");
      // A drop right after a connect counts as a failed attempt, so a server that accepts the
      // login and then hangs up is not hammered.
      if (Date.now() - this.readySince < this.stableAfterMs) return yield* new ImapDropped();
      this.log.warn("imap.disconnected", { wasReady: true, failures: 0 });
    }).pipe(Effect.scoped);
  }

  private createClient(): ImapFlow {
    const { imap, user, pass } = this.mailbox;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user, pass },
      logger: false,
      clientInfo: { name: "omni" },
      // Start IDLE soon after our own commands finish, and restart it before NATs drop it.
      autoIdleDelay: 1_000,
      maxIdleTime: 4 * 60_000,
      socketTimeout: this.socketTimeoutMs,
      greetingTimeout: 30_000,
      connectionTimeout: 60_000,
    });
    client.on("error", (error: Error) => this.log.warn("imap.error", { error }));
    client.on("exists", (event: { path: string }) => {
      if (event.path === this.inbox()?.path) this.requestInboxSync();
    });
    return client;
  }

  /** Logs in and runs the first full sync. Throws when either fails or the socket closes. */
  private async connect(client: ImapFlow): Promise<void> {
    try {
      await client.connect();
      this.client = client;
      this.capabilities = detectCapabilities(client);
      this.log.info("imap.capabilities", { ...this.capabilities });
      await this.syncAll();
      if (!client.usable) throw new Error("connection closed during the first sync");
    } catch (error) {
      if (this.client === client) this.client = null;
      throw error;
    }
  }

  /** Finalizer: LOGOUT when the connection still works (a silent server gets 5s), then close. */
  private release(client: ImapFlow): Effect.Effect<void> {
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
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      try {
        return await task();
      } finally {
        await this.returnToInbox();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Leaving INBOX moves IDLE elsewhere, so mail may have arrived unseen: go back and catch up. */
  private async returnToInbox(): Promise<void> {
    const client = this.client;
    const inbox = this.inbox();
    if (!client?.usable || !inbox || client.mailbox === false) return;
    if (client.mailbox.path === inbox.path) return;
    await client.mailboxOpen(inbox.path).catch(() => {});
    this.requestInboxSync();
  }

  private requestInboxSync(): void {
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

  private requireClient(): ImapFlow {
    if (!this.client?.usable) throw new Error(`mailbox ${this.mailbox.id} is not connected`);
    return this.client;
  }

  private inbox(): FolderInfo | undefined {
    return this.folders.find((f) => f.role === "inbox");
  }

  private async discoverFolders(): Promise<void> {
    const listed = await this.requireClient().list();
    const taken = new Set<FolderRole>();
    this.folders = listed
      .filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"))
      .map((f) => {
        // One folder per role; a second "Sent Messages" next to "Sent" is just another folder.
        let role = roleOf(f);
        if (role !== "other" && taken.has(role)) role = "other";
        taken.add(role);
        return { path: f.path, role };
      });
    await this.store.saveFolders(this.mailbox.id, this.folders);
  }

  private async ensureFolder(role: FolderRole, path: string): Promise<FolderInfo> {
    const existing = this.folders.find((f) => f.role === role);
    if (existing) return existing;
    await this.requireClient().mailboxCreate(path);
    await this.discoverFolders();
    return this.folders.find((f) => f.path === path) ?? { path, role };
  }

  /**
   * Brings one folder's stored state in line with the server. New messages are fetched newest
   * first in batches, so the first import shows recent mail early and a crash mid-import resumes
   * from what is already stored. Must run inside the queue.
   */
  private async syncFolderNow(path: string): Promise<FolderSyncResult> {
    const client = this.requireClient();
    const mailboxId = this.mailbox.id;
    const role = this.folders.find((f) => f.path === path)?.role ?? "other";
    this.throwIfStopped();
    const lock = await client.getMailboxLock(path);
    try {
      if (client.mailbox === false) throw new Error(`could not select ${path}`);
      const box = client.mailbox;
      const result: FolderSyncResult = {
        folder: path,
        added: 0,
        failed: 0,
        removed: 0,
        flagsChanged: 0,
        reset: false,
        mode: "uid-diff",
      };

      let position = await this.store.getSyncPosition(mailboxId, path);
      if (position && position.uidValidity !== box.uidValidity) {
        this.log.warn("sync.uidvalidity_changed", {
          folder: path,
          was: position.uidValidity,
          now: box.uidValidity,
        });
        await this.store.resetFolder(mailboxId, path);
        position = null;
        result.reset = true;
      }
      if (!position) {
        // Record UIDVALIDITY before importing, so a crash mid-import still detects a reset later.
        position = { uidValidity: box.uidValidity, highestModseq: null, uidNext: 0 };
        await this.store.saveSyncPosition(mailboxId, path, position);
      }

      const serverModseq =
        this.capabilities?.condstore && !box.noModseq ? (box.highestModseq ?? null) : null;
      const index = await this.store.folderIndex(mailboxId, path);
      const useCondstore = serverModseq !== null && position.highestModseq !== null;
      if (useCondstore) result.mode = "condstore";

      if (
        useCondstore &&
        serverModseq === position.highestModseq &&
        box.uidNext === position.uidNext &&
        box.exists === index.size
      ) {
        result.mode = "unchanged";
        return result;
      }

      // The UID list is cheap and is the only way to see expunges without QRESYNC.
      const serverUids =
        box.exists === 0 ? [] : (await client.search({ all: true }, { uid: true })) || [];
      const onServer = new Set(serverUids);
      const removed = [...index.keys()].filter((uid) => !onServer.has(uid));
      const added = serverUids.filter((uid) => !index.has(uid)).toSorted((a, b) => b - a);

      const flagChanges: FlagChange[] = [];
      if (box.exists > 0 && index.size > 0) {
        const changedSince = useCondstore ? (position.highestModseq as bigint) : undefined;
        for await (const msg of client.fetch(
          "1:*",
          { uid: true, flags: true },
          { uid: true, changedSince },
        )) {
          const known = index.get(msg.uid);
          const flags = sortedFlags(msg.flags);
          if (known && !sameFlags(known, flags)) {
            flagChanges.push({ uid: msg.uid, flags, modseq: msg.modseq ?? null });
          }
        }
      }

      if (removed.length > 0) await this.store.removeMessages(mailboxId, path, removed);
      if (flagChanges.length > 0) await this.store.applyFlags(mailboxId, path, flagChanges);
      result.removed = removed.length;
      result.flagsChanged = flagChanges.length;

      let consecutiveFailures = 0;
      for await (const batch of this.sizedBatches(client, added)) {
        this.throwIfStopped();
        for await (const msg of client.fetch(
          batch.join(","),
          { uid: true, flags: true, source: true, internalDate: true },
          { uid: true },
        )) {
          // Finish the message in hand, then stop; the rest of the batch is fetched next start.
          if (this.stopped) continue;
          if (!msg.source) continue;
          try {
            const { created } = await this.store.storeMessage(mailboxId, {
              folder: path,
              uid: msg.uid,
              raw: msg.source,
              flags: sortedFlags(msg.flags),
              modseq: msg.modseq ?? null,
              internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
            });
            consecutiveFailures = 0;
            if (created) {
              result.added++;
              this.emit("message", { mailboxId, folder: path, role, uid: msg.uid });
            }
          } catch (error) {
            // One unparseable or unstorable message must not block the folder. It stays out of the
            // index, so the next sync's UID diff retries it. A run of failures means storage is
            // down: give up on the folder rather than walking the whole mailbox.
            result.failed++;
            consecutiveFailures++;
            this.log.warn("sync.message_failed", { folder: path, uid: msg.uid, error });
            if (consecutiveFailures >= MAX_CONSECUTIVE_STORE_FAILURES) throw error;
          }
        }
        this.throwIfStopped();
      }

      const next: SyncPosition = {
        uidValidity: box.uidValidity,
        highestModseq: serverModseq,
        uidNext: box.uidNext,
      };
      await this.store.saveSyncPosition(mailboxId, path, next);
      if (result.added || result.removed || result.flagsChanged || result.reset || result.failed) {
        this.log.info("sync.folder", { ...result });
      }
      return result;
    } finally {
      lock.release();
    }
  }

  private throwIfStopped(): void {
    if (this.stopped) throw new StoppedError(`mailbox ${this.mailbox.id} is stopping`);
  }

  /**
   * Splits `uids` (newest first) into fetch batches of at most `batchSize` messages and
   * `batchBytes` bytes, so memory stays bounded however big the mail is: a message larger than
   * the byte budget is fetched on its own. Sizes come from one cheap RFC822.SIZE fetch per chunk.
   */
  private async *sizedBatches(client: ImapFlow, uids: number[]): AsyncGenerator<number[]> {
    const SIZE_CHUNK = 500;
    let batch: number[] = [];
    let bytes = 0;
    for (let i = 0; i < uids.length; i += SIZE_CHUNK) {
      const chunk = uids.slice(i, i + SIZE_CHUNK);
      const sizes = new Map<number, number>();
      for await (const msg of client.fetch(
        chunk.join(","),
        { uid: true, size: true },
        { uid: true },
      )) {
        sizes.set(msg.uid, msg.size ?? 0);
      }
      for (const uid of chunk) {
        // Expunged since the UID search: nothing to fetch.
        if (!sizes.has(uid)) continue;
        const size = sizes.get(uid) ?? 0;
        if (
          batch.length > 0 &&
          (batch.length >= this.batchSize || bytes + size > this.batchBytes)
        ) {
          yield batch;
          batch = [];
          bytes = 0;
        }
        batch.push(uid);
        bytes += size;
      }
    }
    if (batch.length > 0) yield batch;
  }
}

function detectCapabilities(client: ImapFlow): Capabilities {
  const has = (name: string) => client.capabilities.has(name);
  return {
    idle: has("IDLE"),
    condstore: client.enabled.has("CONDSTORE") || has("CONDSTORE"),
    uidplus: has("UIDPLUS"),
    move: has("MOVE"),
    all: [...client.capabilities.keys()].toSorted(),
  };
}

function roleOf(folder: ListResponse): FolderRole {
  if (folder.path.toUpperCase() === "INBOX") return "inbox";
  return (folder.specialUse && ROLE_BY_SPECIAL_USE[folder.specialUse]) || "other";
}

function sortedFlags(flags: Set<string> | undefined): string[] {
  return flags ? [...flags].toSorted() : [];
}

function sameFlags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((flag, i) => flag === b[i]);
}
