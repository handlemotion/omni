import { createHash } from "node:crypto";
import { Effect, Schedule } from "effect";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { composeForwardCopy, type Forwarding } from "./forward-copy.ts";
import type { Logger } from "./log.ts";
import {
  type ImapSession,
  loginFor,
  type MailboxConfig,
  type MailboxConnection,
  MailboxUnavailableError,
} from "./mailbox-connection.ts";
import {
  type ActionSource,
  type MailAction,
  type MailStore,
  type MessageTarget,
  MissingFileError,
  type SendFile,
  type SendFiles,
  type SendPayload,
} from "./ports.ts";
import { backoffDelay } from "./timing.ts";

/** Retrying cannot help: bad payload, or the folder's UIDVALIDITY moved under the action. */
export class PermanentActionError extends Error {
  override name = "PermanentActionError";
}

const PAUSED_RETRY_MS = 5 * 60_000;

/** The sender's domain lost its ownership challenge: the send waits instead of failing. */
export class SendingPausedError extends Error {
  override name = "SendingPausedError";
}

export interface OutboxOptions {
  actions: ActionSource;
  logger: Logger;
  connection(mailboxId: string): MailboxConnection | undefined;
  /** Indexes a sent message once SMTP accepts it, before its Sent copy exists. */
  store?: Pick<MailStore, "storeSent">;
  /** Reads a send's attachments. Required for sends that carry any. */
  files?: SendFiles;
  /** The CRM forwarding address (ADR 0032). Required for `forward_copy`. */
  forwarding?: Forwarding;
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
  private readonly options: Required<
    Omit<OutboxOptions, "connection" | "store" | "files" | "forwarding">
  > &
    Pick<OutboxOptions, "connection" | "store" | "files" | "forwarding">;
  private draining: Promise<number> | null = null;
  private drainAgain = false;
  private stopped = false;
  private readonly accepted = new Set<string>();

  constructor(options: OutboxOptions) {
    this.options = {
      store: undefined,
      files: undefined,
      forwarding: undefined,
      maxAttempts: 8,
      retryBaseMs: 5_000,
      retryMaxMs: 30 * 60_000,
      concurrency: 4,
      batchSize: 20,
      deferMs: 30_000,
      ...options,
    };
  }

  /** Claims and runs due actions until none are left. Concurrent calls share one drain. */
  drain() {
    if (this.stopped) return Promise.resolve(0) satisfies Promise<number>;
    if (this.draining) {
      this.drainAgain = true;
      return this.draining satisfies Promise<number>;
    }
    this.draining = (async () => {
      let total = 0;
      do {
        this.drainAgain = false;
        while (!this.stopped) {
          const batch = await this.options.actions.claim(this.options.batchSize);
          if (batch.length === 0) break;
          total += batch.length;
          await Effect.runPromise(
            Effect.forEach(batch, (action) => Effect.promise(() => this.execute(action)), {
              concurrency: this.options.concurrency,
              discard: true,
            }),
          );
        }
      } while (this.drainAgain && !this.stopped);
      return total;
    })().finally(() => {
      this.draining = null;
    });
    return this.draining satisfies Promise<number>;
  }

  /** Claims nothing more; actions already claimed run to completion. Resolves once they have. */
  async stop() {
    this.stopped = true;
    await this.draining?.catch(() => {});
  }

  /** Runs one claimed action and records the outcome. Never throws. */
  async execute(action: MailAction) {
    const { actions, logger } = this.options;
    const log = logger.child({
      component: "outbox",
      actionId: action.id,
      kind: action.kind,
      orgId: action.orgId,
      mailboxId: action.mailboxId,
      requestId: action.requestId,
    });
    const started = Date.now();
    try {
      await this.perform(action);
      await actions.complete(action.id);
      log.info("outbox.done", { attempts: action.attempts, durationMs: Date.now() - started });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof MailboxUnavailableError || error instanceof SendingPausedError) {
        const wait = error instanceof SendingPausedError ? PAUSED_RETRY_MS : this.options.deferMs;
        const retryAt = new Date(Date.now() + wait);
        log.info("outbox.deferred", { retryAt });
        await actions.defer(action.id, retryAt).catch((deferError: unknown) => {
          log.error("outbox.defer_not_recorded", { error: deferError });
        });
        return;
      }
      const sent =
        (action.kind === "send" || action.kind === "forward_copy") &&
        (action.smtpAcceptedAt || this.accepted.has(action.id));
      if (sent && action.attempts >= this.options.maxAttempts) {
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
      log.warn("outbox.failed", {
        error: message,
        attempts: action.attempts,
        retryAt,
        durationMs: Date.now() - started,
      });
      await actions.fail(action.id, message, retryAt).catch((failError: unknown) => {
        log.error("outbox.fail_not_recorded", { error: failError });
      });
    }
  }

  private perform(action: MailAction) {
    const connection = this.options.connection(action.mailboxId);
    if (!connection) throw new PermanentActionError(`unknown mailbox ${action.mailboxId}`);
    const mailbox = connection.mailbox;

    switch (action.kind) {
      case "send":
        return this.send(connection, action);
      case "forward_copy":
        return this.forwardCopy(connection, action);
      case "archive":
        return connection.run(async (session) => {
          const role = session.folders().find((f) => f.path === action.payload.folder)?.role;
          if (role === "sent" || role === "junk" || role === "archive") return;
          const archive = await session.ensureFolder("archive", "Archive");
          await move(session, action.payload, archive.path);
        });
      case "move":
        return connection.run((session) =>
          move(session, action.payload, action.payload.destination),
        );
      case "trash":
        return connection.run(async (session) => {
          const trash = await session.ensureFolder("trash", "Trash");
          if (action.payload.folder === trash.path) return;
          await move(session, action.payload, trash.path);
        });
      case "spam":
        return connection.run(async (session) => {
          const junk = await session.ensureFolder("junk", "Junk");
          if (action.payload.folder === junk.path) return;
          await move(session, action.payload, junk.path);
        });
      case "not_spam":
        return connection.run(async (session) => {
          const inbox = session.folder("inbox");
          if (!inbox) throw new Error("mailbox has no INBOX");
          if (session.folder("junk")?.path !== action.payload.folder) return;
          await move(session, action.payload, inbox.path);
        });
      case "mark_read":
      case "mark_unread":
        if (mailbox.kind === "shared") return Promise.resolve();
        if (mailbox.provider === "gmail" && !action.payload.done) return Promise.resolve();
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

  private async sendFiles(mailboxId: string, payload: SendPayload) {
    const refs = payload.attachments ?? [];
    if (refs.length === 0) return [] satisfies SendFile[];
    if (!this.options.files) throw new PermanentActionError("this outbox cannot read attachments");
    try {
      return (await this.options.files.resolve(mailboxId, refs)) satisfies SendFile[];
    } catch (error) {
      if (error instanceof MissingFileError) throw new PermanentActionError(error.message);
      throw error;
    }
  }

  private async send(connection: MailboxConnection, action: Extract<MailAction, { kind: "send" }>) {
    const mailbox = connection.mailbox;
    const messageId =
      action.payload.messageId ?? deterministicMessageId(action.idempotencyKey, mailbox.address);
    const delivered = Boolean(action.smtpAcceptedAt) || this.accepted.has(action.id);
    if (delivered && (await this.filedInSent(connection, messageId))) return;
    let files: SendFile[];
    try {
      files = await this.sendFiles(mailbox.id, action.payload);
    } catch (error) {
      if (!delivered || !(error instanceof PermanentActionError)) throw error;
      this.options.logger.warn("outbox.sent_not_filed", { actionId: action.id, error });
      return;
    }
    const raw = await composeMessage(action.payload, messageId, files);

    if (!action.smtpAcceptedAt) {
      if (!this.accepted.has(action.id)) {
        if (await this.options.actions.sendingPaused(mailbox.address)) {
          throw new SendingPausedError(
            `sending from ${mailbox.address} is paused: its domain's DNS no longer verifies`,
          );
        }
        const { to, cc = [], bcc = [] } = action.payload;
        const crm = await this.options.forwarding?.target(mailbox.id);
        await smtpSend(mailbox, [...to, ...cc, ...bcc, ...(crm ? [crm] : [])], raw);
        this.accepted.add(action.id);
      }
      await persistAccepted(() => this.options.actions.markSmtpAccepted(action.id));
      this.accepted.delete(action.id);
    }

    const threadOf = action.payload.inReplyToMessageId;
    await this.options.store?.storeSent(mailbox.id, raw, { threadOf }).catch((error: unknown) => {
      this.options.logger.warn("outbox.sent_not_indexed", { actionId: action.id, error });
    });

    await connection.run(async (session) => {
      const sent = await session.ensureFolder("sent", "Sent");
      if (session.capabilities.gmail) {
        await session.syncFolder(sent.path);
        return;
      }
      if ((await findByMessageId(session, sent.path, messageId)) !== null) return;
      await session.client.append(sent.path, raw, ["\\Seen"], new Date());
      await session.syncFolder(sent.path);
    });
  }

  private async forwardCopy(
    connection: MailboxConnection,
    action: Extract<MailAction, { kind: "forward_copy" }>,
  ) {
    if (action.smtpAcceptedAt || this.accepted.has(action.id)) return;
    const mailbox = connection.mailbox;
    if (!this.options.forwarding) throw new PermanentActionError("this outbox cannot forward");
    const source = await this.options.forwarding.copy(mailbox.id, action.payload.messageId);
    if (!source) return;
    const raw = await composeForwardCopy(source.raw, {
      from: mailbox.address,
      to: source.to,
      messageId: deterministicMessageId(action.idempotencyKey, mailbox.address),
    });
    if (await this.options.actions.sendingPaused(mailbox.address)) {
      throw new SendingPausedError(`sending from ${mailbox.address} is paused`);
    }
    await smtpSend(mailbox, [source.to], raw);
    this.accepted.add(action.id);
    await persistAccepted(() => this.options.actions.markSmtpAccepted(action.id));
    this.accepted.delete(action.id);
  }

  private filedInSent(connection: MailboxConnection, messageId: string) {
    return connection.run(async (session) => {
      const sent = await session.ensureFolder("sent", "Sent");
      return (await findByMessageId(session, sent.path, messageId)) !== null;
    }) satisfies Promise<boolean>;
  }
}

function persistAccepted(write: () => Promise<void>) {
  return Effect.runPromise(
    Effect.tryPromise({ try: write, catch: (error) => error }).pipe(
      Effect.retry(Schedule.exponential("400 millis").pipe(Schedule.upTo({ times: 4 }))),
    ),
  );
}

/** `<sha256(key)@domain>`: the same idempotency key always yields the same Message-ID. */
export function deterministicMessageId(idempotencyKey: string, address: string) {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (!address.includes("@") || !domain) {
    throw new PermanentActionError(`mailbox address has no domain: ${address}`);
  }
  const hash = createHash("sha256").update(`omni-send:${idempotencyKey}`).digest("hex");
  return `<${hash.slice(0, 32)}@${domain}>`;
}

function composeMessage(payload: SendPayload, messageId: string, files: SendFile[] = []) {
  return new MailComposer({
    from: payload.fromName ? { name: payload.fromName, address: payload.from } : payload.from,
    attachments: files.map((file) => ({
      filename: file.filename,
      contentType: file.contentType,
      content: Buffer.from(file.content),
    })),
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
    .build() satisfies Promise<Buffer>;
}

async function smtpSend(mailbox: MailboxConfig, recipients: string[], raw: Buffer) {
  const { auth } = mailbox;
  const login = await loginFor(mailbox).catch((error: unknown) => {
    if (auth.kind === "oauth2" && auth.token.isRevoked(error)) {
      throw new PermanentActionError("the Google account's access was revoked: reconnect it");
    }
    throw error;
  });
  const transport = createTransport({
    host: mailbox.smtp.host,
    port: mailbox.smtp.port,
    secure: mailbox.smtp.secure,
    auth: "accessToken" in login ? { type: "OAuth2", ...login } : login,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  });
  try {
    await transport.sendMail({
      envelope: {
        from: mailbox.address,
        to: recipients,
      },
      raw,
    });
  } catch (error) {
    if (auth.kind === "oauth2" && (error as { code?: string }).code === "EAUTH") {
      auth.token.invalidate();
    }
    throw error;
  } finally {
    transport.close();
  }
}

async function findByMessageId(session: ImapSession, folder: string, messageId: string) {
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

async function selectTarget(
  session: ImapSession,
  target: MessageTarget,
  task: () => Promise<void>,
) {
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
