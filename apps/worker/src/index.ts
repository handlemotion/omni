import * as Sentry from "@sentry/cloudflare";
import { app } from "./app.ts";
import { consumeAiQueue, type AiJob } from "./queue.ts";

export type { AppType } from "./app.ts";
export { Realtime } from "./realtime.ts";
export { ReplayGuard } from "./replay-guard.ts";

// Sentry stays off unless SENTRY_DSN is set.
export default Sentry.withSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN || undefined, enabled: Boolean(env.SENTRY_DSN) }),
  { fetch: app.fetch, queue: consumeAiQueue } satisfies ExportedHandler<Env, AiJob>,
);
