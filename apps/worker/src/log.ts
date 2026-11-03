// One JSON line per event, which Workers Logs indexes field by field. Same shape as the mail
// service's (`apps/mail/src/log.ts`): `time`, `level`, `event`, then `component`, `requestId`,
// `orgId`, `durationMs` and ids. Never mail content, addresses or credentials.
import * as Sentry from "@sentry/cloudflare";
import { isValidRequestId } from "@omni/crypto";
import { scrubString } from "@omni/mail-core/telemetry";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  /** Also reports to Sentry (when on): `fields.error` as the exception, the rest as tags. */
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** What web and iOS send, and what every response carries back. */
export const REQUEST_ID_HEADER = "x-request-id";

/** The caller's request ID when it is well-formed, else a fresh one. Never echoes junk. */
export function requestIdFrom(value: string | null | undefined): string {
  return value && isValidRequestId(value) ? value : crypto.randomUUID();
}

const sink: Record<LogLevel, (line: string) => void> = {
  // oxlint-disable-next-line no-console -- the log sink
  debug: (line) => console.debug(line),
  // oxlint-disable-next-line no-console -- the log sink
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    const line = { time: new Date().toISOString(), level, event, ...base, ...fields };
    sink[level](JSON.stringify(line, replacer));
    if (level === "error") report(event, { ...base, ...fields });
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

/** No-op unless `withSentry` initialized a client (SENTRY_DSN set). */
function report(event: string, fields: Record<string, unknown>) {
  if (!Sentry.getClient()) return;
  const { error, ...rest } = fields;
  const tags: Record<string, string> = { event };
  for (const key of ["component", "requestId", "orgId", "queue"]) {
    if (typeof rest[key] === "string") tags[key] = rest[key];
  }
  if (error instanceof Error) Sentry.captureException(error, { tags });
  else Sentry.captureMessage(event, { level: "error", tags });
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  // Database and SMTP errors can quote bound values and recipients: scrubbed like Sentry events.
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  return value;
}
