import * as Sentry from "@sentry/cloudflare";
import { app } from "./app.ts";

export type { AppType } from "./app.ts";

// Sentry stays off unless SENTRY_DSN is set.
export default Sentry.withSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN || undefined, enabled: Boolean(env.SENTRY_DSN) }),
  { fetch: app.fetch } satisfies ExportedHandler<Env>,
);
