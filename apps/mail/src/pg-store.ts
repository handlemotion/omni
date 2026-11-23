import {
  addLocation,
  enqueueForwardCopies,
  type Db,
  findFolder,
  findMailbox,
  findMessageByHeader,
  discardedConversations,
  folderLocations,
  getFolderPosition,
  hasLocation,
  messageThread,
  orphanedMessages,
  pruneMessages,
  reconcileFolder,
  refreshListUnsubscribe,
  removeLocations,
  replaceFolders,
  resetFolder,
  saveFolderPosition,
  setLocationFlags,
  upsertMessage,
} from "@omni/db";
import { normalizeSubject, type ParsedMessage } from "@omni/mail-core";
import { cleanMessage } from "@omni/mail-core/clean";
import {
  type ContentLinks,
  discardParsed,
  type Parsed,
  parse,
  writeMessageContent,
} from "./message-content.ts";
import type { ObjectStore } from "./objects.ts";
import type {
  FetchedMessage,
  FlagChange,
  FolderInfo,
  FolderRole,
  MailStore,
  SyncPosition,
} from "./ports.ts";
import { assignThread, followProviderThread, type ThreadingDeps } from "./threading.ts";

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
  folderRole: FolderRole;
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
  onMerged?: ThreadingDeps["onMerged"];
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
  private readonly threading: ThreadingDeps;
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
    this.threading = { db: options.db, onMerged: options.onMerged ?? (() => {}) };
    this.onDiscarded = options.onDiscarded ?? (() => {});
    this.onChanged = options.onChanged ?? (() => {});
  }

  async saveFolders(mailboxId: string, folders: FolderInfo[]) {
    const { orgId } = await this.mailbox(mailboxId);
    await replaceFolders(this.db, {
      orgId,
      mailboxId,
      folders,
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
      await discardParsed(parsed);
    }
  }

  private async findStored(mailboxId: string, message: ParsedMessage) {
    for (const key of [message.messageId, ...message.messageIdAliases]) {
      const stored = await findMessageByHeader(this.db, mailboxId, key);
      if (stored) return stored;
    }
    return null;
  }

  private async storeParsed(
    mailboxId: string,
    mailbox: MailboxRow,
    folder: NonNullable<Awaited<ReturnType<typeof findFolder>>>,
    fetched: FetchedMessage,
    parsed: Parsed,
  ) {
    const { message } = parsed;
    let stored = await this.findStored(mailboxId, message);
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
          followProviderThread(this.db, { id: mailboxId, ...mailbox }, found, providerThreadId, {
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
    if (await this.findStored(mailboxId, parsed.message)) return;
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
    const content = await writeMessageContent(
      this.objects,
      this.links,
      `${mailbox.orgId}/${mailboxId}`,
      fetched.raw,
      parsed,
    );
    const sentAt = message.sentAt ?? fetched.internalDate ?? new Date();
    const { cleanText, forwarded } = cleanMessage(message);
    return this.oneAtATime(mailboxId, async () => {
      const threadId =
        knownThreadId ??
        (await assignThread(
          this.threading,
          { id: mailboxId, ...mailbox },
          message,
          sentAt,
          fetched.providerThreadId,
        ));
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
        r2Key: content.r2Key,
        htmlR2Key: content.htmlR2Key,
        cleanText,
        forwarded,
        remoteImageCount: content.remoteImageCount,
        listUnsubscribe: message.signals.listUnsubscribe,
        listUnsubscribeOneClick: message.signals.listUnsubscribeOneClick,
        automated: parsed.message.automated !== null,
        notifyPending: true,
        attachments: content.attachments,
      });
    });
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

  private async mailbox(mailboxId: string) {
    const cached = this.mailboxes.get(mailboxId);
    if (cached) return cached satisfies MailboxRow;
    const row = await findMailbox(this.db, mailboxId);
    if (!row) throw new Error(`mailbox ${mailboxId} is not stored`);
    this.mailboxes.set(mailboxId, row);
    return row satisfies MailboxRow;
  }
}

function toAddress(address: { name: string; address: string }) {
  return { name: address.name || null, address: address.address };
}
