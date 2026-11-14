// Storage ports. The IMAP/SMTP engine talks to storage only through these two interfaces, so the
// `@omni/db` + R2 implementation can replace the e2e in-memory one without touching the engine.
//
// Every method must be idempotent: the engine may repeat any call after a crash or a reconnect,
// and the IMAP server stays the source of truth (a full re-sync must converge).

import type { SpooledFile } from "./spool.ts";

export type FolderRole = "inbox" | "sent" | "archive" | "trash" | "drafts" | "junk" | "other";

export interface FolderInfo {
  path: string;
  role: FolderRole;
}

/** Where a folder's sync stopped. Persisted per (mailbox, folder path). */
export interface SyncPosition {
  uidValidity: bigint;
  /** HIGHESTMODSEQ seen at the last complete sync; null when the server lacks CONDSTORE. */
  highestModseq: bigint | null;
  /** UIDNEXT seen at the last complete sync; 0 while the first import is still running. */
  uidNext: number;
}

export interface FetchedMessage {
  folder: string;
  uid: number;
  /**
   * The exact RFC 5322 bytes from the server. Goes to R2 unchanged. A large message arrives
   * spooled to a temp file instead (`spool.ts`); the store reads it from there and the caller
   * removes the file afterwards.
   */
  raw: Uint8Array | SpooledFile;
  flags: string[];
  modseq: bigint | null;
  internalDate: Date | null;
  /** Gmail's X-GM-THRID: the message joins that thread (ADR 0023). Absent elsewhere. */
  providerThreadId?: string;
}

export interface FlagChange {
  uid: number;
  /** The full flag set after the change, sorted. Not a delta. */
  flags: string[];
  modseq: bigint | null;
}

export interface MailStore {
  /** Replace the mailbox's folder list. Folders missing from `folders` were deleted on the server. */
  saveFolders(mailboxId: string, folders: FolderInfo[]): Promise<void>;
  getSyncPosition(mailboxId: string, folder: string): Promise<SyncPosition | null>;
  saveSyncPosition(mailboxId: string, folder: string, position: SyncPosition): Promise<void>;
  /** UID → sorted flags for every message stored for this folder. Drives the UID-list diff. */
  folderIndex(mailboxId: string, folder: string): Promise<Map<number, string[]>>;
  /** Store one message. Unique on (mailbox, folder, uid). Returns false when it was already stored. */
  storeMessage(mailboxId: string, message: FetchedMessage): Promise<{ created: boolean }>;
  applyFlags(mailboxId: string, folder: string, changes: FlagChange[]): Promise<void>;
  /** Messages expunged or moved out of `folder`. */
  removeMessages(mailboxId: string, folder: string, uids: number[]): Promise<void>;
  /** UIDVALIDITY changed: forget every message and the sync position of this folder. */
  resetFolder(mailboxId: string, folder: string): Promise<void>;
  /**
   * Index a message we just sent, before its Sent copy exists, so the reply shows in its thread
   * at once. The Sent copy found later by `storeMessage` becomes its location. Idempotent.
   * `threadOf` (a `messages.id`) files it with that message, for a forward that has no reply
   * headers; otherwise it threads like any message.
   */
  storeSent(mailboxId: string, raw: Uint8Array, options?: { threadOf?: string }): Promise<void>;
  /** Ids of stored messages with no copy left in any folder (deleted, or mid-move). */
  orphanedMessages(mailboxId: string): Promise<string[]>;
  /**
   * Delete those of `messageIds` that still have no copy, and threads left empty. Returns counts.
   */
  pruneMessages(
    mailboxId: string,
    messageIds: string[],
  ): Promise<{ messages: number; threads: number; threadIds: string[] }>;
  /**
   * After a full sync: report shared conversations whose mail is all in Trash or Junk, so the
   * Worker resolves them. Returns how many it reported.
   */
  reportDiscarded(mailboxId: string): Promise<number>;
}

// Outbox (`mail_actions`). UIDs mean nothing without their folder's UIDVALIDITY, so every action
// that targets existing messages carries it; a mismatch fails the action instead of touching the
// wrong message.

// Payload shapes live in `@omni/contracts`, shared with the Worker that writes them.
export type {
  ForwardCopyPayload,
  MessageTarget,
  SendAttachment,
  SendPayload,
} from "@omni/contracts";
import type {
  ForwardCopyPayload,
  MessageTarget,
  SendAttachment,
  SendPayload,
} from "@omni/contracts";

export type MailAction =
  | ActionBase<"send", SendPayload>
  | ActionBase<"forward_copy", ForwardCopyPayload>
  | ActionBase<"archive", MessageTarget>
  | ActionBase<"move", MessageTarget & { destination: string }>
  | ActionBase<"mark_read", MessageTarget>
  | ActionBase<"mark_unread", MessageTarget>
  | ActionBase<"trash", MessageTarget>
  | ActionBase<"spam", MessageTarget>
  | ActionBase<"not_spam", MessageTarget>;

interface ActionBase<K extends string, P> {
  id: string;
  orgId: string;
  mailboxId: string;
  /** The Worker request that queued it, for tracing; null for older rows. */
  requestId: string | null;
  kind: K;
  payload: P;
  idempotencyKey: string;
  /** Attempts so far, including the one this claim starts. */
  attempts: number;
  /** Set once SMTP accepted a send or a forward copy, so a retry never sends again. */
  smtpAcceptedAt: Date | null;
}

export interface ActionSource {
  /**
   * Claim up to `limit` due actions and count the attempt. A claim is a lease: an action claimed
   * by a process that died must become claimable again after the lease expires.
   */
  claim(limit: number): Promise<MailAction[]>;
  /** SMTP accepted the message. Persist before anything else can fail. */
  markSmtpAccepted(actionId: string): Promise<void>;
  complete(actionId: string): Promise<void>;
  /** `retryAt` null means give up: the action is shown to the user as failed. */
  fail(actionId: string, error: string, retryAt: Date | null): Promise<void>;
  /** Hand a claimed action back to run at `retryAt`, without counting the attempt it claimed. */
  defer(actionId: string, retryAt: Date): Promise<void>;
  /**
   * True while sending from this address's domain is paused: the domain's ownership challenge
   * left DNS (ADR 0010). Sends wait, attempts not counted, until it is back.
   */
  sendingPaused(address: string): Promise<boolean>;
  /** When the next pending action becomes due, or null: an undo-send window ending. */
  nextDueAt(): Promise<Date | null>;
}

/** A file to attach to a send, read from the object store. */
export interface SendFile {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface SendFiles {
  /**
   * The send's attachments, in order. Each must belong to `mailboxId`; throws `MissingFileError`
   * when one is gone, since retrying cannot bring it back.
   */
  resolve(mailboxId: string, refs: SendAttachment[]): Promise<SendFile[]>;
}

export class MissingFileError extends Error {
  override name = "MissingFileError";
}
