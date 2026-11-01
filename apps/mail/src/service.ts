// Assembles the mail service: Postgres storage, one supervised connection per mailbox, HTTP.
// `main.ts` runs it as a process; e2e suites run it in-process against the real local stack.
import { createDb, listServiceMailboxes, setMailboxStatus } from "@omni/db";
import type { Hono } from "hono";
import type { Config } from "./config.ts";
import { openCredentials } from "./credentials.ts";
import { createApp, type RequestVerifier, rejectAll } from "./http.ts";
import type { Logger } from "./log.ts";
import { createS3Store } from "./objects.ts";
import { PgActionSource, PgMailStore } from "./pg-store.ts";
import { Supervisor } from "./supervisor.ts";

export type ServiceConfig = Pick<
  Config,
  | "DATABASE_URL"
  | "MAIL_CREDENTIALS_KEY"
  | "SYNC_INTERVAL_MS"
  | "OUTBOX_INTERVAL_MS"
  | "MAILBOX_CONCURRENCY"
  | "S3_ENDPOINT"
  | "S3_BUCKET"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY"
  | "S3_REGION"
  | "IMAGE_PROXY_URL"
  | "ATTACHMENT_URL"
>;

export interface MailService {
  app: Hono;
  supervisor: Supervisor;
  /** Connects mailboxes added since the last call and drops disabled or deleted ones. */
  reconcileMailboxes(): Promise<void>;
  stop(): Promise<void>;
}

export async function startService(
  config: ServiceConfig,
  log: Logger,
  verify: RequestVerifier = rejectAll,
): Promise<MailService> {
  const { db, close } = createDb(config.DATABASE_URL);
  const store = new PgMailStore({
    db,
    objects: createS3Store({
      endpoint: config.S3_ENDPOINT,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      region: config.S3_REGION,
    }),
    links: { imageProxyUrl: config.IMAGE_PROXY_URL, attachmentUrl: config.ATTACHMENT_URL },
  });
  const supervisor = new Supervisor({
    store,
    actions: new PgActionSource({ db }),
    logger: log,
    syncIntervalMs: config.SYNC_INTERVAL_MS,
    outboxIntervalMs: config.OUTBOX_INTERVAL_MS,
    concurrency: config.MAILBOX_CONCURRENCY,
  });

  // One reconcile at a time; a request during one runs once more after it.
  let reconciling: Promise<void> | null = null;
  let again = false;
  async function reconcileOnce() {
    const rows = await listServiceMailboxes(db);
    const wanted = new Set(rows.map((row) => row.id));
    for (const id of supervisor.mailboxIds()) {
      if (!wanted.has(id)) await supervisor.remove(id);
    }
    for (const row of rows) {
      if (supervisor.has(row.id)) continue;
      let credentials;
      try {
        credentials = await openCredentials(
          config.MAIL_CREDENTIALS_KEY,
          row.id,
          row.credentialsEnc,
        );
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
        ...credentials,
      });
      connection.on("connected", () => {
        setMailboxStatus(db, row.id, "active").catch((error: unknown) =>
          log.warn("mailbox.status_failed", { mailboxId: row.id, error }),
        );
      });
    }
  }
  function reconcileMailboxes(): Promise<void> {
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

  supervisor.start();
  await reconcileMailboxes();
  const timer = setInterval(
    () =>
      void reconcileMailboxes().catch((error: unknown) =>
        log.error("mailbox.reconcile_failed", { error }),
      ),
    config.SYNC_INTERVAL_MS,
  );

  const app = createApp({
    verify,
    onPing: () => {
      // A ping means the Worker changed something: new actions, or a mailbox added.
      void reconcileMailboxes()
        .catch((error: unknown) => log.error("mailbox.reconcile_failed", { error }))
        .then(() => supervisor.ping());
    },
    health: () => ({
      mailboxes: supervisor.mailboxCount,
      connected: supervisor.connectedCount,
    }),
  });

  return {
    app,
    supervisor,
    reconcileMailboxes,
    stop: async () => {
      clearInterval(timer);
      await reconciling?.catch(() => {});
      await supervisor.stop();
      await close();
    },
  };
}
