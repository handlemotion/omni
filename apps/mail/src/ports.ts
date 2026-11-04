// Storage ports. The IMAP/SMTP engine talks to storage only through these two interfaces
// (`pg-store.ts` implements them on `@omni/db` and object storage), so it never imports the
// database itself.
//
// Every method must be idempotent: the engine may repeat any call after a crash or a reconnect,
// and the IMAP server stays the source of truth (a full re-sync must converge).

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
  /** The exact RFC 5322 bytes from the server. Goes to R2 unchanged. */
  raw: Uint8Array;
  flags: string[];
  modseq: bigint | null;
  internalDate: Date | null;
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
}

// Outbox (`mail_actions`). UIDs mean nothing without their folder's UIDVALIDITY, so every action
// that targets existing messages carries it; a mismatch fails the action instead of touching the
// wrong message.

// Kinds and payload shapes live in `@omni/contracts`, shared with the Worker that writes them.
export type { MessageTarget, SendPayload } from "@omni/contracts";
import type { ActionPayload, MailActionKind } from "@omni/contracts";

/** A claimed action: each kind with its own payload. */
export type MailAction = {
  [K in MailActionKind]: ActionBase<K, ActionPayload<K>>;
}[MailActionKind];

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
  /** Set once SMTP accepted a send, so a retry only finishes the Sent append. */
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
}
