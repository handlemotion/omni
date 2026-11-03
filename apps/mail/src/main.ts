import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Effect, Option } from "effect";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { startService } from "./service.ts";

// A plain `.env` works for self-hosters; variables already set (Doppler, Docker) win over it.
if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);

// Loads every mailbox that is not disabled, decrypts its credentials, and resumes each folder
// from its saved sync position.
const service = await startService(config, log);

const server = serve({ fetch: service.app.fetch, port: config.PORT }, (info) =>
  log.info("http.listening", { port: info.port }),
);

/**
 * Stop accepting HTTP, then stop the service in order: periodic loops, outbox claims, actions in
 * flight (a send finishes and records its outcome), then every mailbox fiber, whose scope logs out
 * and closes its socket. Container hosts SIGKILL some seconds after SIGTERM (Fly: `kill_timeout`,
 * 30s), so all of it gets 20s; past that the process exits 1 and the next start resumes.
 */
const shutdown = (signal: string) =>
  Effect.gen(function* () {
    log.info("shutdown.start", { signal });
    // Drop idle keep-alive sockets so `close` does not wait on them.
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
    (code) => process.exit(code),
    (error: unknown) => {
      log.error("shutdown.failed", { error });
      process.exit(1);
    },
  );
}

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
