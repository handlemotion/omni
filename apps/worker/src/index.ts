import * as Sentry from "@sentry/cloudflare";
import { createDb } from "@omni/db";
import { PRIVATE_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from "@omni/mail-core/telemetry";
import { app } from "./app.ts";
import { recheckLocks } from "./domains.ts";
import { loadConfig } from "./env.ts";
import { createLogger } from "./log.ts";
import { consumeQueue, type AiJob } from "./queue.ts";

export type { AppType } from "./app.ts";
export { DomainWatch } from "./domain-watch.ts";
export { Realtime } from "./realtime.ts";
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
    scheduled: (_controller, env, ctx) => ctx.waitUntil(scheduledRecheck(env, ctx)),
  } satisfies ExportedHandler<Env, AiJob>,
);

/** The cron trigger: re-check every verified domain's challenge (ADR 0010). Safe to run twice. */
async function scheduledRecheck(env: Env, ctx: ExecutionContext) {
  const config = loadConfig(env);
  const { db, close } = createDb(env.HYPERDRIVE.connectionString, { max: 2, fetch_types: false });
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
