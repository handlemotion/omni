import { actionPayloadSchemas } from "@omni/contracts";
import {
  addLocation,
  claimActions,
  completeAction,
  claimProviderThread,
  createThread,
  deferAction,
  enqueueForwardCopies,
  sendingPaused,
  type Db,
  findFolder,
  findMailbox,
  findMessageByHeader,
  findThreadByProviderId,
  discardedConversations,
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
  reconcileFolder,
  refreshListUnsubscribe,
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
import {
  decideThread,
  normalizeSubject,
  type ParsedMessage,
  parseMessage,
  parseMessageStream,
} from "@omni/mail-core";
import { cleanMessage, sanitizeHtml } from "@omni/mail-core/clean";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ObjectStore } from "./objects.ts";
import { discard, isSpooled, spool, type SpooledFile } from "./spool.ts";
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
const storedRole = (role: FolderRole) => role satisfies StoredRole;

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
  /** Called with shared conversations found discarded in another mail app. Must not throw. */
  onDiscarded?: (discarded: PrunedThreads) => void;
  /**
   * Called after a sync changed threads' archived or read state (another mail app moved or
   * flagged mail) and queued `threads.changed` for them. Must not throw.
   */
  onChanged?: () => void;
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
  private readonly onDiscarded: (discarded: PrunedThreads) => void;
  private readonly onChanged: () => void;
  private readonly mailboxes = new Map<string, MailboxRow>();
  private readonly inserting = new Map<string, Promise<void>>();

  constructor(options: PgMailStoreOptions) {
    this.db = options.db;
    this.objects = options.objects;
    this.links = options.links;
    this.onIngested = options.onIngested ?? (() => {});
    this.onPruned = options.onPruned ?? (() => {});
    this.onMerged = options.onMerged ?? (() => {});
    this.onDiscarded = options.onDiscarded ?? (() => {});
    this.onChanged = options.onChanged ?? (() => {});
  }

  async saveFolders(mailboxId: string, folders: FolderInfo[]) {
    const { orgId } = await this.mailbox(mailboxId);
    await replaceFolders(this.db, {
      orgId,
      mailboxId,
      folders: folders.map((f) => ({ path: f.path, role: storedRole(f.role) })),
    });
  }

  async getSyncPosition(mailboxId: string, folder: string) {
    const position = await getFolderPosition(this.db, mailboxId, folder);
    if (!position) return null satisfies SyncPosition | null;
    return {
      uidValidity: BigInt(position.uidvalidity),
      highestModseq: position.highestModseq,
      uidNext: position.uidnext,
    } satisfies SyncPosition | null;
  }

  async saveSyncPosition(mailboxId: string, folder: string, position: SyncPosition) {
    await saveFolderPosition(this.db, mailboxId, folder, {
      uidvalidity: Number(position.uidValidity),
      uidnext: position.uidNext,
      highestModseq: position.highestModseq,
    });
  }

  folderIndex(mailboxId: string, folder: string) {
    return folderLocations(this.db, mailboxId, folder) satisfies Promise<Map<number, string[]>>;
  }

  async storeMessage(mailboxId: string, fetched: FetchedMessage) {
    if (await hasLocation(this.db, mailboxId, fetched.folder, fetched.uid)) {
      return { created: false } satisfies { created: boolean };
    }
    const mailbox = await this.mailbox(mailboxId);
    const folder = await findFolder(this.db, mailboxId, fetched.folder);
    if (!folder) throw new Error(`folder ${fetched.folder} is not stored`);

    const parsed = await parse(fetched.raw);
    try {
      return (await this.storeParsed(mailboxId, mailbox, folder, fetched, parsed)) satisfies {
        created: boolean;
      };
    } finally {
      await Promise.all(parsed.attachments.filter(isSpooled).map((file) => discard(file.path)));
    }
  }

  private async storeParsed(
    mailboxId: string,
    mailbox: MailboxRow,
    folder: NonNullable<Awaited<ReturnType<typeof findFolder>>>,
    fetched: FetchedMessage,
    parsed: Parsed,
  ) {
    const { message } = parsed;
    let stored = await findMessageByHeader(this.db, mailboxId, message.messageId);
    let inserted = false;
    if (!stored) {
      const result = await this.insert(mailboxId, mailbox, folder.id, fetched, parsed);
      stored = { id: result.id, threadId: result.threadId };
      inserted = result.inserted;
    } else {
      await refreshListUnsubscribe(this.db, stored.id, {
        listUnsubscribe: message.signals.listUnsubscribe,
        listUnsubscribeOneClick: message.signals.listUnsubscribeOneClick,
      });
      if (fetched.providerThreadId) {
        const providerThreadId = fetched.providerThreadId;
        const found = stored;
        await this.oneAtATime(mailboxId, () =>
          this.followProviderThread(mailboxId, mailbox, found, providerThreadId, {
            subjectKey: normalizeSubject(message.subject),
            lastMessageAt: message.sentAt ?? fetched.internalDate ?? new Date(),
          }),
        );
      }
    }

    await enqueueForwardCopies(this.db, { mailboxId, messageId: stored.id, role: folder.role });
    const created = await addLocation(this.db, {
      orgId: mailbox.orgId,
      mailboxId,
      folderId: folder.id,
      uid: fetched.uid,
      messageId: stored.id,
      flags: fetched.flags,
      modseq: fetched.modseq,
      report: !inserted,
    });
    if (created && !inserted) this.onChanged();
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
    return { created } satisfies { created: boolean };
  }

  async storeSent(mailboxId: string, raw: Uint8Array, options: { threadOf?: string } = {}) {
    const mailbox = await this.mailbox(mailboxId);
    const parsed = await parse(raw);
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
    await enqueueForwardCopies(this.db, { mailboxId, messageId: result.id, role: "sent" });
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

  async reportDiscarded(mailboxId: string) {
    const threadIds = await discardedConversations(this.db, mailboxId);
    if (threadIds.length > 0) {
      const { orgId } = await this.mailbox(mailboxId);
      this.onDiscarded({ orgId, mailboxId, threadIds });
    }
    return threadIds.length;
  }

  async applyFlags(mailboxId: string, folder: string, changes: FlagChange[]) {
    if ((await setLocationFlags(this.db, { mailboxId, path: folder, changes })) > 0) {
      this.onChanged();
    }
  }

  async reconcileFolder(mailboxId: string, folder: string) {
    if ((await reconcileFolder(this.db, { mailboxId, path: folder })) > 0) this.onChanged();
  }

  async removeMessages(mailboxId: string, folder: string, uids: number[]) {
    if ((await removeLocations(this.db, { mailboxId, path: folder, uids })) > 0) this.onChanged();
  }

  async resetFolder(mailboxId: string, folder: string) {
    await resetFolder(this.db, mailboxId, folder);
  }

  orphanedMessages(mailboxId: string) {
    return orphanedMessages(this.db, mailboxId) satisfies Promise<string[]>;
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
    parsed: Parsed,
    knownThreadId: string | null = null,
  ) {
    const { message } = parsed;
    const prefix = `${mailbox.orgId}/${mailboxId}`;
    const rawHash = isSpooled(fetched.raw) ? fetched.raw.sha256 : sha256(fetched.raw);
    const r2Key = `${prefix}/raw/${rawHash}.eml`;
    await this.put(r2Key, fetched.raw, "message/rfc822");

    const files = await Promise.all(
      message.attachments.map(async (meta, i) => {
        const content = parsed.attachments[i] ?? new Uint8Array();
        const hash = isSpooled(content) ? content.sha256 : sha256(content);
        const key = `${prefix}/att/${hash}`;
        await this.put(key, content, meta.mimeType);
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
      htmlR2Key = `${prefix}/html/${rawHash}.html`;
      await this.objects.put(htmlR2Key, sanitized.html, "text/html; charset=utf-8");
    }

    const sentAt = message.sentAt ?? fetched.internalDate ?? new Date();
    const { cleanText, forwarded } = cleanMessage(message);
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
        listUnsubscribe: message.signals.listUnsubscribe,
        listUnsubscribeOneClick: message.signals.listUnsubscribeOneClick,
        automated: parsed.message.automated !== null,
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

  private oneAtATime<T>(mailboxId: string, task: () => Promise<T>) {
    const result = (this.inserting.get(mailboxId) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.inserting.set(mailboxId, tail);
    void tail.then(() => {
      if (this.inserting.get(mailboxId) === tail) this.inserting.delete(mailboxId);
    });
    return result satisfies Promise<T>;
  }

  private async assignThread(
    mailboxId: string,
    mailbox: MailboxRow,
    message: ParsedMessage,
    sentAt: Date,
    providerThreadId?: string,
  ) {
    if (providerThreadId) {
      const known = await findThreadByProviderId(this.db, mailboxId, providerThreadId);
      if (known) return known satisfies string;
    }
    const replyIds = [message.inReplyTo, ...message.references].filter(
      (id): id is string => id !== null,
    );
    const knownMessageIds = await threadsByMessageIds(this.db, mailboxId, replyIds);
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
        return merged.intoThreadId satisfies string;
      }
    }
    if (decision.kind !== "new") {
      if (!providerThreadId) return decision.threadId satisfies string;
      if (await claimProviderThread(this.db, decision.threadId, providerThreadId)) {
        return decision.threadId satisfies string;
      }
    }
    return createThread(this.db, {
      orgId: mailbox.orgId,
      mailboxId,
      subjectKey: decision.kind === "new" ? decision.subjectKey : normalizeSubject(message.subject),
      lastMessageAt: sentAt,
      providerThreadId: providerThreadId ?? null,
    }) satisfies Promise<string>;
  }

  private put(key: string, body: Uint8Array | SpooledFile, contentType: string) {
    return isSpooled(body)
      ? this.objects.putFile(key, body, contentType)
      : this.objects.put(key, body, contentType);
  }

  private async mailbox(mailboxId: string) {
    const cached = this.mailboxes.get(mailboxId);
    if (cached) return cached satisfies MailboxRow;
    const row = await findMailbox(this.db, mailboxId);
    if (!row) throw new Error(`mailbox ${mailboxId} is not stored`);
    this.mailboxes.set(mailboxId, row);
    return row satisfies MailboxRow;
  }
}

interface Parsed {
  message: ParsedMessage;
  attachments: (Uint8Array | SpooledFile)[];
}

const parse: (raw: Uint8Array | SpooledFile) => Promise<Parsed> = async (raw) => {
  if (!isSpooled(raw)) {
    const { message, attachmentContents } = await parseMessage(raw);
    return { message, attachments: attachmentContents };
  }
  const attachments: SpooledFile[] = [];
  try {
    const { message } = await parseMessageStream(
      () => createReadStream(raw.path),
      async (index, content) => {
        attachments[index] = await spool(content);
      },
    );
    const kept = attachments.slice(0, message.attachments.length);
    await Promise.all(attachments.slice(kept.length).map((file) => discard(file.path)));
    return { message, attachments: kept };
  } catch (error) {
    await Promise.all(attachments.map((file) => file && discard(file.path)));
    throw error;
  }
};

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

  async claim(limit: number) {
    const rows = await claimActions(this.db, { limit, leaseMs: this.leaseMs });
    const claimed: MailAction[] = [];
    for (const row of rows) {
      const payload = actionPayloadSchemas[row.kind].safeParse(row.payload);
      if (!payload.success) {
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
    return claimed satisfies MailAction[];
  }

  async markSmtpAccepted(actionId: string) {
    await markActionSmtpAccepted(this.db, actionId);
  }

  async complete(actionId: string) {
    await completeAction(this.db, actionId);
  }

  async fail(actionId: string, error: string, retryAt: Date | null) {
    const row = await rescheduleAction(this.db, actionId, error, retryAt);
    if (row?.status === "failed") {
      const { id, orgId, mailboxId, memberId, requestId } = row;
      this.onFailed?.({ actionId: id, orgId, mailboxId, memberId, error, requestId });
    }
  }

  async defer(actionId: string, retryAt: Date) {
    await deferAction(this.db, actionId, retryAt);
  }

  nextDueAt() {
    return nextActionDue(this.db) satisfies Promise<Date | null>;
  }

  sendingPaused(address: string) {
    return sendingPaused(
      this.db,
      address.slice(address.lastIndexOf("@") + 1).toLowerCase(),
    ) satisfies Promise<boolean>;
  }
}

/** Send attachments from Postgres rows and the object store. */
export class PgSendFiles implements SendFiles {
  private readonly options: { db: Db; objects: ObjectStore };

  constructor(options: { db: Db; objects: ObjectStore }) {
    this.options = options;
  }

  async resolve(mailboxId: string, refs: SendAttachment[]) {
    if (refs.length === 0) return [] satisfies SendFile[];
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
    ) satisfies Promise<SendFile[]>;
  }
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toAddress(address: { name: string; address: string }) {
  return { name: address.name || null, address: address.address };
}
