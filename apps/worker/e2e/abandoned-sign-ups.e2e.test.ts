import { randomUUID } from "node:crypto";
import { ensurePersonalSpace, forMember, schema } from "@omni/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  startMailServiceEndpoint,
  startWorker,
} from "./support.ts";

const DAILY_CRON = "47 3 * * *";
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

async function bucket() {
  const env = await worker.server
    .getWorker<{
      MAIL_BUCKET: {
        put(key: string, body: string): Promise<unknown>;
        head(key: string): Promise<unknown>;
      };
    }>()
    .getEnv();
  return env.MAIL_BUCKET;
}

async function signUp(name: string, createdDaysAgo: number) {
  const id = randomUUID();
  const email = `${name}-${id}@people.test`;
  await database.db.insert(schema.users).values({
    id,
    name,
    email,
    emailVerified: true,
    createdAt: daysAgo(createdDaysAgo),
    updatedAt: daysAgo(createdDaysAgo),
  });
  return { id, email };
}

async function session(userId: string, lastUsedDaysAgo: number) {
  await database.db.insert(schema.sessions).values({
    id: randomUUID(),
    token: randomUUID(),
    userId,
    expiresAt: inDays(30),
    createdAt: daysAgo(lastUsedDaysAgo),
    updatedAt: daysAgo(lastUsedDaysAgo),
  });
}

async function invite(orgId: string, inviterId: string, email: string, expiresAt: Date) {
  await database.db.insert(schema.invitations).values({
    id: randomUUID(),
    organizationId: orgId,
    email: email.toUpperCase(),
    role: "member",
    status: "pending",
    expiresAt,
    inviterId,
  });
}

async function remaining(ids: string[]) {
  const rows = await database.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return new Set(rows.map((r) => r.id));
}

async function runDaily() {
  const result = await worker.server.getWorker().scheduled({ cron: DAILY_CRON });
  expect(result.outcome).toBe("ok");
}

test("the daily cron deletes only accounts with no workspace, no way into one, and no recent use", async () => {
  const org = await createOrg(database.db, "sweep");
  const owner = await createMember(database.db, org.id, `owner-${randomUUID()}@sweep.test`);
  const r2 = await bucket();

  const gone = await signUp("gone", 45);
  await invite(org.id, owner.userId, gone.email, daysAgo(38));
  await session(gone.id, 44);
  const pictureKey = `pictures/users/${gone.id}/${"a".repeat(64)}`;
  await r2.put(pictureKey, "png");
  await database.db
    .update(schema.users)
    .set({ image: `/api/pictures/users/${gone.id}/${"a".repeat(64)}` })
    .where(eq(schema.users.id, gone.id));
  await database.db
    .insert(schema.userEmails)
    .values({ userId: gone.id, email: `extra-${gone.id}@people.test`, verifiedAt: daysAgo(44) });

  const fresh = await signUp("fresh", 3);
  const active = await signUp("active", 90);
  await session(active.id, 2);
  const member = await createMember(database.db, org.id, `member-${randomUUID()}@sweep.test`);
  await database.db
    .update(schema.users)
    .set({ createdAt: daysAgo(400) })
    .where(eq(schema.users.id, member.userId));
  const invited = await signUp("invited", 60);
  await invite(org.id, owner.userId, invited.email, inDays(2));
  const invitedElsewhere = await signUp("invited-elsewhere", 60);
  const extra = `work-${invitedElsewhere.id}@people.test`;
  await database.db
    .insert(schema.userEmails)
    .values({ userId: invitedElsewhere.id, email: extra, verifiedAt: daysAgo(50) });
  await invite(org.id, owner.userId, extra, inDays(2));
  const inviter = await signUp("former-owner", 120);
  await invite(org.id, inviter.id, `someone-${randomUUID()}@people.test`, inDays(2));

  const everyone = [
    gone.id,
    fresh.id,
    active.id,
    member.userId,
    invited.id,
    invitedElsewhere.id,
    inviter.id,
  ];
  await runDaily();

  const left = await remaining(everyone);
  expect(left.has(gone.id)).toBe(false);
  expect([...left].toSorted()).toEqual(everyone.filter((id) => id !== gone.id).toSorted());
  expect(
    await database.db.select().from(schema.sessions).where(eq(schema.sessions.userId, gone.id)),
  ).toEqual([]);
  expect(
    await database.db.select().from(schema.userEmails).where(eq(schema.userEmails.userId, gone.id)),
  ).toEqual([]);
  expect(await r2.head(pictureKey)).toBeNull();

  await runDaily();
  expect(await remaining(everyone)).toEqual(left);
});

test("an abandoned account's empty Personal space goes with it; one holding mail or a file keeps its owner", async () => {
  const { db } = database;
  const gone = await signUp("personal-gone", 45);
  const goneSpace = await ensurePersonalSpace(db, gone.id);
  const kept = await signUp("personal-kept", 45);
  const keptSpace = await ensurePersonalSpace(db, kept.id);
  await createMailbox(db, keptSpace, `kept-${kept.id}@gmail.test`, "personal");
  const files = await signUp("personal-files", 45);
  const filesSpace = await ensurePersonalSpace(db, files.id);
  const [member] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(eq(schema.members.organizationId, filesSpace));
  const folder = await forMember(db, member!.id).storage.createFolder({ space: "personal" }, "Tax");
  expect(folder.status).toBe("ok");

  await runDaily();

  expect(await remaining([gone.id, kept.id, files.id])).toEqual(new Set([kept.id, files.id]));
  const spaces = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(inArray(schema.organizations.id, [goneSpace, keptSpace, filesSpace]));
  expect(spaces.map((space) => space.id).toSorted()).toEqual([keptSpace, filesSpace].toSorted());
});
