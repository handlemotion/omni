// Each e2e file gets its own throwaway database, migrated from the committed migrations.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDb } from "../src/client.ts";
import { readDatabaseUrl } from "../src/env.ts";
import { mailboxAccess, mailboxes, members, organizations, users } from "../src/schema/index.ts";

export const migrationsFolder = join(import.meta.dirname, "../migrations");

const adminUrl = () => readDatabaseUrl(join(import.meta.dirname, ".."));

/** Creates an empty database and returns its URL plus a function that drops it. */
export async function createEmptyDatabase() {
  const name = `omni_e2e_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

/** A migrated database for one test file. Call `teardown` in `afterAll`. */
export async function createTestDatabase() {
  const empty = await createEmptyDatabase();
  const { db, close } = createDb(empty.url, { onnotice: () => {} });
  await migrate(db, { migrationsFolder });
  return {
    db,
    url: empty.url,
    teardown: async () => {
      await close();
      await empty.drop();
    },
  };
}

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>["db"];

export async function createOrg(db: TestDb, slug: string) {
  const [org] = await db
    .insert(organizations)
    .values({ id: randomUUID(), name: slug, slug, createdAt: new Date() })
    .returning();
  return org!;
}

export async function createMember(db: TestDb, orgId: string, name: string) {
  const [user] = await db
    .insert(users)
    .values({ id: randomUUID(), name, email: `${name}-${randomUUID()}@example.test` })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ id: randomUUID(), organizationId: orgId, userId: user!.id, createdAt: new Date() })
    .returning();
  return member!;
}

export async function createMailbox(db: TestDb, orgId: string, address: string) {
  const [mailbox] = await db
    .insert(mailboxes)
    .values({ orgId, address, kind: "shared", credentialsEnc: "not-a-real-ciphertext" })
    .returning();
  return mailbox!;
}

export async function grant(db: TestDb, orgId: string, mailboxId: string, memberId: string) {
  await db.insert(mailboxAccess).values({ orgId, mailboxId, memberId });
}
