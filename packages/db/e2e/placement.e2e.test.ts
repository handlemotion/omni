// Where a mailbox lives once a company claims its domain (ADR 0024 decision 2): the closest
// company lock decides, membership in that company is checked after, and a mailbox holding work
// only Postgres has (a draft, an unsent action) is reported busy so it is not moved yet.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { hasUnsyncedWork, listMisplacedMailboxes } from "../src/placement.ts";
import {
  drafts,
  mailActions,
  mailboxAccess,
  mailboxes,
  mailDomains,
  members,
  personalSpaces,
} from "../src/schema/index.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(() => database?.teardown());

/** A mailbox at `address` in a fresh Personal space; its owner's user id comes back with it. */
async function personalMailbox(address: string) {
  const { db } = database;
  const space = await createOrg(db, `personal-${randomUUID()}`);
  const owner = await createMember(db, space.id, "owner");
  await db.insert(personalSpaces).values({ orgId: space.id, userId: owner.userId });
  const [box] = await db
    .insert(mailboxes)
    .values({ orgId: space.id, address, kind: "personal", provider: "gmail", credentialsEnc: "x" })
    .returning();
  await db
    .insert(mailboxAccess)
    .values({ orgId: space.id, mailboxId: box!.id, memberId: owner.id, role: "owner" });
  return { box: box!, userId: owner.userId };
}

/** A company locking `domain`, with `userIds` as its members. */
async function company(domain: string, ...userIds: string[]) {
  const { db } = database;
  const org = await createOrg(db, `co-${randomUUID()}`);
  await db.insert(mailDomains).values({ orgId: org.id, domain, provider: "imap" });
  const memberIds: string[] = [];
  for (const userId of userIds) {
    const [member] = await db
      .insert(members)
      .values({ id: randomUUID(), organizationId: org.id, userId, createdAt: new Date() })
      .returning();
    memberIds.push(member!.id);
  }
  return { orgId: org.id, memberIds };
}

test("the closest company lock decides; a member of a parent's company does not take a subdomain", async () => {
  const tag = randomUUID().slice(0, 8);
  const ana = await personalMailbox(`ana@team.${tag}.test`);
  const bo = await personalMailbox(`bo@${tag}.test`);
  // A locks the subdomain and Ana is not in it; B locks the parent and both are in it.
  await company(`team.${tag}.test`);
  const b = await company(`${tag}.test`, ana.userId, bo.userId);

  const misplaced = await listMisplacedMailboxes(database.db);
  // Ana's address is A's: she stays in her Personal space until she joins A.
  expect(misplaced.map((m) => m.id)).not.toContain(ana.box.id);
  // Bo's address is B's, and he is B's member.
  expect(misplaced.find((m) => m.id === bo.box.id)).toMatchObject({
    targetOrgId: b.orgId,
    targetMemberId: b.memberIds[1],
  });
});

test("a draft or an unfinished action keeps a mailbox busy; a finished action does not", async () => {
  const { db } = database;
  const { box } = await personalMailbox(`cara-${randomUUID().slice(0, 8)}@gmail.test`);
  expect(await hasUnsyncedWork(db, box.id)).toBe(false);

  const [draft] = await db
    .insert(drafts)
    .values({ orgId: box.orgId, mailboxId: box.id, kind: "new", subject: "unsent" })
    .returning();
  expect(await hasUnsyncedWork(db, box.id)).toBe(true);
  await db.delete(drafts).where(eq(drafts.id, draft!.id));

  const action = (status: "pending" | "done") =>
    db
      .insert(mailActions)
      .values({
        orgId: box.orgId,
        mailboxId: box.id,
        kind: "archive",
        payload: {},
        idempotencyKey: randomUUID(),
        status,
      })
      .returning();
  await action("done");
  expect(await hasUnsyncedWork(db, box.id)).toBe(false);
  await action("pending");
  expect(await hasUnsyncedWork(db, box.id)).toBe(true);
});
