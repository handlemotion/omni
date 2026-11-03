// Error reporting for the mail service: Sentry when SENTRY_DSN is set, nothing otherwise.
// Errors only (no tracing). The SDK collects no headers, cookies, bodies, query strings or user
// info (`PRIVATE_DATA_COLLECTION`), and every event and breadcrumb is scrubbed of mail content,
// addresses and credentials before it leaves (`@omni/mail-core/telemetry`). Local variables stay
// off: an IMAP or SMTP frame can hold a password or a message.
import * as Sentry from "@sentry/node";
import {
  PRIVATE_DATA_COLLECTION,
  scrubBreadcrumb,
  scrubEvent,
  scrubFields,
} from "@omni/mail-core/telemetry";
import type { Config } from "./config.ts";
import type { LoggerOptions } from "./log.ts";

/** Starts Sentry when configured; returns the logger hook that reports `error` lines. */
export function initErrorReporting(
  config: Pick<Config, "SENTRY_DSN" | "SENTRY_ENVIRONMENT">,
): LoggerOptions["report"] {
  if (!config.SENTRY_DSN) return undefined;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT,
    includeLocalVariables: false,
    dataCollection: PRIVATE_DATA_COLLECTION,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
  return (event, fields) => {
    const { error, ...rest } = fields;
    const tags: Record<string, string> = { event };
    for (const key of ["component", "requestId", "orgId", "mailboxId", "actionId"]) {
      if (typeof rest[key] === "string") tags[key] = rest[key];
    }
    const context = { tags, extra: scrubFields(rest) };
    if (error instanceof Error) Sentry.captureException(error, context);
    else Sentry.captureMessage(event, { level: "error", ...context });
  };
}

/** Sends what is queued before the process exits. */
export async function flushErrorReporting(timeoutMs = 2_000): Promise<void> {
  if (Sentry.getClient()) await Sentry.flush(timeoutMs);
}
