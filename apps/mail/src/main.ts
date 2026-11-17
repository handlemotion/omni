import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Effect, Option } from "effect";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { flushErrorReporting, initErrorReporting } from "./sentry.ts";
import { startService } from "./service.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const report = initErrorReporting(config);
const log = createLogger(config.LOG_LEVEL, {}, { report });
log.info("service.starting", { errorReporting: report ? "sentry" : "off" });

const service = await startService(config, log);

const server = serve({ fetch: service.app.fetch, port: config.PORT }, (info) =>
  log.info("http.listening", { port: info.port }),
);

const shutdown = (signal: string) =>
  Effect.gen(function* () {
    log.info("shutdown.start", { signal });
    server.close();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    const finished = yield* Effect.promise(() => service.stop()).pipe(
      Effect.timeoutOption("20 seconds"),
    );
    if (Option.isNone(finished)) {
      log.error("shutdown.timeout");
      return 1;
    }
    log.info("shutdown.done");
    return 0;
  });

let stopping = false;
function onSignal(signal: string) {
  if (stopping) return;
  stopping = true;
  void Effect.runPromise(shutdown(signal)).then(
    (code) => flushErrorReporting().finally(() => process.exit(code)),
    (error: unknown) => {
      log.error("shutdown.failed", { error });
      void flushErrorReporting().finally(() => process.exit(1));
    },
  );
}

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
