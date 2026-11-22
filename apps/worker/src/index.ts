import * as Sentry from "@sentry/cloudflare";
import {
  capEvents,
  PRIVATE_DATA_COLLECTION,
  sampleTrace,
  scrubBreadcrumb,
  scrubEvent,
  scrubFields,
} from "@omni/mail-core/telemetry";
import { createStripeClient } from "@omni/auth";
import { Effect } from "effect";
import { pruneAbandonedSignUps } from "./abandoned-sign-ups.ts";
import { app } from "./app.ts";
import { isBuildAsset, serveBuildAsset } from "./build-assets.ts";
import { reconcileSubscriptions } from "./billing-reconcile.ts";
import { openDb } from "./db.ts";
import { recheckLocks } from "./domains.ts";
import { loadConfig } from "./env.ts";
import { attempt, runJob, scopedDb } from "./job-effects.ts";
import { createLogger } from "./log.ts";
import { modules } from "./modules.ts";
import { consumeQueue, type AiJob } from "./queue.ts";
import { consumeMeetingMessage } from "./meetings/queue.ts";
import { billStorage } from "./storage/billing.ts";

export type { AppType } from "./app.ts";
export { DomainWatch } from "./domain-watch.ts";
export { Realtime } from "./realtime.ts";
export { RateLimiter } from "./rate-limiter.ts";
export { ReplayGuard } from "./replay-guard.ts";

const capErrorsPerIsolate = capEvents();

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN || undefined,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.ENVIRONMENT || "production",
    release: env.CF_VERSION_METADATA.id,
    dataCollection: PRIVATE_DATA_COLLECTION,
    tracesSampler: sampleTrace,
    beforeSend: (event) => capErrorsPerIsolate(scrubEvent(event)),
    beforeSendSpan: (span) => scrubFields(span),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  }),
  {
    fetch: (request, env, ctx) =>
      isBuildAsset(request) ? serveBuildAsset(request, env.ASSETS) : app.fetch(request, env, ctx),
    queue: (batch, env) => consumeQueue(batch, env, { meeting: consumeMeetingMessage }),
    scheduled: (controller, env, ctx) =>
      ctx.waitUntil(
        controller.cron === MINUTE_CRON
          ? scheduledMinute(env)
          : controller.cron === DAILY_CRON
            ? scheduledDaily(env)
            : scheduledRecheck(env, ctx),
      ),
  } satisfies ExportedHandler<Env, AiJob>,
);

const DAILY_CRON = "47 3 * * *";
const MINUTE_CRON = "* * * * *";

async function scheduledMinute(env: Env) {
  await allSettled(modules.flatMap((module) => (module.minute ? [module.minute(env)] : [])));
}

async function scheduledDaily(env: Env) {
  await allSettled([
    scheduledReconcile(env),
    scheduledPrune(env),
    ...modules.flatMap((module) => (module.daily ? [module.daily(env)] : [])),
  ]);
}

async function allSettled(jobs: Promise<unknown>[]) {
  const results = await Promise.allSettled(jobs);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}

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

function scheduledReconcile(env: Env) {
  const billing = loadConfig(env).auth.billing;
  if (!billing) return Promise.resolve();
  const log = createLogger({ component: "billing", requestId: crypto.randomUUID() });
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const stripe = createStripeClient(billing.secretKey);
      const result = yield* attempt("reconcile", () =>
        reconcileSubscriptions({ db, stripe, billing, log }),
      );
      log.info("billing.reconciled", { ...result });
      const storage = yield* billStorage({ db, stripe, billing, log });
      if (storage) log.info("storage.billed", { ...storage });
    }),
  );
}

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
      email: env.EMAIL,
      waitUntil: (p) => ctx.waitUntil(p),
    });
    log.info("domains.rechecked", result);
  } finally {
    await close();
  }
}
