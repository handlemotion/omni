import * as Sentry from "@sentry/cloudflare";
import { PRIVATE_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from "@omni/mail-core/telemetry";
import { app } from "./app.ts";
import { consumeQueue, type AiJob } from "./queue.ts";

export type { AppType } from "./app.ts";
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
  { fetch: app.fetch, queue: consumeQueue } satisfies ExportedHandler<Env, AiJob>,
);
