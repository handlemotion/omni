import { actionPayloadSchemas } from "@omni/contracts";
import {
  claimActions,
  completeAction,
  type Db,
  deferAction,
  markActionSmtpAccepted,
  nextActionDue,
  rescheduleAction,
  sendAttachmentFiles,
  sendingPaused,
} from "@omni/db";
import type { ObjectStore } from "./objects.ts";
import {
  type ActionSource,
  type MailAction,
  MissingFileError,
  type SendAttachment,
  type SendFile,
  type SendFiles,
} from "./ports.ts";

/** An action that failed for good, for the Worker to tell its member. */
export interface FailedAction {
  actionId: string;
  orgId: string;
  mailboxId: string;
  memberId: string | null;
  error: string;
  requestId: string | null;
}

/**
 * `mail_actions` as the outbox. The executor owns retry timing; the claim is a lease. A claimed
 * row's payload is parsed here, once: one that does not parse fails for good instead of running.
 */
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
