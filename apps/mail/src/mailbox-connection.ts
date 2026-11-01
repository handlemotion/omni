import { EventEmitter } from "node:events";
import { ImapFlow, type ListResponse } from "imapflow";
import type { Logger } from "./log.ts";
import type { FlagChange, FolderInfo, FolderRole, MailStore, SyncPosition } from "./ports.ts";
import { backoffDelay } from "./timing.ts";

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
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Bounds work shared across mailboxes; each connect attempt (with its initial sync) runs inside it. */
  gate?: <T>(task: () => Promise<T>) => Promise<T>;
}

type Events = {
  message: [NewMessageEvent];
  connected: [Capabilities];
  disconnected: [];
};

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
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly gate: <T>(task: () => Promise<T>) => Promise<T>;

  private client: ImapFlow | null = null;
  private capabilities: Capabilities | null = null;
  private folders: FolderInfo[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = true;
  private connecting: Promise<void> | null = null;
  private wakeSleeper: (() => void) | null = null;
  private inboxSyncQueued = false;

  constructor(mailbox: MailboxConfig, options: ConnectionOptions) {
    super();
    this.mailbox = mailbox;
    this.store = options.store;
    this.log = options.logger.child({ mailboxId: mailbox.id });
    this.batchSize = options.batchSize ?? 50;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5 * 60_000;
    this.gate = options.gate ?? ((task) => task());
  }

  get connected(): boolean {
    return this.client?.usable === true;
  }

  /** Connects (retrying with backoff until it works or `stop()` is called) and syncs every folder. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.reconnect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeSleeper?.();
    await this.connecting?.catch(() => {});
    await this.queue.catch(() => {});
    const client = this.client;
    this.client = null;
    if (client?.usable) await client.logout().catch(() => client.close());
    else client?.close();
  }

  /** Re-discovers folders and syncs all of them, INBOX last so IDLE resumes there. */
  syncAll(): Promise<FolderSyncResult[]> {
    return this.enqueue(async () => {
      await this.discoverFolders();
      const results: FolderSyncResult[] = [];
      const inbox = this.inbox();
      for (const folder of this.folders) {
        if (folder !== inbox) results.push(await this.syncFolderNow(folder.path));
      }
      if (inbox) results.push(await this.syncFolderNow(inbox.path));
      return results;
    });
  }

  syncFolder(path: string): Promise<FolderSyncResult> {
    return this.enqueue(() => this.syncFolderNow(path));
  }

  /** Runs `task` with exclusive use of the connection. Fails fast while disconnected. */
  run<T>(task: (session: ImapSession) => Promise<T>): Promise<T> {
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

  private reconnect(): Promise<void> {
    this.connecting ??= this.connectWithRetry().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectWithRetry(): Promise<void> {
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        await this.gate(() => this.connect());
        return;
      } catch (error) {
        const retryInMs = Math.round(
          backoffDelay(attempt, this.reconnectBaseMs, this.reconnectMaxMs),
        );
        this.log.warn("imap.connect_failed", { error, attempt, retryInMs });
        await this.sleep(retryInMs);
      }
    }
  }

  private async connect(): Promise<void> {
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
    });
    client.on("error", (error: Error) => this.log.warn("imap.error", { error }));
    client.on("close", () => this.onClose(client));
    client.on("exists", (event: { path: string }) => {
      if (event.path === this.inbox()?.path) this.requestInboxSync();
    });

    await client.connect();
    this.client = client;
    try {
      this.capabilities = detectCapabilities(client);
      this.log.info("imap.capabilities", { ...this.capabilities });
      await this.syncAll();
    } catch (error) {
      this.client = null;
      client.close();
      throw error;
    }
    this.emit("connected", this.capabilities);
    this.log.info("imap.connected");
  }

  private onClose(client: ImapFlow): void {
    if (client !== this.client) return; // a client we already replaced or shut down
    this.client = null;
    this.emit("disconnected");
    if (this.stopped) return;
    this.log.warn("imap.disconnected");
    void this.reconnect();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeSleeper = done;
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
    }).catch((error: unknown) => this.log.warn("sync.inbox_failed", { error }));
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
    const lock = await client.getMailboxLock(path);
    try {
      if (client.mailbox === false) throw new Error(`could not select ${path}`);
      const box = client.mailbox;
      const result: FolderSyncResult = {
        folder: path,
        added: 0,
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

      for (let i = 0; i < added.length; i += this.batchSize) {
        const batch = added.slice(i, i + this.batchSize);
        for await (const msg of client.fetch(
          batch.join(","),
          { uid: true, flags: true, source: true, internalDate: true },
          { uid: true },
        )) {
          if (!msg.source) continue;
          const { created } = await this.store.storeMessage(mailboxId, {
            folder: path,
            uid: msg.uid,
            raw: msg.source,
            flags: sortedFlags(msg.flags),
            modseq: msg.modseq ?? null,
            internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
          });
          if (created) {
            result.added++;
            this.emit("message", { mailboxId, folder: path, role, uid: msg.uid });
          }
        }
      }

      const next: SyncPosition = {
        uidValidity: box.uidValidity,
        highestModseq: serverModseq,
        uidNext: box.uidNext,
      };
      await this.store.saveSyncPosition(mailboxId, path, next);
      if (result.added || result.removed || result.flagsChanged || result.reset) {
        this.log.info("sync.folder", { ...result });
      }
      return result;
    } finally {
      lock.release();
    }
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
