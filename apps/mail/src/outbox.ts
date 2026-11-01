import { createHash } from "node:crypto";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Logger } from "./log.ts";
import {
  type ImapSession,
  type MailboxConfig,
  type MailboxConnection,
  MailboxUnavailableError,
} from "./mailbox-connection.ts";
import type { ActionSource, MailAction, MessageTarget, SendPayload } from "./ports.ts";
import { backoffDelay, createLimiter } from "./timing.ts";

/** Retrying cannot help: bad payload, or the folder's UIDVALIDITY moved under the action. */
export class PermanentActionError extends Error {
  override name = "PermanentActionError";
}

export interface OutboxOptions {
  actions: ActionSource;
  logger: Logger;
  connection(mailboxId: string): MailboxConnection | undefined;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  concurrency?: number;
  batchSize?: number;
  /** An action whose mailbox is offline or still importing waits this long, attempt not counted. */
  deferMs?: number;
}

/**
 * Carries out `mail_actions` rows on IMAP and SMTP. Each action is safe to execute twice: a send
 * has a Message-ID derived from its idempotency key, and we look for it in Sent before sending.
 */
export class OutboxExecutor {
  private readonly options: Required<Omit<OutboxOptions, "connection">> &
    Pick<OutboxOptions, "connection">;
  private readonly limit: ReturnType<typeof createLimiter>;
  private draining: Promise<number> | null = null;
  private drainAgain = false;
  private stopped = false;
  /**
   * Sends SMTP accepted in this process whose `smtp_accepted_at` write has not landed yet. A retry
   * in this process skips SMTP for them, which leaves only a crash during a Postgres outage able
   * to send twice.
   */
  private readonly accepted = new Set<string>();

  constructor(options: OutboxOptions) {
    this.options = {
      maxAttempts: 8,
      retryBaseMs: 5_000,
      retryMaxMs: 30 * 60_000,
      concurrency: 4,
      batchSize: 20,
      deferMs: 30_000,
      ...options,
    };
    this.limit = createLimiter(this.options.concurrency);
  }

  /** Claims and runs due actions until none are left. Concurrent calls share one drain. */
  drain(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    this.draining = (async () => {
      let total = 0;
      do {
        this.drainAgain = false;
        while (!this.stopped) {
          const batch = await this.options.actions.claim(this.options.batchSize);
          if (batch.length === 0) break;
          total += batch.length;
          await Promise.all(batch.map((action) => this.limit(() => this.execute(action))));
        }
      } while (this.drainAgain && !this.stopped);
      return total;
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Claims nothing more; actions already claimed run to completion. Resolves once they have. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.draining?.catch(() => {});
  }

  /** Runs one claimed action and records the outcome. Never throws. */
  async execute(action: MailAction): Promise<void> {
    const { actions, logger } = this.options;
    const log = logger.child({
      actionId: action.id,
      kind: action.kind,
      mailboxId: action.mailboxId,
    });
    try {
      await this.perform(action);
      await actions.complete(action.id);
      log.info("outbox.done", { attempts: action.attempts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof MailboxUnavailableError) {
        // Not the action's fault: wait for the mailbox without spending one of its attempts.
        // A send that SMTP accepted already has `smtp_accepted_at`, so the retry only files it.
        const retryAt = new Date(Date.now() + this.options.deferMs);
        log.info("outbox.deferred", { retryAt });
        await actions.defer(action.id, retryAt).catch((deferError: unknown) => {
          log.error("outbox.defer_not_recorded", { error: deferError });
        });
        return;
      }
      const sent =
        action.kind === "send" && (action.smtpAcceptedAt || this.accepted.has(action.id));
      if (sent && action.attempts >= this.options.maxAttempts) {
        // The mail went out; only the Sent copy is missing. "failed" would invite a resend.
        log.error("outbox.sent_not_filed", { error: message, attempts: action.attempts });
        await actions.complete(action.id).catch((completeError: unknown) => {
          log.error("outbox.complete_not_recorded", { error: completeError });
        });
        return;
      }
      const permanent =
        error instanceof PermanentActionError || action.attempts >= this.options.maxAttempts;
      const retryAt = permanent
        ? null
        : new Date(
            Date.now() +
              this.options.retryBaseMs +
              backoffDelay(action.attempts, this.options.retryBaseMs, this.options.retryMaxMs),
          );
      log.warn("outbox.failed", { error: message, attempts: action.attempts, retryAt });
      await actions.fail(action.id, message, retryAt).catch((failError: unknown) => {
        log.error("outbox.fail_not_recorded", { error: failError });
      });
    }
  }

  private perform(action: MailAction): Promise<void> {
    const connection = this.options.connection(action.mailboxId);
    if (!connection) throw new PermanentActionError(`unknown mailbox ${action.mailboxId}`);
    const mailbox = connection.mailbox;

    switch (action.kind) {
      case "send":
        return this.send(connection, action);
      case "archive":
        return connection.run(async (session) => {
          const archive = await session.ensureFolder("archive", "Archive");
          await move(session, action.payload, archive.path);
        });
      case "move":
        return connection.run((session) =>
          move(session, action.payload, action.payload.destination),
        );
      case "mark_read":
      case "mark_unread":
        // Shared mailboxes: read state is per person and lives only in Postgres.
        if (mailbox.kind === "shared") return Promise.resolve();
        return connection.run(async (session) => {
          await selectTarget(session, action.payload, async () => {
            const uids = action.payload.uids.join(",");
            if (action.kind === "mark_read") {
              await session.client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
            } else {
              await session.client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
            }
          });
          await session.syncFolder(action.payload.folder);
        });
    }
  }

  private async send(
    connection: MailboxConnection,
    action: Extract<MailAction, { kind: "send" }>,
  ): Promise<void> {
    const mailbox = connection.mailbox;
    const messageId = deterministicMessageId(action.idempotencyKey, mailbox.address);
    const raw = await composeMessage(action.payload, messageId);

    // A retry after SMTP accepted never resends. The window left is a crash between SMTP's OK and
    // this write; appending to Sent first would trade it for "filed but never sent", which is worse.
    if (!action.smtpAcceptedAt) {
      if (!this.accepted.has(action.id)) {
        await smtpSend(mailbox, action.payload, raw);
        this.accepted.add(action.id);
      }
      await persistAccepted(() => this.options.actions.markSmtpAccepted(action.id));
      this.accepted.delete(action.id);
    }

    await connection.run(async (session) => {
      const sent = await session.ensureFolder("sent", "Sent");
      // Already filed by an earlier attempt that died before `complete`, or by a server that files
      // SMTP submissions itself: the deterministic Message-ID finds it either way.
      if ((await findByMessageId(session, sent.path, messageId)) !== null) return;
      await session.client.append(sent.path, raw, ["\\Seen"], new Date());
      // Save the Sent copy now so it shows in the thread without waiting for the 5-minute sync.
      await session.syncFolder(sent.path);
    });
  }
}

/**
 * After SMTP's OK, losing the `smtp_accepted_at` write means the retry sends again. A Postgres
 * blip is the likely cause, so try a few times before giving up.
 */
async function persistAccepted(write: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
}

/** `<sha256(key)@domain>`: the same idempotency key always yields the same Message-ID. */
export function deterministicMessageId(idempotencyKey: string, address: string): string {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (!address.includes("@") || !domain) {
    throw new PermanentActionError(`mailbox address has no domain: ${address}`);
  }
  const hash = createHash("sha256").update(`omni-send:${idempotencyKey}`).digest("hex");
  return `<${hash.slice(0, 32)}@${domain}>`;
}

function composeMessage(payload: SendPayload, messageId: string): Promise<Buffer> {
  return new MailComposer({
    from: payload.from,
    to: payload.to,
    cc: payload.cc,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    messageId,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
    date: new Date(),
  })
    .compile()
    .build();
}

async function smtpSend(mailbox: MailboxConfig, payload: SendPayload, raw: Buffer): Promise<void> {
  const transport = createTransport({
    host: mailbox.smtp.host,
    port: mailbox.smtp.port,
    secure: mailbox.smtp.secure,
    auth: { user: mailbox.user, pass: mailbox.pass },
    // Well inside the claim lease (5 min): a send still hanging when the lease ran out could be
    // claimed and sent again by another process.
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  });
  try {
    await transport.sendMail({
      envelope: {
        from: mailbox.address,
        to: [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])],
      },
      raw,
    });
  } finally {
    transport.close();
  }
}

async function findByMessageId(
  session: ImapSession,
  folder: string,
  messageId: string,
): Promise<number | null> {
  const lock = await session.client.getMailboxLock(folder);
  try {
    const uids = await session.client.search(
      { header: { "message-id": messageId } },
      { uid: true },
    );
    return uids && uids.length > 0 ? (uids[0] ?? null) : null;
  } finally {
    lock.release();
  }
}

/** Selects the target folder and checks its UIDVALIDITY before touching any UID. */
async function selectTarget(
  session: ImapSession,
  target: MessageTarget,
  task: () => Promise<void>,
): Promise<void> {
  if (target.uids.length === 0) throw new PermanentActionError("no uids");
  const lock = await session.client.getMailboxLock(target.folder);
  try {
    const box = session.client.mailbox;
    if (box === false || box.uidValidity.toString() !== target.uidValidity) {
      throw new PermanentActionError(`${target.folder} UIDVALIDITY changed; action is stale`);
    }
    await task();
  } finally {
    lock.release();
  }
}

async function move(session: ImapSession, target: MessageTarget, destination: string) {
  await selectTarget(session, target, async () => {
    await session.client.messageMove(target.uids.join(","), destination, { uid: true });
  });
  await session.syncFolder(target.folder);
  await session.syncFolder(destination);
}
