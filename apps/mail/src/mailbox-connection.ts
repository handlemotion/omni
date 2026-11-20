import { EventEmitter } from "node:events";
import { Data, Deferred, Duration, Effect, Fiber, Schedule, Semaphore } from "effect";
import { type FetchMessageObject, ImapFlow, type ListResponse, type MailboxObject } from "imapflow";
import { type FolderSyncPlan, planFolderSync } from "@omni/mail-core/folder-sync";
import type { Logger } from "./log.ts";
import { imapTls } from "./mail-hosts.ts";
import type {
  FetchedMessage,
  FlagChange,
  FolderInfo,
  FolderRole,
  MailStore,
  SyncPosition,
} from "./ports.ts";
import { discard, isSpooled, spool } from "./spool.ts";
import { backoff } from "./timing.ts";

const FILED_ROLES = new Set<FolderRole>(["archive", "trash", "junk"]);

export interface ServerEndpoint {
  host: string;
  port: number;
  /** Implicit TLS (993 / 465). False means plain, and the connection must upgrade with STARTTLS. */
  secure: boolean;
  /**
   * A `secure: false` endpoint may stay cleartext when STARTTLS isn't offered. Never stored: the
   * service decides it on load from `MAIL_ALLOW_PLAINTEXT_HOSTS` (see `withPlaintextPolicy`).
   */
  allowPlaintext?: boolean;
}

/** Mints OAuth2 access tokens for one mailbox (XOAUTH2). */
export interface TokenSource {
  /** A token valid for at least the next few minutes. */
  get(): Promise<string>;
  /** The server refused the last token: the next `get` mints a new one. */
  invalidate(): void;
  /** `get` failed because the grant is gone: retrying cannot help, the person must reconnect. */
  isRevoked(error: unknown): boolean;
}

/** How a mailbox logs in to IMAP and SMTP. */
export type MailAuth = { kind: "password"; pass: string } | { kind: "oauth2"; token: TokenSource };

/** A mailbox with its decrypted login. Lives only inside the mail service. */
export interface MailboxConfig {
  id: string;
  orgId: string;
  address: string;
  /** Shared mailboxes keep read state per person in Postgres; we never touch their `\Seen`. */
  kind: "personal" | "shared";
  /** `gmail` for a Google account, where Gmail's read is Omni's Done. */
  provider?: string;
  /**
   * Index only mail from this date on. Each folder syncs from its oldest message dated
   * on or after it; everything older stays on the server. Unset: every message.
   */
  syncSince?: Date;
  user: string;
  auth: MailAuth;
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
}

/** ImapFlow's and Nodemailer's `auth` for this mailbox, with a fresh token for OAuth2. */
export const loginFor: (
  mailbox: Pick<MailboxConfig, "user" | "auth">,
) => Promise<{ user: string; pass: string } | { user: string; accessToken: string }> = async (
  mailbox,
) => {
  return mailbox.auth.kind === "password"
    ? { user: mailbox.user, pass: mailbox.auth.pass }
    : { user: mailbox.user, accessToken: await mailbox.auth.token.get() };
};

export interface Capabilities {
  idle: boolean;
  condstore: boolean;
  uidplus: boolean;
  move: boolean;
  /** Gmail (`X-GM-EXT-1`): system folders only, All Mail is the archive, X-GM-THRID threads. */
  gmail: boolean;
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
  folders(): FolderInfo[];
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
  /**
   * A message larger than this is streamed to a temp file and parsed from there, never held in
   * memory: parsing costs several times a message's size, and the VM is small.
   */
  streamAboveBytes?: number;
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

class StoppedError extends Error {
  override name = "StoppedError";
}

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
  private readonly streamAboveBytes: number;
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
    this.batchSize = options.batchSize ?? 50;
    this.batchBytes = options.batchBytes ?? 16 * 1024 * 1024;
    this.streamAboveBytes = options.streamAboveBytes ?? 4 * 1024 * 1024;
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
    const listed = await this.requireClient().list();
    const gmail = this.capabilities?.gmail === true;
    const taken = new Set<FolderRole>();
    this.folders = listed
      .filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"))
      .map((f) => {
        let role = roleOf(f, gmail);
        if (role !== "other" && taken.has(role)) role = "other";
        taken.add(role);
        return { path: f.path, role };
      })
      .filter((f) => !gmail || f.role !== "other");
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
    const client = this.requireClient();
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
      const position = await this.startPosition(path, box, result);
      const serverModseq =
        this.capabilities?.condstore && !box.noModseq ? (box.highestModseq ?? null) : null;
      const index = await this.store.folderIndex(this.mailbox.id, path);
      const plan = planFolderSync(
        position,
        { uidNext: box.uidNext, exists: box.exists, highestModseq: serverModseq },
        index.size,
      );
      result.mode = plan.mode;
      if (plan.mode === "unchanged") return result satisfies FolderSyncResult;

      const serverUids = await this.listServerUids(client, box, plan, index);
      const added = await this.applyServerChanges(client, path, box, plan, index, serverUids);
      result.removed = added.removed;
      result.flagsChanged = added.flagsChanged;
      await this.importMessages(client, path, added.uids, result);

      await this.store.saveSyncPosition(this.mailbox.id, path, {
        uidValidity: box.uidValidity,
        highestModseq: serverModseq,
        uidNext: result.failed > 0 ? position.uidNext : box.uidNext,
      });
      if (result.added || result.removed || result.flagsChanged || result.reset || result.failed) {
        this.log.info("sync.folder", { ...result });
      }
      return result satisfies FolderSyncResult;
    } finally {
      lock.release();
    }
  }

  private async startPosition(path: string, box: MailboxObject, result: FolderSyncResult) {
    const mailboxId = this.mailbox.id;
    const stored = await this.store.getSyncPosition(mailboxId, path);
    if (stored && stored.uidValidity === box.uidValidity) return stored satisfies SyncPosition;
    if (stored) {
      this.log.warn("sync.uidvalidity_changed", {
        folder: path,
        was: stored.uidValidity,
        now: box.uidValidity,
      });
      await this.store.resetFolder(mailboxId, path);
      result.reset = true;
    }
    const position = { uidValidity: box.uidValidity, highestModseq: null, uidNext: 0 };
    await this.store.saveSyncPosition(mailboxId, path, position);
    return position satisfies SyncPosition;
  }

  private async listServerUids(
    client: ImapFlow,
    box: MailboxObject,
    plan: ChangedPlan,
    index: Map<number, string[]>,
  ) {
    if (!plan.listUids) return [...index.keys()] satisfies number[];
    if (box.exists === 0) return [] satisfies number[];
    const since = this.mailbox.syncSince;
    if (!since)
      return ((await client.search({ all: true }, { uid: true })) || []) satisfies number[];
    const recent = (await client.search({ since }, { uid: true })) || [];
    const floor = recent.reduce((low, uid) => Math.min(low, uid), box.uidNext);
    const from = lowestUid(index, floor);
    const listed = (await client.search({ uid: `${from}:*` }, { uid: true })) || [];
    return listed.filter((uid) => uid >= floor || index.has(uid)) satisfies number[];
  }

  private async applyServerChanges(
    client: ImapFlow,
    path: string,
    box: MailboxObject,
    plan: ChangedPlan,
    index: Map<number, string[]>,
    serverUids: number[],
  ) {
    const mailboxId = this.mailbox.id;
    const onServer = new Set(serverUids);
    const removed = [...index.keys()].filter((uid) => !onServer.has(uid));
    const flagChanges =
      box.exists > 0 && index.size > 0
        ? await this.changedFlags(client, index, plan.changedSince)
        : [];
    if (removed.length > 0) await this.store.removeMessages(mailboxId, path, removed);
    if (flagChanges.length > 0) await this.store.applyFlags(mailboxId, path, flagChanges);
    return {
      removed: removed.length,
      flagsChanged: flagChanges.length,
      uids: serverUids.filter((uid) => !index.has(uid)).toSorted((a, b) => b - a),
    };
  }

  private async changedFlags(
    client: ImapFlow,
    index: Map<number, string[]>,
    changedSince: bigint | undefined,
  ) {
    const changes: FlagChange[] = [];
    for await (const msg of client.fetch(
      `${lowestUid(index, 1)}:*`,
      { uid: true, flags: true },
      { uid: true, changedSince },
    )) {
      const known = index.get(msg.uid);
      const flags = sortedFlags(msg.flags);
      if (known && !sameFlags(known, flags)) {
        changes.push({ uid: msg.uid, flags, modseq: msg.modseq ?? null });
      }
    }
    return changes satisfies FlagChange[];
  }

  private async importMessages(
    client: ImapFlow,
    path: string,
    uids: number[],
    result: FolderSyncResult,
  ) {
    const store = this.messageStorer(path, result);
    for await (const { uids: batch, large } of this.sizedBatches(client, uids)) {
      this.throwIfStopped();
      if (large) await this.importLarge(client, path, batch[0] ?? 0, store);
      else await this.importBatch(client, path, batch, store);
      this.throwIfStopped();
    }
  }

  private messageStorer(path: string, result: FolderSyncResult) {
    const mailboxId = this.mailbox.id;
    const role = this.folders.find((f) => f.path === path)?.role ?? "other";
    let consecutiveFailures = 0;
    return async (fetched: FetchedMessage) => {
      try {
        const { created } = await this.store.storeMessage(mailboxId, fetched);
        consecutiveFailures = 0;
        if (!created) return;
        result.added++;
        this.emit("message", { mailboxId, folder: path, role, uid: fetched.uid });
      } catch (error) {
        result.failed++;
        consecutiveFailures++;
        this.log.warn("sync.message_failed", { folder: path, uid: fetched.uid, error });
        if (consecutiveFailures >= MAX_CONSECUTIVE_STORE_FAILURES) throw error;
      }
    };
  }

  private async importLarge(
    client: ImapFlow,
    path: string,
    uid: number,
    store: (fetched: FetchedMessage) => Promise<void>,
  ) {
    const fetched = await this.fetchLarge(client, path, uid);
    if (!fetched) return;
    try {
      await store(fetched);
    } finally {
      if (isSpooled(fetched.raw)) await discard(fetched.raw.path);
    }
  }

  private async importBatch(
    client: ImapFlow,
    path: string,
    batch: number[],
    store: (fetched: FetchedMessage) => Promise<void>,
  ) {
    const query = {
      uid: true,
      flags: true,
      source: true,
      internalDate: true,
      ...(this.capabilities?.gmail ? { threadId: true } : {}),
    };
    for await (const msg of client.fetch(batch.join(","), query, { uid: true })) {
      if (this.stopped || !msg.source) continue;
      await store({ ...fetchedFields(path, msg), raw: msg.source });
    }
  }

  private throwIfStopped() {
    if (this.stopped) throw new StoppedError(`mailbox ${this.mailbox.id} is stopping`);
  }

  private async *sizedBatches(client: ImapFlow, uids: number[]) {
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
        if (!sizes.has(uid)) continue;
        const size = sizes.get(uid) ?? 0;
        if (size > this.streamAboveBytes) {
          yield { uids: [uid], large: true };
          continue;
        }
        if (
          batch.length > 0 &&
          (batch.length >= this.batchSize || bytes + size > this.batchBytes)
        ) {
          yield { uids: batch, large: false };
          batch = [];
          bytes = 0;
        }
        batch.push(uid);
        bytes += size;
      }
    }
    if (batch.length > 0) yield { uids: batch, large: false };
  }

  private async fetchLarge(client: ImapFlow, path: string, uid: number) {
    const msg = await client.fetchOne(
      String(uid),
      {
        uid: true,
        flags: true,
        internalDate: true,
        ...(this.capabilities?.gmail ? { threadId: true } : {}),
      },
      { uid: true },
    );
    if (!msg) {
      const result: FetchedMessage | null = null;
      return result;
    }
    const download = await client.download(String(uid), undefined, {
      uid: true,
      chunkSize: 1024 * 1024,
    });
    if (!download.content) {
      const result: FetchedMessage | null = null;
      return result;
    }
    const result: FetchedMessage | null = {
      ...fetchedFields(path, msg),
      raw: await spool(download.content),
    };
    return result;
  }
}

function detectCapabilities(client: ImapFlow) {
  const has = (name: string) => client.capabilities.has(name);
  return {
    idle: has("IDLE"),
    condstore: client.enabled.has("CONDSTORE") || has("CONDSTORE"),
    uidplus: has("UIDPLUS"),
    move: has("MOVE"),
    gmail: has("X-GM-EXT-1"),
    all: [...client.capabilities.keys()].toSorted(),
  } satisfies Capabilities;
}

const roleOf: (folder: ListResponse, gmail: boolean) => FolderRole = (folder, gmail) => {
  if (folder.path.toUpperCase() === "INBOX") return "inbox";
  if (gmail && folder.specialUse === "\\All") return "archive";
  return (folder.specialUse && ROLE_BY_SPECIAL_USE[folder.specialUse]) || "other";
};

function fetchedFields(path: string, msg: FetchMessageObject) {
  return {
    folder: path,
    uid: msg.uid,
    flags: sortedFlags(msg.flags),
    modseq: msg.modseq ?? null,
    internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
    ...(msg.threadId ? { providerThreadId: msg.threadId } : {}),
  } satisfies Omit<FetchedMessage, "raw">;
}

function lowestUid(index: Map<number, string[]>, fallback: number) {
  let lowest = fallback;
  for (const uid of index.keys()) lowest = Math.min(lowest, uid);
  return lowest;
}

function sortedFlags(flags: Set<string> | undefined) {
  return (flags ? [...flags].toSorted() : []) satisfies string[];
}

function sameFlags(a: string[], b: string[]) {
  return a.length === b.length && a.every((flag, i) => flag === b[i]);
}

type ChangedPlan = Exclude<FolderSyncPlan, { mode: "unchanged" }>;
