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
) {
  const sink = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const write = (at: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (at === "error") options.report?.(event, { ...base, ...fields });
    if (ORDER[at] < ORDER[level]) return;
    const line = { time: new Date().toISOString(), level: at, event, ...base, ...fields };
    sink(JSON.stringify(line, replacer));
  };
  const logger: Logger = {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }, options),
  };
  return logger;
}

const replacer: (_key: string, value: unknown) => unknown = (_key, value) => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    const { code } = value as { code?: unknown };
    return {
      name: value.name,
      message: scrubString(value.message),
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return value;
};
