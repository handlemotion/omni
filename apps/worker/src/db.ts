// How the Worker opens Postgres. A Worker may not reuse a socket across requests, so each
// request, queue batch, alarm and cron run opens its own small pool over Hyperdrive (which keeps
// the real connections warm) and closes it when done.
import { createDb } from "@omni/db";

export function openDb(env: Env, max = 2) {
  return createDb(env.HYPERDRIVE.connectionString, { max, fetch_types: false, onnotice: () => {} });
}
