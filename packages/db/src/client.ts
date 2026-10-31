import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

/** Any Drizzle Postgres database over our schema, whatever the driver. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * postgres-js client for Node (mail service, scripts, tests) and for Workers through
 * Hyperdrive's connection string. Call `close()` when a short-lived caller is done.
 */
export function createDb(url: string, options: postgres.Options<{}> = {}) {
  const client = postgres(url, options);
  const db = drizzle({ client, schema });
  return { db, close: () => client.end() };
}
