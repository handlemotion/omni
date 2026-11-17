import { createDb } from "@omni/db";

export function openDb(env: Env, max = 2) {
  return createDb(env.HYPERDRIVE.connectionString, { max, fetch_types: false, onnotice: () => {} });
}
