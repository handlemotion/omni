// `MailStore` and `ActionSource` on Postgres through `@omni/db`. The store turns each fetched
// message into the index: raw bytes, sanitized HTML and attachments to the object store, then
// parse, thread, clean, upsert. A message is one row per Message-ID in
// its mailbox; each IMAP copy of it is a location, so re-syncs, moves, UIDVALIDITY resets and
// restarts converge on the same rows.
import { actionPayloadSchemas } from "@omni/contracts";
import {
  addLocation,
  claimActions,
  completeAction,
  claimProviderThread,
  createThread,
  deferAction,
  sendingPaused,
  type Db,
  findFolder,
  findMailbox,
  findMessageByHeader,
  findThreadByProviderId,
  folderLocations,
  getFolderPosition,
  hasLocation,
  markActionSmtpAccepted,
  messageThread,
  moveMessageToThread,
  nextActionDue,
  sendAttachmentFiles,
  orphanedMessages,
  pruneMessages,
  removeLocations,
  replaceFolders,
  rescheduleAction,
  resetFolder,
  saveFolderPosition,
  schema,
  setLocationFlags,
  subjectThreadCandidates,
  threadReferencing,
  threadsReplyingTo,
  mergeThreads,
  threadsByMessageIds,
  upsertMessage,
  type MergedThreads,
} from "@omni/db";
import { decideThread, normalizeSubject, type ParsedMessage, parseMessage } from "@omni/mail-core";
import { cleanMessage, sanitizeHtml } from "@omni/mail-core/clean";
import { createHash } from "node:crypto";
import type { ObjectStore } from "./objects.ts";
import type {
  ActionSource,
  FetchedMessage,
  FlagChange,
  FolderInfo,
  FolderRole,
  MailAction,
  MailStore,
  SendAttachment,
  SendFile,
  SendFiles,
  SyncPosition,
} from "./ports.ts";
import { MissingFileError } from "./ports.ts";

/** The schema stores every role the engine detects. */
type StoredRole = (typeof schema.mailboxFolders.$inferSelect)["role"];
const storedRole = (role: FolderRole): StoredRole => role;

/** Subject threading only looks this far back; `decideThread` applies the exact window. */
const SUBJECT_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

interface MailboxRow {
  orgId: string;
  address: string;
}

/** A message that became a new row (not a new copy of a known one). */
export interface IngestedMessage {
  orgId: string;
  mailboxId: string;
  messageId: string;
  threadId: string;
  /** Null for a sent message indexed before its Sent copy exists. */
  folder: string | null;
  folderRole: StoredRole;
}

/** Where apps fetch what sanitized HTML points at. Both are Worker routes. */
export interface ContentLinks {
  /** Remote images become `<imageProxyUrl>?url=<encoded original>`. */
  imageProxyUrl: string;
  /** Inline `cid:` images become `<attachmentUrl>/<sha256 of the attachment>`. */
  attachmentUrl: string;
}

export interface PgMailStoreOptions {
  db: Db;
  objects: ObjectStore;
  links: ContentLinks;
  /** Called once per new message row, after it is committed. Must not throw. */
  onIngested?: (message: IngestedMessage) => void;
  /** Called after a prune removed messages, with every thread that lost one. Must not throw. */
  onPruned?: (pruned: PrunedThreads) => void;
  /** Called after threads were merged into one (see `mergeThreads`). Must not throw. */
  onMerged?: (merged: { orgId: string; mailboxId: string } & MergedThreads) => void;
}

/** Threads that lost messages deleted on the server; some may be gone (see `pruneMessages`). */
export interface PrunedThreads {
  orgId: string;
  mailboxId: string;
  threadIds: string[];
}

export class PgMailStore implements MailStore {
  private readonly db: Db;
  private readonly objects: ObjectStore;
  private readonly links: ContentLinks;
  private readonly onIngested: (message: IngestedMessage) => void;
  private readonly onPruned: (pruned: PrunedThreads) => void;
  private readonly onMerged: NonNullable<PgMailStoreOptions["onMerged"]>;
  private readonly mailboxes = new Map<string, MailboxRow>();
  /** The tail of each mailbox's thread-and-insert chain (see `oneAtATime`). */
  private readonly inserting = new Map<string, Promise<void>>();

  constructor(options: PgMailStoreOptions) {
    this.db = options.db;
    this.objects = options.objects;
    this.links = options.links;
    this.onIngested = options.onIngested ?? (() => {});
    this.onPruned = options.onPruned ?? (() => {});
    this.onMerged = options.onMerged ?? (() => {});
  }

  async saveFolders(mailboxId: string, folders: FolderInfo[]): Promise<void> {
    const { orgId } = await this.mailbox(mailboxId);
    await replaceFolders(this.db, {
      orgId,
      mailboxId,
      folders: folders.map((f) => ({ path: f.path, role: storedRole(f.role) })),
    });
  }

  async getSyncPosition(mailboxId: string, folder: string): Promise<SyncPosition | null> {
    const position = await getFolderPosition(this.db, mailboxId, folder);
    if (!position) return null;
    return {
      uidValidity: BigInt(position.uidvalidity),
      highestModseq: position.highestModseq,
      uidNext: position.uidnext,
    };
  }

  async saveSyncPosition(mailboxId: string, folder: string, position: SyncPosition) {
    await saveFolderPosition(this.db, mailboxId, folder, {
      uidvalidity: Number(position.uidValidity),
      uidnext: position.uidNext,
      highestModseq: position.highestModseq,
    });
  }

  folderIndex(mailboxId: string, folder: string): Promise<Map<number, string[]>> {
    return folderLocations(this.db, mailboxId, folder);
  }

  async storeMessage(mailboxId: string, fetched: FetchedMessage): Promise<{ created: boolean }> {
    if (await hasLocation(this.db, mailboxId, fetched.folder, fetched.uid)) {
      return { created: false };
    }
    const mailbox = await this.mailbox(mailboxId);
    const folder = await findFolder(this.db, mailboxId, fetched.folder);
    if (!folder) throw new Error(`folder ${fetched.folder} is not stored`);

    const parsed = await parseMessage(fetched.raw);
    const { message } = parsed;
    // A copy of a message we already indexed (moved, or filed in two folders): record where it
    // is and stop. Parsing again is cheap; re-threading and re-notifying would not be.
    let stored = await findMessageByHeader(this.db, mailboxId, message.messageId);
    let inserted = false;
    if (!stored) {
      const result = await this.insert(mailboxId, mailbox, folder.id, fetched, parsed);
      stored = { id: result.id, threadId: result.threadId };
      inserted = result.inserted;
    } else if (fetched.providerThreadId) {
      // Indexed before Gmail's copy arrived (our own send, stored as SMTP accepted it): the
      // message's thread takes Gmail's id, or the message moves to the thread that has it.
      const providerThreadId = fetched.providerThreadId;
      const found = stored;
      await this.oneAtATime(mailboxId, () =>
        this.followProviderThread(mailboxId, mailbox, found, providerThreadId, {
          subjectKey: normalizeSubject(message.subject),
          lastMessageAt: message.sentAt ?? fetched.internalDate ?? new Date(),
        }),
      );
    }

    const created = await addLocation(this.db, {
      orgId: mailbox.orgId,
      mailboxId,
      folderId: folder.id,
      uid: fetched.uid,
      messageId: stored.id,
      flags: fetched.flags,
      modseq: fetched.modseq,
    });
    if (inserted) {
      this.onIngested({
        orgId: mailbox.orgId,
        mailboxId,
        messageId: stored.id,
        threadId: stored.threadId,
        folder: fetched.folder,
        folderRole: folder.role,
      });
    }
    return { created };
  }

  async storeSent(
    mailboxId: string,
    raw: Uint8Array,
    options: { threadOf?: string } = {},
  ): Promise<void> {
    const mailbox = await this.mailbox(mailboxId);
    const parsed = await parseMessage(raw);
    if (await findMessageByHeader(this.db, mailboxId, parsed.message.messageId)) return;
    const threadId = options.threadOf
      ? await messageThread(this.db, mailboxId, options.threadOf)
      : null;
    const result = await this.insert(
      mailboxId,
      mailbox,
      null,
      { raw, uid: null, internalDate: null },
      parsed,
      threadId,
    );
    if (result.inserted) {
      this.onIngested({
        orgId: mailbox.orgId,
        mailboxId,
        messageId: result.id,
        threadId: result.threadId,
        folder: null,
        folderRole: "sent",
      });
    }
  }

  async applyFlags(mailboxId: string, folder: string, changes: FlagChange[]): Promise<void> {
    await setLocationFlags(this.db, { mailboxId, path: folder, changes });
  }

  async removeMessages(mailboxId: string, folder: string, uids: number[]): Promise<void> {
    await removeLocations(this.db, { mailboxId, path: folder, uids });
  }

  async resetFolder(mailboxId: string, folder: string): Promise<void> {
    await resetFolder(this.db, mailboxId, folder);
  }

  orphanedMessages(mailboxId: string): Promise<string[]> {
    return orphanedMessages(this.db, mailboxId);
  }

  async pruneMessages(mailboxId: string, messageIds: string[]) {
    const pruned = await pruneMessages(this.db, { mailboxId, messageIds });
    if (pruned.threadIds.length > 0) {
      const { orgId } = await this.mailbox(mailboxId);
      this.onPruned({ orgId, mailboxId, threadIds: pruned.threadIds });
    }
    return pruned;
  }

  private async insert(
    mailboxId: string,
    mailbox: MailboxRow,
    folderId: string | null,
    fetched: Pick<FetchedMessage, "raw" | "internalDate" | "providerThreadId"> & {
      uid: number | null;
    },
    parsed: Awaited<ReturnType<typeof parseMessage>>,
    knownThreadId: string | null = null,
  ) {
    const { message, attachmentContents } = parsed;
    // Objects first: a row never points at an object that is not there.
    const prefix = `${mailbox.orgId}/${mailboxId}`;
    const r2Key = `${prefix}/raw/${sha256(fetched.raw)}.eml`;
    await this.objects.put(r2Key, fetched.raw, "message/rfc822");

    const files = await Promise.all(
      message.attachments.map(async (meta, i) => {
        const content = attachmentContents[i] ?? new Uint8Array();
        const hash = sha256(content);
        const key = `${prefix}/att/${hash}`;
        await this.objects.put(key, content, meta.mimeType);
        return { meta, hash, key };
      }),
    );

    let htmlR2Key: string | null = null;
    let remoteImageCount = 0;
    if (message.html !== null) {
      const byCid = new Map(
        files.filter((f) => f.meta.contentId).map((f) => [f.meta.contentId as string, f.hash]),
      );
      const sanitized = sanitizeHtml(message.html, {
        proxyUrl: (src) => `${this.links.imageProxyUrl}?url=${encodeURIComponent(src)}`,
        cidUrl: (cid) => {
          const hash = byCid.get(cid);
          return hash ? `${this.links.attachmentUrl}/${hash}` : null;
        },
      });
      remoteImageCount = sanitized.remoteImageCount;
      htmlR2Key = `${prefix}/html/${sha256(fetched.raw)}.html`;
      await this.objects.put(htmlR2Key, sanitized.html, "text/html; charset=utf-8");
    }

    const sentAt = message.sentAt ?? fetched.internalDate ?? new Date();
    const { cleanText, forwarded } = cleanMessage(message);
    // One insert per mailbox at a time: an outbox send and an IMAP sync running together would
    // otherwise both miss each other's row when matching a thread, and split one conversation.
    return this.oneAtATime(mailboxId, async () => {
      const threadId =
        knownThreadId ??
        (await this.assignThread(mailboxId, mailbox, message, sentAt, fetched.providerThreadId));
      return upsertMessage(this.db, {
        orgId: mailbox.orgId,
        mailboxId,
        threadId,
        folderId,
        imapUid: fetched.uid,
        messageIdHeader: message.messageId,
        inReplyTo: message.inReplyTo,
        references: message.references,
        subject: message.subject,
        fromName: message.from?.name || null,
        fromAddress: message.from?.address ?? "",
        to: message.to.map(toAddress),
        cc: message.cc.map(toAddress),
        sentAt,
        r2Key,
        htmlR2Key,
        cleanText,
        forwarded,
        remoteImageCount,
        // Bounces and auto-replies never reopen a conversation or start an SLA (ADR 0021).
        automated: parsed.message.automated !== null,
        // Cleared once the Worker accepts `message.created`; until then the sweep re-sends it.
        notifyPending: true,
        attachments: files.map((f) => ({
          filename: f.meta.filename ?? "attachment",
          mimeType: f.meta.mimeType,
          size: f.meta.size,
          r2Key: f.key,
          inline: f.meta.inline,
          contentId: f.meta.contentId,
        })),
      });
    });
  }

  private async followProviderThread(
    mailboxId: string,
    mailbox: MailboxRow,
    stored: { id: string; threadId: string },
    providerThreadId: string,
    fresh: { subjectKey: string; lastMessageAt: Date },
  ) {
    const known = await findThreadByProviderId(this.db, mailboxId, providerThreadId);
    if (known === stored.threadId) return;
    if (!known && (await claimProviderThread(this.db, stored.threadId, providerThreadId))) return;
    const threadId =
      known ??
      (await createThread(this.db, {
        orgId: mailbox.orgId,
        mailboxId,
        ...fresh,
        providerThreadId,
      }));
    await moveMessageToThread(this.db, { mailboxId, messageId: stored.id, threadId });
  }

  private oneAtATime<T>(mailboxId: string, task: () => Promise<T>): Promise<T> {
    const result = (this.inserting.get(mailboxId) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.inserting.set(mailboxId, tail);
    void tail.then(() => {
      if (this.inserting.get(mailboxId) === tail) this.inserting.delete(mailboxId);
    });
    return result;
  }

  private async assignThread(
    mailboxId: string,
    mailbox: MailboxRow,
    message: ParsedMessage,
    sentAt: Date,
    providerThreadId?: string,
  ): Promise<string> {
    // Gmail's thread wins: the conversation is the one Gmail shows (ADR 0023).
    if (providerThreadId) {
      const known = await findThreadByProviderId(this.db, mailboxId, providerThreadId);
      if (known) return known;
    }
    const replyIds = [message.inReplyTo, ...message.references].filter(
      (id): id is string => id !== null,
    );
    const knownMessageIds = await threadsByMessageIds(this.db, mailboxId, replyIds);
    // No known parent: a stored reply to this message (or to its parent) may have come first.
    const relatedThreadId =
      knownMessageIds.size === 0
        ? await threadReferencing(this.db, mailboxId, [message.messageId, ...replyIds])
        : null;
    const subjectKey = normalizeSubject(message.subject);
    const candidates =
      replyIds.length === 0 && subjectKey !== ""
        ? await subjectThreadCandidates(this.db, {
            mailboxId,
            subjectKey,
            since: new Date(sentAt.getTime() - SUBJECT_LOOKBACK_MS),
          })
        : [];
    const decision = decideThread(
      { ...message, sentAt },
      { knownMessageIds, candidates, selfAddresses: [mailbox.address], relatedThreadId },
    );
    if (decision.kind === "headers" && !providerThreadId) {
      // A reply stored before this message started its own thread: this message links it to
      // the thread it joins, so the two are one conversation again.
      const linked = new Set([
        decision.threadId,
        ...knownMessageIds.values(),
        ...(await threadsReplyingTo(this.db, mailboxId, message.messageId)),
      ]);
      if (linked.size > 1) {
        const merged = await mergeThreads(this.db, { mailboxId, threadIds: [...linked] });
        if (merged.fromThreadIds.length > 0) {
          this.onMerged({ orgId: mailbox.orgId, mailboxId, ...merged });
        }
        return merged.intoThreadId;
      }
    }
    if (decision.kind !== "new") {
      // A thread started before Gmail's id was known (our own send, indexed before its Sent copy)
      // takes this id; one that already belongs to another Gmail thread is not this conversation.
      if (!providerThreadId) return decision.threadId;
      if (await claimProviderThread(this.db, decision.threadId, providerThreadId)) {
        return decision.threadId;
      }
    }
    return createThread(this.db, {
      orgId: mailbox.orgId,
      mailboxId,
      subjectKey: decision.kind === "new" ? decision.subjectKey : normalizeSubject(message.subject),
      lastMessageAt: sentAt,
      providerThreadId: providerThreadId ?? null,
    });
  }

  private async mailbox(mailboxId: string): Promise<MailboxRow> {
    const cached = this.mailboxes.get(mailboxId);
    if (cached) return cached;
    const row = await findMailbox(this.db, mailboxId);
    if (!row) throw new Error(`mailbox ${mailboxId} is not stored`);
    this.mailboxes.set(mailboxId, row);
    return row;
  }
}

/** `mail_actions` as the outbox. The executor owns retry timing; the claim is a lease. */
export interface FailedAction {
  actionId: string;
  orgId: string;
  mailboxId: string;
  memberId: string | null;
  error: string;
  requestId: string | null;
}

export class PgActionSource implements ActionSource {
  private readonly db: Db;
  private readonly leaseMs: number;
  private readonly onFailed?: (action: FailedAction) => void;

  constructor(options: {
    db: Db;
    leaseMs?: number;
    /** An action just failed for good (no retry left). */
    onFailed?: (action: FailedAction) => void;
  }) {
    this.db = options.db;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.onFailed = options.onFailed;
  }

  async claim(limit: number): Promise<MailAction[]> {
    const rows = await claimActions(this.db, { limit, leaseMs: this.leaseMs });
    const claimed: MailAction[] = [];
    for (const row of rows) {
      const payload = actionPayloadSchemas[row.kind].safeParse(row.payload);
      if (!payload.success) {
        // Retrying cannot fix a malformed payload: show it as failed now.
        await this.fail(row.id, `invalid payload: ${payload.error.message}`, null);
        continue;
      }
      claimed.push({
        id: row.id,
        orgId: row.orgId,
        mailboxId: row.mailboxId,
        requestId: row.requestId,
        kind: row.kind,
        payload: payload.data,
        idempotencyKey: row.idempotencyKey,
        attempts: row.attempts,
        smtpAcceptedAt: row.smtpAcceptedAt,
      } as MailAction);
    }
    return claimed;
  }

  async markSmtpAccepted(actionId: string): Promise<void> {
    await markActionSmtpAccepted(this.db, actionId);
  }

  async complete(actionId: string): Promise<void> {
    await completeAction(this.db, actionId);
  }

  async fail(actionId: string, error: string, retryAt: Date | null): Promise<void> {
    const row = await rescheduleAction(this.db, actionId, error, retryAt);
    if (row?.status === "failed") {
      const { id, orgId, mailboxId, memberId, requestId } = row;
      this.onFailed?.({ actionId: id, orgId, mailboxId, memberId, error, requestId });
    }
  }

  async defer(actionId: string, retryAt: Date): Promise<void> {
    await deferAction(this.db, actionId, retryAt);
  }

  nextDueAt(): Promise<Date | null> {
    return nextActionDue(this.db);
  }

  sendingPaused(address: string): Promise<boolean> {
    return sendingPaused(this.db, address.slice(address.lastIndexOf("@") + 1).toLowerCase());
  }
}

/** Send attachments from Postgres rows and the object store. */
export class PgSendFiles implements SendFiles {
  private readonly options: { db: Db; objects: ObjectStore };

  constructor(options: { db: Db; objects: ObjectStore }) {
    this.options = options;
  }

  async resolve(mailboxId: string, refs: SendAttachment[]): Promise<SendFile[]> {
    if (refs.length === 0) return [];
    const rows = await sendAttachmentFiles(this.options.db, mailboxId, refs);
    if (rows.length !== refs.length) {
      throw new MissingFileError(`${refs.length - rows.length} attachment(s) not found`);
    }
    return Promise.all(
      rows.map(async (row) => {
        const content = await this.options.objects.get(row.r2Key);
        if (!content) throw new MissingFileError(`attachment object ${row.r2Key} is gone`);
        return { filename: row.filename, contentType: row.mimeType, content };
      }),
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toAddress(address: { name: string; address: string }) {
  return { name: address.name || null, address: address.address };
}
