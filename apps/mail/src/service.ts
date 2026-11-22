import {
  createDb,
  listServiceMailboxes,
  markNotified,
  deletePendingMailEvents,
  pendingMailEventRows,
  pendingNotifications,
  setMailboxStatus,
} from "@omni/db";
import { MAX_PRUNED_THREADS_PER_EVENT, mailEventSchema } from "@omni/contracts";
import { sql } from "drizzle-orm";
import { Effect, Fiber } from "effect";
import type { Hono } from "hono";
import type { Config } from "./config.ts";
import { mailboxAuth, openCredentials } from "./credentials.ts";
import { createDnsLookup } from "./dns.ts";
import { createApp, hmacVerifier } from "./http.ts";
import type { Logger } from "./log.ts";
import { WorkerNotifier } from "./notify.ts";
import { createS3Store } from "./objects.ts";
import { PgActionSource, PgMailStore, PgSendFiles } from "./pg-store.ts";
import { PgForwarding } from "./forward-copy.ts";
import { connectGoogle, createGoogleOAuth, disconnectGoogle } from "./providers/gmail.ts";
import { createGoogleCalendar } from "./providers/google-calendar.ts";
import { createCreditWatch } from "./hosting/credit-watch.ts";
import { disconnectHostedMailbox, disconnectMailbox } from "./hosting/disconnect.ts";
import { createPurelymailHost } from "./hosting/purelymail-host.ts";
import { createLoginRotation } from "./hosting/rotate-login.ts";
import { createPurelymailClient } from "./providers/purelymail.ts";
import { type MailHostPolicy, withPlaintextPolicy } from "./mail-hosts.ts";
import { createProvisioner } from "./provisioning.ts";
import { Supervisor } from "./supervisor.ts";
import { rehomeMailboxes } from "./rehome.ts";
import { every } from "./timing.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ServiceConfig = Pick<
  Config,
  | "DATABASE_URL"
  | "MAIL_CREDENTIALS_KEY"
  | "SYNC_INTERVAL_MS"
  | "OUTBOX_INTERVAL_MS"
  | "MAILBOX_CONCURRENCY"
  | "MAIL_SERVICE_HMAC_SECRET"
  | "WORKER_URL"
  | "S3_ENDPOINT"
  | "S3_BUCKET"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY"
  | "S3_REGION"
  | "IMAGE_PROXY_URL"
  | "ATTACHMENT_URL"
> &
  Partial<
    Pick<
      Config,
      | "PURELYMAIL_API_TOKEN"
      | "PURELYMAIL_CREDIT_WARN_USD"
      | "GMAIL_SYNC_DAYS"
      | "DNS_RESOLVERS"
      | "DNS_NAMESERVER_PORT"
      | "DNS_TIMEOUT_MS"
      | "NOTIFY_SWEEP_MS"
      | "GOOGLE_CLIENT_ID"
      | "GOOGLE_CLIENT_SECRET"
      | "MAIL_ALLOW_PLAINTEXT_HOSTS"
      | "MAIL_ALLOW_PRIVATE_HOSTS"
    >
  >;

export interface MailService {
  app: Hono;
  supervisor: Supervisor;
  /** Connects mailboxes added since the last call and drops disabled or deleted ones. */
  reconcileMailboxes(): Promise<void>;
  stop(): Promise<void>;
}

export async function startService(config: ServiceConfig, log: Logger) {
  const hosts: MailHostPolicy = {
    plaintextHosts: new Set(config.MAIL_ALLOW_PLAINTEXT_HOSTS),
    privateHosts: new Set(config.MAIL_ALLOW_PRIVATE_HOSTS),
  };
  const { db, close } = createDb(config.DATABASE_URL, { max: 5 });
  const google =
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
      ? createGoogleOAuth({
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
        })
      : undefined;
  const notifier = new WorkerNotifier({
    workerUrl: config.WORKER_URL,
    secret: config.MAIL_SERVICE_HMAC_SECRET,
    logger: log,
    onDelivered: async (delivered) => {
      const pendingIds = delivered.flatMap((d) => (d.pendingId ? [d.pendingId] : []));
      await deletePendingMailEvents(db, pendingIds).catch((error: unknown) =>
        log.warn("notify.pending_delete_failed", { events: pendingIds.length, error }),
      );
      const events = delivered.map((d) => d.event);
      const ids = events.flatMap((e) => (e.type === "message.created" ? [e.messageId] : []));
      await markNotified(db, ids).catch((error: unknown) =>
        log.warn("notify.mark_failed", { events: ids.length, error }),
      );
    },
  });
  const sweepNotifications = async () => {
    const rows = await pendingNotifications(db, 500);
    if (rows.length > 0) log.info("notify.sweep", { pending: rows.length });
    for (const row of rows) notifier.push({ type: "message.created", ...row });
    await sweepPendingEvents();
  };
  const sweepPendingEvents = async () => {
    const queued = await pendingMailEventRows(db, 500);
    const unreadable: string[] = [];
    for (const row of queued) {
      const parsed = mailEventSchema.safeParse(row.event);
      if (parsed.success) notifier.push(parsed.data, row.id);
      else unreadable.push(row.id);
    }
    if (unreadable.length > 0) {
      log.error("notify.pending_unreadable", { events: unreadable.length });
      await deletePendingMailEvents(db, unreadable);
    }
  };
  let delivering: Promise<void> | null = null;
  let deliverAgain = false;
  const deliverPending = () => {
    if (delivering) {
      deliverAgain = true;
      return;
    }
    delivering = (async () => {
      do {
        deliverAgain = false;
        await sweepPendingEvents();
      } while (deliverAgain);
    })()
      .catch((error: unknown) => log.warn("notify.pending_failed", { error }))
      .finally(() => {
        delivering = null;
      });
  };
  const objects = createS3Store({
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    region: config.S3_REGION,
  });
  const store = new PgMailStore({
    db,
    onIngested: ({ folder: _folder, ...message }) =>
      notifier.push({ type: "message.created", ...message }),
    onPruned: deliverPending,
    onMerged: deliverPending,
    onChanged: deliverPending,
    onDiscarded: ({ threadIds, ...discarded }) => {
      for (let i = 0; i < threadIds.length; i += MAX_PRUNED_THREADS_PER_EVENT) {
        const chunk = threadIds.slice(i, i + MAX_PRUNED_THREADS_PER_EVENT);
        notifier.push({ type: "threads.discarded", ...discarded, threadIds: chunk });
      }
    },
    objects,
    links: { imageProxyUrl: config.IMAGE_PROXY_URL, attachmentUrl: config.ATTACHMENT_URL },
  });
  const supervisor = new Supervisor({
    store,
    files: new PgSendFiles({ db, objects }),
    forwarding: new PgForwarding({ db, objects }),
    actions: new PgActionSource({
      db,
      onFailed: deliverPending,
    }),
    logger: log,
    syncIntervalMs: config.SYNC_INTERVAL_MS,
    outboxIntervalMs: config.OUTBOX_INTERVAL_MS,
    concurrency: config.MAILBOX_CONCURRENCY,
  });

  const host = config.PURELYMAIL_API_TOKEN
    ? createPurelymailHost(createPurelymailClient(config.PURELYMAIL_API_TOKEN), log)
    : undefined;
  let rotateLogin: ReturnType<typeof createLoginRotation> | undefined;
  const disconnectDeps = {
    db,
    keyring: config.MAIL_CREDENTIALS_KEY,
    ...(host ? { host } : {}),
    stop: (mailboxId: string) => supervisor.retire(mailboxId),
    logger: log,
  };
  const credit = host
    ? createCreditWatch({
        host,
        warnBelowUsd: config.PURELYMAIL_CREDIT_WARN_USD ?? 5,
        logger: log,
      })
    : undefined;

  let reconciling: Promise<void> | null = null;
  let again = false;
  let stopping = false;
  const gmailSyncDays = config.GMAIL_SYNC_DAYS ?? 7;
  async function reconcileOnce() {
    if (stopping) return;
    await rehomeMailboxes({
      db,
      keyring: config.MAIL_CREDENTIALS_KEY,
      stop: (mailboxId) => supervisor.retire(mailboxId),
      logger: log,
    });
    const rows = await listServiceMailboxes(db);
    const wanted = new Set(rows.map((row) => row.id));
    for (const id of supervisor.mailboxIds()) {
      if (!wanted.has(id)) await supervisor.remove(id);
    }
    for (const row of rows) {
      if (stopping) return;
      if (supervisor.has(row.id)) continue;
      let credentials;
      let auth;
      try {
        credentials = await openCredentials(
          config.MAIL_CREDENTIALS_KEY,
          row.id,
          row.credentialsEnc,
        );
        auth = mailboxAuth(credentials, google);
      } catch (error) {
        log.error("mailbox.credentials_unreadable", { mailboxId: row.id, error });
        await setMailboxStatus(db, row.id, "error");
        continue;
      }
      const connection = supervisor.add({
        id: row.id,
        orgId: row.orgId,
        address: row.address,
        kind: row.kind,
        provider: row.provider,
        ...(row.provider === "gmail" && gmailSyncDays > 0
          ? { syncSince: new Date(row.createdAt.getTime() - gmailSyncDays * DAY_MS) }
          : {}),
        user: credentials.user,
        auth,
        imap: withPlaintextPolicy(credentials.imap, hosts),
        smtp: withPlaintextPolicy(credentials.smtp, hosts),
      });
      const setStatus = (status: "active" | "error") =>
        setMailboxStatus(db, row.id, status).catch((error: unknown) =>
          log.warn("mailbox.status_failed", { mailboxId: row.id, error }),
        );
      connection.on("connected", () => void setStatus("active"));
      connection.on("auth_failed", () => {
        void setStatus("error");
        if (row.provider === "purelymail") void rotateLogin?.rotate(row);
      });
    }
  }
  function reconcileMailboxes() {
    if (reconciling) {
      again = true;
      return reconciling;
    }
    reconciling = (async () => {
      do {
        again = false;
        await reconcileOnce();
      } while (again);
    })().finally(() => {
      reconciling = null;
    });
    return reconciling;
  }

  const reconnect = async (mailboxId: string) => {
    if (supervisor.has(mailboxId)) await supervisor.remove(mailboxId);
    await reconcileMailboxes();
  };
  if (host) {
    rotateLogin = createLoginRotation({
      db,
      keyring: config.MAIL_CREDENTIALS_KEY,
      host,
      reconnect,
      logger: log,
    });
  }

  supervisor.start();
  await sweepNotifications().catch((error: unknown) => log.error("notify.sweep_failed", { error }));
  const sweepLoop = every(config.NOTIFY_SWEEP_MS ?? 60_000, () =>
    sweepNotifications().catch((error: unknown) => log.error("notify.sweep_failed", { error })),
  );
  await reconcileMailboxes();
  const reconcileLoop = every(config.SYNC_INTERVAL_MS, () =>
    reconcileMailboxes().catch((error: unknown) =>
      log.error("mailbox.reconcile_failed", { error }),
    ),
  );

  void credit?.check();
  const creditLoop = credit ? every(60 * 60_000, () => credit.check()) : undefined;

  const provisioner = createProvisioner({
    db,
    keyring: config.MAIL_CREDENTIALS_KEY,
    ...(host ? { host } : {}),
    connect: reconnect,
    hosts,
    logger: log,
  });

  const httpLog = log.child({ component: "http" });
  const app = createApp({
    provisioner,
    ...(google
      ? {
          connectGoogle: (input) =>
            connectGoogle(
              {
                db,
                keyring: config.MAIL_CREDENTIALS_KEY,
                oauth: google,
                connect: reconnect,
                logger: log,
              },
              input,
            ),
          googleCalendarEvents: createGoogleCalendar({
            db,
            keyring: config.MAIL_CREDENTIALS_KEY,
            oauth: google,
            logger: log,
          }),
        }
      : {}),
    disconnectGoogle: (input) =>
      disconnectGoogle(
        {
          db,
          keyring: config.MAIL_CREDENTIALS_KEY,
          stop: (mailboxId) => supervisor.retire(mailboxId),
          logger: log,
        },
        input,
      ),
    disconnectHosted: (input) => disconnectHostedMailbox(disconnectDeps, input),
    disconnectMailbox: (input) => disconnectMailbox(disconnectDeps, input),
    log: httpLog,
    dns: createDnsLookup({
      resolvers: config.DNS_RESOLVERS ?? [],
      nameserverPort: config.DNS_NAMESERVER_PORT ?? 53,
      timeoutMs: config.DNS_TIMEOUT_MS ?? 2_000,
      logger: log,
    }),
    onError: (error) => httpLog.error("http.error", { error }),
    verify: hmacVerifier(config.MAIL_SERVICE_HMAC_SECRET, {
      onReject: (reason) => httpLog.warn("http.ping_rejected", { reason }),
    }),
    onPing: ({ requestId }) => {
      httpLog.info("outbox.pinged", { requestId });
      void reconcileMailboxes()
        .catch((error: unknown) => log.error("mailbox.reconcile_failed", { error }))
        .then(() => supervisor.ping());
    },
    health: async () => {
      const database = stopping ? false : await databaseAnswers();
      return {
        ok: !stopping && database,
        stopping,
        database,
        mailboxes: supervisor.mailboxCount,
        connected: supervisor.connectedCount,
        ready: supervisor.readyCount,
        ...(credit ? { hostCredit: credit.state() } : {}),
      };
    },
  });

  async function databaseAnswers() {
    let deadline: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        db.execute(sql`select 1`).then(() => true),
        new Promise<boolean>((resolve) => (deadline = setTimeout(() => resolve(false), 2_000))),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(deadline);
    }
  }

  return {
    app,
    supervisor,
    reconcileMailboxes,
    stop: async () => {
      stopping = true;
      rotateLogin?.stop();
      await Effect.runPromise(Fiber.interrupt(reconcileLoop));
      await Effect.runPromise(Fiber.interrupt(sweepLoop));
      if (creditLoop) await Effect.runPromise(Fiber.interrupt(creditLoop));
      await reconciling?.catch(() => {});
      await supervisor.stop();
      await notifier.stop();
      await close();
    },
  } satisfies MailService;
}
