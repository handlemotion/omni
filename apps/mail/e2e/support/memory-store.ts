// In-memory storage side for e2e tests only. The IMAP side is always real GreenMail.
import type {
  ActionSource,
  FetchedMessage,
  FlagChange,
  FolderInfo,
  MailAction,
  MailStore,
  SyncPosition,
} from "../../src/ports.ts";

interface StoredMessage extends FetchedMessage {
  mailboxId: string;
}

const key = (mailboxId: string, folder: string) => `${mailboxId}\u0000${folder}`;

export class MemoryStore implements MailStore {
  folders = new Map<string, FolderInfo[]>();
  positions = new Map<string, SyncPosition>();
  messages = new Map<string, Map<number, StoredMessage>>();
  /** Every `storeMessage` call that created a row, in order. Re-imports show up here. */
  created: { folder: string; uid: number }[] = [];
  resets: string[] = [];

  async saveFolders(mailboxId: string, folders: FolderInfo[]) {
    this.folders.set(mailboxId, folders);
  }

  async getSyncPosition(mailboxId: string, folder: string) {
    return this.positions.get(key(mailboxId, folder)) ?? null;
  }

  async saveSyncPosition(mailboxId: string, folder: string, position: SyncPosition) {
    this.positions.set(key(mailboxId, folder), position);
  }

  async folderIndex(mailboxId: string, folder: string) {
    const index = new Map<number, string[]>();
    for (const [uid, message] of this.folder(mailboxId, folder)) index.set(uid, message.flags);
    return index;
  }

  async storeMessage(mailboxId: string, message: FetchedMessage) {
    const folder = this.folder(mailboxId, message.folder);
    if (folder.has(message.uid)) return { created: false };
    folder.set(message.uid, { ...message, mailboxId });
    this.created.push({ folder: message.folder, uid: message.uid });
    return { created: true };
  }

  async applyFlags(mailboxId: string, folder: string, changes: FlagChange[]) {
    const stored = this.folder(mailboxId, folder);
    for (const change of changes) {
      const message = stored.get(change.uid);
      if (message) Object.assign(message, { flags: change.flags, modseq: change.modseq });
    }
  }

  async removeMessages(mailboxId: string, folder: string, uids: number[]) {
    const stored = this.folder(mailboxId, folder);
    for (const uid of uids) stored.delete(uid);
  }

  async resetFolder(mailboxId: string, folder: string) {
    this.messages.delete(key(mailboxId, folder));
    this.positions.delete(key(mailboxId, folder));
    this.resets.push(folder);
  }

  /** Stored messages of a folder, oldest UID first. */
  list(mailboxId: string, folder: string): StoredMessage[] {
    return [...this.folder(mailboxId, folder).values()].toSorted((a, b) => a.uid - b.uid);
  }

  private folder(mailboxId: string, folder: string) {
    let stored = this.messages.get(key(mailboxId, folder));
    if (!stored) {
      stored = new Map();
      this.messages.set(key(mailboxId, folder), stored);
    }
    return stored;
  }
}

type ActionState = {
  action: MailAction;
  status: "pending" | "claimed" | "done" | "failed";
  retryAt: Date | null;
  errors: string[];
};

export class MemoryActions implements ActionSource {
  rows = new Map<string, ActionState>();

  enqueue(action: Omit<MailAction, "attempts" | "smtpAcceptedAt">): void {
    this.rows.set(action.id, {
      action: { ...action, attempts: 0, smtpAcceptedAt: null } as MailAction,
      status: "pending",
      retryAt: null,
      errors: [],
    });
  }

  async claim(limit: number) {
    const now = Date.now();
    const due = [...this.rows.values()]
      .filter((row) => row.status === "pending" && (!row.retryAt || row.retryAt.getTime() <= now))
      .slice(0, limit);
    for (const row of due) {
      row.status = "claimed";
      row.action.attempts++;
    }
    return due.map((row) => ({ ...row.action }));
  }

  async markSmtpAccepted(actionId: string) {
    this.row(actionId).action.smtpAcceptedAt = new Date();
  }

  async complete(actionId: string) {
    this.row(actionId).status = "done";
  }

  async fail(actionId: string, error: string, retryAt: Date | null) {
    const row = this.row(actionId);
    row.errors.push(error);
    row.status = retryAt ? "pending" : "failed";
    row.retryAt = retryAt;
  }

  /** The row as the database would return it now. */
  current(actionId: string): MailAction {
    return { ...this.row(actionId).action };
  }

  row(actionId: string): ActionState {
    const row = this.rows.get(actionId);
    if (!row) throw new Error(`no action ${actionId}`);
    return row;
  }
}
