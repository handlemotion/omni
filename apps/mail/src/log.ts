// One JSON line per event on stdout, for whatever log collector the host runs. Never log credentials or message bodies.

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(level: LogLevel = "info", base: Record<string, unknown> = {}): Logger {
  const write = (at: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (ORDER[at] < ORDER[level]) return;
    const line = { time: new Date().toISOString(), level: at, event, ...base, ...fields };
    process.stdout.write(`${JSON.stringify(line, replacer)}\n`);
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}
