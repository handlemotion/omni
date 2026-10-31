import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createApp, rejectAll } from "./http.ts";
import { createLogger } from "./log.ts";
import type { Supervisor } from "./supervisor.ts";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);

// Storage (`@omni/db` + R2) and the mailbox list arrive in the next wave. Then this becomes
// `new Supervisor({ store, actions, logger: log, ... })`, `start()`, and one `add()` per mailbox.
const supervisor = null as Supervisor | null;

const app = createApp({
  verify: rejectAll,
  onPing: () => void supervisor?.ping(),
  health: () => ({
    mailboxes: supervisor?.mailboxCount ?? 0,
    connected: supervisor?.connectedCount ?? 0,
  }),
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) =>
  log.info("http.listening", { port: info.port }),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutdown.start", { signal });
  // Railway sends SIGKILL ~30s after SIGTERM; finish well inside that.
  const force = setTimeout(() => {
    log.error("shutdown.timeout");
    process.exit(1);
  }, 20_000);
  force.unref();
  server.close();
  await supervisor?.stop();
  log.info("shutdown.done");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
