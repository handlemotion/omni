// `MailStore` and `ActionSource` on Postgres through `@omni/db`. The store turns each fetched
// message into the index: raw bytes, sanitized HTML and attachments to the object store, then
// parse, thread, clean, upsert. A message is one row per Message-ID in
// its mailbox; each IMAP copy of it is a location, so re-syncs, moves, UIDVALIDITY resets and
// restarts converge on the same rows.
import { actionPayloadSchemas, type MailEvent } from "@omni/contracts";
import {
  addLocation,
  claimActions,
  completeAction,
  createThread,
  deferAction,
  sendingPaused,
  type Db,
  findFolder,
  findMailbox,
  findMessageByHeader,
  folderLocations,
  getFolderPosition,
  hasLocation,
  markActionSmtpAccepted,
  removeLocations,
  replaceFolders,
  rescheduleAction,
  resetFolder,
  saveFolderPosition,
  schema,
  setLocationFlags,
  subjectThreadCandidates,
  threadReferencing,
  threadsByMessageIds,
  upsertMessage,
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
  SyncPosition,
} from "./ports.ts";

/** The schema's folder roles; drafts and junk are just folders to the index. */
type StoredRole = (typeof schema.mailboxFolders.$inferSelect)["role"];
const STORED_ROLES: readonly string[] = schema.folderRole.enumValues;
const isStoredRole = (role: FolderRole): role is FolderRole & StoredRole =>
  STORED_ROLES.includes(role);
const storedRole = (role: FolderRole): StoredRole => (isStoredRole(role) ? role : "other");

/** Subject threading only looks this far back; `decideThread` applies the exact window. */
const SUBJECT_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

interface MailboxRow {
  orgId: string;
  address: string;
}

/** A message that became a new row (not a new copy of a known one): a `message.created` event. */
export type IngestedMessage = Omit<Extract<MailEvent, { type: "message.created" }>, "type">;

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
}

export class PgMailStore implements MailStore {
  private readonly db: Db;
  private readonly objects: ObjectStore;
  private readonly links: ContentLinks;
  private readonly onIngested: (message: IngestedMessage) => void;
  private readonly mailboxes = new Map<string, MailboxRow>();

  constructor(options: PgMailStoreOptions) {
    this.db = options.db;
    this.objects = options.objects;
    this.links = options.links;
    this.onIngested = options.onIngested ?? (() => {});
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
        folderRole: folder.role,
      });
    }
    return { created };
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

  private async insert(
    mailboxId: string,
    mailbox: MailboxRow,
    folderId: string,
    fetched: FetchedMessage,
    parsed: Awaited<ReturnType<typeof parseMessage>>,
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
    if (message.html !== null) {
      const byCid = new Map(
        files.filter((f) => f.meta.contentId).map((f) => [f.meta.contentId as string, f.hash]),
      );
      const { html } = sanitizeHtml(message.html, {
        proxyUrl: (src) => `${this.links.imageProxyUrl}?url=${encodeURIComponent(src)}`,
        cidUrl: (cid) => {
          const hash = byCid.get(cid);
          return hash ? `${this.links.attachmentUrl}/${hash}` : null;
        },
      });
      htmlR2Key = `${prefix}/html/${sha256(fetched.raw)}.html`;
      await this.objects.put(htmlR2Key, html, "text/html; charset=utf-8");
    }

    const sentAt = message.sentAt ?? fetched.internalDate ?? new Date();
    const threadId = await this.assignThread(mailboxId, mailbox, message, sentAt);
    const { cleanText } = cleanMessage(message);
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
      attachments: files.map((f) => ({
        filename: f.meta.filename ?? "attachment",
        mimeType: f.meta.mimeType,
        size: f.meta.size,
        r2Key: f.key,
      })),
    });
  }

  private async assignThread(
    mailboxId: string,
    mailbox: MailboxRow,
    message: ParsedMessage,
    sentAt: Date,
  ): Promise<string> {
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
    if (decision.kind !== "new") return decision.threadId;
    return createThread(this.db, {
      orgId: mailbox.orgId,
      mailboxId,
      subjectKey: decision.subjectKey,
      lastMessageAt: sentAt,
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

/** An action that failed for good: an `action.failed` event. */
export type FailedAction = Omit<Extract<MailEvent, { type: "action.failed" }>, "type">;

/** `mail_actions` as the outbox. The executor owns retry timing; the claim is a lease. */

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
        // Sound: `payload` was parsed by the schema `kind` picks, which TypeScript cannot
        // correlate through the index.
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

  sendingPaused(address: string): Promise<boolean> {
    return sendingPaused(this.db, address.slice(address.lastIndexOf("@") + 1).toLowerCase());
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toAddress(address: { name: string; address: string }) {
  return { name: address.name || null, address: address.address };
}
