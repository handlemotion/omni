import * as Sentry from "@sentry/cloudflare";
import { PRIVATE_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from "@omni/mail-core/telemetry";
import { createStripeClient } from "@omni/auth";
import { pruneAbandonedSignUps } from "./abandoned-sign-ups.ts";
import { app } from "./app.ts";
import { reconcileSubscriptions } from "./billing-reconcile.ts";
import { openDb } from "./db.ts";
import { recheckLocks } from "./domains.ts";
import { loadConfig } from "./env.ts";
import { createLogger } from "./log.ts";
import { consumeQueue, type AiJob } from "./queue.ts";

export type { AppType } from "./app.ts";
export { DomainWatch } from "./domain-watch.ts";
export { Realtime } from "./realtime.ts";
export { RateLimiter } from "./rate-limiter.ts";
export { ReplayGuard } from "./replay-guard.ts";

// Sentry stays off unless SENTRY_DSN is set. Events are scrubbed of mail content, addresses,
// credentials and query strings before they leave (`@omni/mail-core/telemetry`).
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN || undefined,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.ENVIRONMENT || "production",
    // No headers, cookies, bodies, query strings or user info; the scrubber is the second lock.
    dataCollection: PRIVATE_DATA_COLLECTION,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  }),
  {
    fetch: app.fetch,
    queue: consumeQueue,
    scheduled: (controller, env, ctx) =>
      ctx.waitUntil(
        controller.cron === DAILY_CRON ? scheduledDaily(env) : scheduledRecheck(env, ctx),
      ),
  } satisfies ExportedHandler<Env, AiJob>,
);

/** Must match the daily cron in wrangler.jsonc `triggers.crons`; any other cron re-checks domains. */
const DAILY_CRON = "47 3 * * *";

/**
 * The daily cron: billing reconcile and the abandoned sign-up sweep. Each runs even if the other
 * fails; the run still fails so the error is visible.
 */
async function scheduledDaily(env: Env) {
  const results = await Promise.allSettled([scheduledReconcile(env), scheduledPrune(env)]);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}

/** Deletes accounts that never joined or created a workspace and sat unused. Safe to run twice. */
async function scheduledPrune(env: Env) {
  const { db, close } = openDb(env);
  const log = createLogger({ component: "accounts", requestId: crypto.randomUUID() });
  try {
    const result = await pruneAbandonedSignUps({ db, bucket: env.MAIL_BUCKET, log });
    log.info("accounts.pruned", result);
  } finally {
    await close();
  }
}

/**
 * The daily billing cron: every workspace's subscriptions read back from Stripe (ADR 0015).
 * Nothing to do with billing off. Safe to run twice.
 */
async function scheduledReconcile(env: Env) {
  const billing = loadConfig(env).auth.billing;
  if (!billing) return;
  const { db, close } = openDb(env);
  const log = createLogger({ component: "billing", requestId: crypto.randomUUID() });
  try {
    const result = await reconcileSubscriptions({
      db,
      stripe: createStripeClient(billing.secretKey),
      billing,
      log,
    });
    log.info("billing.reconciled", { ...result });
  } finally {
    await close();
  }
}

/** The cron trigger: re-check every verified domain's challenge (ADR 0010). Safe to run twice. */
async function scheduledRecheck(env: Env, ctx: ExecutionContext) {
  const config = loadConfig(env);
  const { db, close } = openDb(env);
  const requestId = crypto.randomUUID();
  const log = createLogger({ component: "domains", requestId });
  try {
    const result = await recheckLocks({
      db,
      config,
      requestId,
      log,
      waitUntil: (p) => ctx.waitUntil(p),
    });
    log.info("domains.rechecked", result);
  } finally {
    await close();
  }
}
