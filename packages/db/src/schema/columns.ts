// Column helpers every schema file shares: UUIDv7 ids, the org and member keys, timestamps.
import { customType, text, timestamp } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { members, organizations } from "./auth.ts";

// Text ids holding a UUIDv7: time-ordered (index friendly) and generated in the app, so a row's
// id is known before the insert and can double as an idempotency handle.
export const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const orgId = () =>
  text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

export const memberId = () =>
  text("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" });

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const createdAt = () => timestamptz("created_at").notNull().defaultNow();
export const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
