// Applies the database migrations (packages/db/migrations) before a new mail service version
// goes live: fly.toml's `release_command`, which stops the deploy when this fails. Same journal
// and `drizzle.__drizzle_migrations` table as `drizzle-kit migrate`, so the two can take turns.
//
//   MIGRATE_DATABASE_URL  a role that may change the schema (falls back to DATABASE_URL)
//   MIGRATIONS_DIR        defaults to ./migrations, where the image copies them
import { createDb } from "@omni/db";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATE_DATABASE_URL (or DATABASE_URL) is not set");
  process.exit(1);
}

const { db, close } = createDb(url, { max: 1, onnotice: () => {} });
try {
  await migrate(db, {
    migrationsFolder: process.env.MIGRATIONS_DIR ?? "migrations",
  });
  console.log(JSON.stringify({ level: "info", event: "db.migrated" }));
} finally {
  await close();
}
