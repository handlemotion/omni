import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { flushErrorReporting, initErrorReporting } from "./sentry.ts";
import { startService } from "./service.ts";

// A plain `.env` works for self-hosters; variables already set (Doppler, Docker) win over it.
if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
// Before anything can fail: Sentry (when SENTRY_DSN is set) sees every `log.error` line.
const report = initErrorReporting(config);
const log = createLogger(config.LOG_LEVEL, {}, { report });
log.info("service.starting", { errorReporting: report ? "sentry" : "off" });

// Loads every mailbox that is not disabled, decrypts its credentials, and resumes each folder
// from its saved sync position.
const service = await startService(config, log);

const server = serve({ fetch: service.app.fetch, port: config.PORT }, (info) =>
  log.info("http.listening", { port: info.port }),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutdown.start", { signal });
  // Container hosts usually SIGKILL 10-30s after SIGTERM; give in-flight work up to 20s.
  const force = setTimeout(() => {
    log.error("shutdown.timeout");
    void flushErrorReporting().finally(() => process.exit(1));
  }, 20_000);
  force.unref();
  // Stop accepting, and drop idle keep-alive sockets so `close` does not wait on them.
  server.close();
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  await service.stop();
  log.info("shutdown.done");
  await flushErrorReporting();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
