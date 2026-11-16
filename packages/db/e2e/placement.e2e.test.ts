// Where a mailbox lives once a company claims its domain (ADR 0024 decision 2): the closest
// company lock decides, membership in that company is checked after, and a mailbox holding work
// only Postgres has (a draft, an unsent action) is reported busy so it is not moved yet.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { firstSyncDone, hasUnsyncedWork, listMisplacedMailboxes } from "../src/mail/placement.ts";
import {
  drafts,
  mailActions,
  mailboxFolders,
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

// Catches: a move deleting the old copy while the new one is still importing. A folder's first
// position (UIDNEXT 0) is saved, with `synced_at`, before any message is imported.
test("a copy has finished its first sync only when every folder completed an import", async () => {
  const { db } = database;
  const { box } = await personalMailbox(`dee-${randomUUID().slice(0, 8)}@gmail.test`);
  expect(await firstSyncDone(db, box.id)).toBe(false);
  const folder = (path: string) =>
    db
      .insert(mailboxFolders)
      .values({
        orgId: box.orgId,
        mailboxId: box.id,
        path,
        role: path === "INBOX" ? "inbox" : "other",
      })
      .returning();
  const [inbox] = await folder("INBOX");
  const [archive] = await folder("[Gmail]/All Mail");
  const position = (id: string, uidnext: number) =>
    db
      .update(mailboxFolders)
      .set({ uidvalidity: 1, uidnext, syncedAt: new Date() })
      .where(eq(mailboxFolders.id, id));

  // Both folders started (position saved, `synced_at` set), nothing imported yet.
  await position(inbox!.id, 0);
  await position(archive!.id, 0);
  expect(await firstSyncDone(db, box.id)).toBe(false);
  // INBOX done, All Mail still importing.
  await position(inbox!.id, 42);
  expect(await firstSyncDone(db, box.id)).toBe(false);
  await position(archive!.id, 900);
  expect(await firstSyncDone(db, box.id)).toBe(true);
});

// Catches: a company keeping someone's personal Gmail (ADR 0024 step 3), or the backfill pulling
// out a mailbox that is the company's: on its locked domain, or an IMAP mailbox with no claim.
test("a company's Gmail on an address no company locked goes to its owner's Personal space", async () => {
  const { db } = database;
  const tag = randomUUID().slice(0, 8);
  const company = await createOrg(db, `co-${tag}`);
  await db
    .insert(mailDomains)
    .values({ orgId: company.id, domain: `${tag}.test`, provider: "imap" });
  const owner = await createMember(db, company.id, "owner");
  const space = await createOrg(db, `personal-${tag}`);
  await db.insert(personalSpaces).values({ orgId: space.id, userId: owner.userId });
  const [personalMember] = await db
    .insert(members)
    .values({
      id: randomUUID(),
      organizationId: space.id,
      userId: owner.userId,
      createdAt: new Date(),
    })
    .returning();
  const box = async (address: string, provider: "gmail" | "imap") => {
    const [row] = await db
      .insert(mailboxes)
      .values({ orgId: company.id, address, kind: "personal", provider, credentialsEnc: "x" })
      .returning();
    await db
      .insert(mailboxAccess)
      .values({ orgId: company.id, mailboxId: row!.id, memberId: owner.id, role: "owner" });
    return row!;
  };
  const gmail = await box(`me-${tag}@gmail.test`, "gmail");
  const work = await box(`me@${tag}.test`, "gmail");
  const cli = await box(`ops-${tag}@unclaimed-${tag}.test`, "imap");

  const misplaced = await listMisplacedMailboxes(db);
  expect(misplaced.find((m) => m.id === gmail.id)).toMatchObject({
    orgId: company.id,
    targetOrgId: space.id,
    targetMemberId: personalMember!.id,
  });
  // Its domain is the company's own, and an IMAP mailbox is left alone.
  expect(misplaced.map((m) => m.id)).not.toContain(work.id);
  expect(misplaced.map((m) => m.id)).not.toContain(cli.id);
});
