// One JSON line per event on stdout, for whatever log collector the host runs. Never log credentials or message bodies.
//
// Every line has `time`, `level` and `event`; children add `component`, `requestId`, `orgId`,
// ids and `durationMs`. The Worker writes the same shape (`apps/worker/src/log.ts`), so one
// request ID finds its lines in both.

import { scrubString } from "@omni/mail-core/telemetry";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** Where lines go. Defaults to stdout. */
  write?(line: string): void;
  /** Called for every `error` line with its event and fields (error tracking, e.g. Sentry). */
  report?(event: string, fields: Record<string, unknown>): void;
}

export function createLogger(
  level: LogLevel = "info",
  base: Record<string, unknown> = {},
  options: LoggerOptions = {},
): Logger {
  const sink = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const write = (at: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (at === "error") options.report?.(event, { ...base, ...fields });
    if (ORDER[at] < ORDER[level]) return;
    const line = { time: new Date().toISOString(), level: at, event, ...base, ...fields };
    sink(JSON.stringify(line, replacer));
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }, options),
  };
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    // `code` (ECONNRESET, ETIMEOUT, ...) tells a network fault from a server refusal at a glance.
    // Nothing else: ImapFlow and Nodemailer errors can carry the server's full response. The
    // message is scrubbed like a Sentry event: no addresses, query strings or database params.
    const { code } = value as { code?: unknown };
    return {
      name: value.name,
      message: scrubString(value.message),
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return value;
}
